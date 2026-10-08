#!/usr/bin/env node
import { readFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fail, exists, validateRunId, initDirectory, resolveEval, writePrivate, atomicJson, appendRow, readJson, privatePath, loadEval, loadRun, validateExecution, executionFromControl, validateVerdicts, validateJudge, assertJson } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workers = new Set();
function stopWorker(child) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }
process.once('exit', () => { for (const child of workers) stopWorker(child); });
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { for (const child of workers) stopWorker(child); process.exit(code); });
function options(argv) {
  const [command, ...words] = argv, result = { command };
  const allowed = { init: ['name','mode','demo'], validate: ['eval'], run: ['eval','run','model'], grade: ['eval','run'], regrade: ['eval','from','run'], report: ['eval','run'], review: ['eval'] }[command];
  if (!allowed) fail('Commands: init, validate, run, grade, regrade, report, review.');
  for (let i = 0; i < words.length; i++) {
    const key = words[i].replace(/^--/, '');
    if (!words[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(result, key)) fail(`Unknown or repeated option: ${words[i]}`);
    if (key === 'demo') result[key] = true;
    else { const value = words[++i]; if (!value || value.startsWith('--')) fail(`Supply --${key}.`); result[key] = value; }
  }
  return result;
}
function operation(message, timeoutMs) {
  return new Promise(resolve => {
    const child = fork(path.join(here, 'worker.mjs'), [], { stdio: ['ignore','ignore','ignore','ipc'], detached: process.platform !== 'win32', serialization: 'advanced', execArgv: [] });
    workers.add(child);
    let finished = false;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); stopWorker(child); workers.delete(child); resolve(value); };
    const timer = setTimeout(() => finish({ ok: false, error: { code: 'TIMEOUT', message: `Operation exceeded ${timeoutMs} ms; the worker was terminated. External effects may need reconciliation.` } }), timeoutMs);
    child.once('message', finish);
    child.once('error', error => finish({ ok: false, error: { code: 'WORKER_ERROR', message: error.message } }));
    child.once('exit', (code, signal) => finish({ ok: false, error: { code: 'WORKER_EXIT', message: `Worker exited without a result (${code ?? signal}).` } }));
    child.send(message);
  });
}
async function init(args) {
  if (!['low','medium'].includes(args.mode)) fail('Supply --mode low or medium.');
  const directory = await initDirectory(args.name), prefix = args.demo ? 'demo-' : '';
  const manifest = JSON.parse(await readFile(path.join(here, '../templates', `${prefix}eval.json`), 'utf8'));
  manifest.name = args.name; manifest.mode = args.mode;
  await atomicJson(path.join(directory, 'manifest.json'), manifest);
  for (const file of ['adapter.mjs','grader.mjs','cases.jsonl','controls.jsonl','eval.md']) await writePrivate(path.join(directory, file), await readFile(path.join(here, '../templates', `${prefix}${file}`)), true);
  return { directory, mode: args.mode, demo: args.demo === true, next: 'Review the inputs, requirements and adapter; then validate.' };
}
const problem = error => ({ message: String(error?.message ?? error), code: String(error?.code ?? 'INVALID_RESULT') });
async function gradeOutput(evidence, item, execution) {
  const response = await operation({ kind: 'grade', module: path.resolve(evidence.directory, evidence.manifest.grader), case: item, execution }, evidence.manifest.settings.timeoutMs);
  if (!response.ok) return { error: response.error };
  let judge;
  try { if (response.value?.judge !== undefined) { assertJson(response.value.judge); validateJudge(response.value.judge); judge = response.value.judge; } }
  catch (error) { return { error: problem(error) }; }
  try { return { verdicts: validateVerdicts(response.value, evidence.manifest), ...(judge ? { judge } : {}) }; }
  catch (error) { return { error: problem(error), ...(judge ? { judge } : {}) }; }
}
async function validate(evidence) {
  const { directory, manifest, cases, controls, fingerprint } = evidence, results = [], coverage = Object.fromEntries(manifest.criteria.filter(item => item.required && item.grading !== 'human').map(item => [item.id, { pass: 0, fail: 0 }]));
  for (const control of controls) {
    const graded = await gradeOutput(evidence, cases.find(item => item.id === control.caseId), executionFromControl(control));
    const matched = !graded.error && Object.entries(control.expectedVerdicts).every(([id, expected]) => graded.verdicts[id].status === expected);
    if (matched) for (const [id, expected] of Object.entries(control.expectedVerdicts)) if (coverage[id] && ['pass','fail'].includes(expected)) coverage[id][expected]++;
    results.push({ id: control.id, caseId: control.caseId, passed: Boolean(matched), expectedVerdicts: control.expectedVerdicts, ...graded });
  }
  if ((await loadEval(directory)).fingerprint !== fingerprint) fail('Eval changed during validation. Preserve results and validate the final files.');
  const passed = cases.length > 0 && controls.length > 0 && results.every(item => item.passed) && Object.values(coverage).every(item => item.pass > 0 && item.fail > 0);
  const report = { schemaVersion: 1, fingerprint, checkedAt: new Date().toISOString(), passed, coverage, humanCriteria: manifest.criteria.filter(item => item.grading === 'human').map(item => item.id), controls: results, limitations: ['Controls test the declared grader behavior, not human agreement or population validity.', 'Human criteria only validate unscored machine wiring; their quality judgments remain pending separate human review.'] };
  await atomicJson(path.join(directory, 'validation.json'), report);
  return report;
}
async function requireValidation(evidence) {
  const file = path.join(evidence.directory, 'validation.json'); await privatePath(file);
  if (!(await exists(file))) fail('Run validate before executing or grading a suite.');
  const report = await readJson(file);
  if (report.schemaVersion !== 1 || report.fingerprint !== evidence.fingerprint || report.passed !== true) fail('Passing validation for the exact current eval fingerprint is required.');
}
function executionFrom(row) { return Object.fromEntries(['output','trace','metrics','receipt'].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])); }
async function runSuite(evidence, args) {
  await requireValidation(evidence); validateRunId(args.run);
  if (args.model !== undefined && (typeof args.model !== 'string' || !args.model.trim())) fail('Supply a nonempty --model identifier.');
  const kind = args.command === 'run' ? 'fresh' : args.command === 'grade' ? 'historical' : 'regrade';
  const source = kind === 'regrade' ? await loadRun(evidence.directory, args.from) : null;
  if (source && ['source','organizationId','projectId','workloadId','name'].some(field => source.run.manifest.workload[field] !== evidence.manifest.workload[field])) fail('Regrade requires the same workload identity as the source run. Create a separate eval for a different workload.');
  const sourceEvidenceDigest = source ? createHash('sha256').update(JSON.stringify([source.run, source.cases, source.rows, source.executions])).digest('hex') : undefined;
  const cases = source ? source.cases.map(prior => {
    const current = evidence.cases.find(item => item.id === prior.id);
    if (!current || current.title !== prior.title || JSON.stringify(current.input) !== JSON.stringify(prior.input)) fail('Regrade requires every original case with unchanged title and model input. Expectations and graders may be revised after validation.');
    return current;
  }) : evidence.cases;
  const repetitions = source?.run.repetitions ?? (kind === 'historical' ? 1 : evidence.manifest.settings.repetitions);
  if (!cases.length) fail('Add cases before running the suite.');
  const directory = path.join(evidence.directory, 'results', args.run), metadata = path.join(directory, 'run.json'), pending = path.join(directory, 'pending.json');
  await privatePath(path.join(directory, '.lock'), true);
  const lock = await open(path.join(directory, '.lock'), 'wx', 0o600).catch(() => fail('This run is locked. Inspect a stopped process and its pending evidence before removing a stale lock.'));
  try {
    if (await exists(pending)) fail('An attempt has an uncertain pending outcome. Reconcile its evidence; do not automatically resend it.');
    let run, rows;
    if (await exists(metadata)) {
      const saved = await loadRun(evidence.directory, args.run); run = saved.run; rows = saved.rows;
      if (run.fingerprint !== evidence.fingerprint || run.kind !== kind || run.sourceRun !== source?.run.id || run.sourceEvidenceDigest !== sourceEvidenceDigest || run.requestedModel !== (source?.run.requestedModel ?? args.model) || JSON.stringify(saved.cases) !== JSON.stringify(cases) || run.repetitions !== repetitions) fail('This run belongs to different inputs, model, or settings. Use a new run ID.');
    } else {
      const requestedModel = source?.run.requestedModel ?? args.model;
      run = { schemaVersion: 1, id: args.run, kind, manifest: evidence.manifest, startedAt: new Date().toISOString(), fingerprint: evidence.fingerprint, plannedCases: cases.length, plannedAttempts: cases.length * repetitions, repetitions, ...(requestedModel !== undefined ? { requestedModel } : {}), ...(source ? { sourceRun: source.run.id, sourceEvidenceDigest } : {}) };
      await atomicJson(metadata, run); await writePrivate(path.join(directory, 'cases.jsonl'), cases.map(item => JSON.stringify(item)).join('\n') + '\n', true); await writePrivate(path.join(directory, 'results.jsonl'), '', true); await writePrivate(path.join(directory, 'executions.jsonl'), '', true); rows = [];
    }
    const completed = new Set(rows.map(row => `${row.caseId}:${row.repetition}`));
    for (const item of cases) for (let repetition = 1; repetition <= repetitions; repetition++) {
      if (completed.has(`${item.id}:${repetition}`)) continue;
      if ((await loadEval(evidence.directory)).fingerprint !== evidence.fingerprint) fail('Eval files changed during execution. Use a new run after validation.');
      const row = { schemaVersion: 1, caseId: item.id, repetition, status: 'ok' }; let execution;
      await atomicJson(pending, { schemaVersion: 1, caseId: item.id, repetition, kind, startedAt: new Date().toISOString() });
      try {
        if (kind === 'fresh') {
          const started = performance.now();
          const response = await operation({ kind: 'execute', module: path.resolve(evidence.directory, evidence.manifest.adapter), case: { id: item.id, title: item.title, input: item.input }, context: { runId: args.run, repetition, workload: evidence.manifest.workload, ...(args.model !== undefined ? { model: args.model } : {}) } }, evidence.manifest.settings.timeoutMs);
          if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
          execution = validateExecution(response.value);
          execution.metrics = { costUsd: null, judgeCostUsd: null, ...execution.metrics, latencyMs: execution.metrics?.latencyMs ?? performance.now() - started };
        } else if (kind === 'historical') {
          if (!item.observed) fail('No historical output was supplied for this case.', 'MISSING_OUTPUT'); execution = item.observed;
        } else {
          const prior = source.rows.find(value => value.caseId === item.id && value.repetition === repetition) ?? source.executions.find(value => value.caseId === item.id && value.repetition === repetition);
          if (!prior) fail('The source attempt has no recorded output; an unfinished source may require reconciliation.', 'MISSING_OUTPUT');
          if (!Object.hasOwn(prior, 'output')) {
            Object.assign(row, prior); delete row.judge; delete row.verdicts;
            row.metrics = { costUsd: null, ...prior.metrics, judgeCostUsd: null }; execution = null;
          } else execution = executionFrom(prior);
        }
        if (execution) {
          execution = { ...execution, metrics: { costUsd: null, ...execution.metrics, judgeCostUsd: null } };
          Object.assign(row, execution);
          await appendRow(path.join(directory, 'executions.jsonl'), row);
          await atomicJson(pending, { schemaVersion: 1, caseId: item.id, repetition, kind, stage: 'grading', executionSaved: true });
          const grade = await gradeOutput(evidence, item, execution);
          if (grade.error) Object.assign(row, { status: 'grader_error', error: grade.error });
          else row.verdicts = grade.verdicts;
          if (grade.judge) row.judge = grade.judge;
          row.metrics.judgeCostUsd = grade.judge?.costUsd ?? null;
        }
      } catch (error) {
        row.status = error.code === 'ENVIRONMENT_GAP' ? 'environment_gap' : error.code === 'TIMEOUT' ? 'timeout' : error.code === 'MISSING_OUTPUT' ? 'missing_output' : 'execution_error'; row.error = problem(error);
      }
      await appendRow(path.join(directory, 'results.jsonl'), row); rows.push(row); await rm(pending);
    }
    if ((await loadEval(evidence.directory)).fingerprint !== evidence.fingerprint) fail('Eval files changed during execution. Saved outputs remain evidence, but this run is not a completed frozen baseline.');
    if (!run.completedAt) { run.completedAt = new Date().toISOString(); await atomicJson(metadata, run); }
    const report = await (await import('./report.mjs')).buildReport(evidence.directory, args.run);
    return { directory, kind, recordedAttempts: rows.length, plannedAttempts: run.plannedAttempts, complete: rows.length === run.plannedAttempts, report };
  } finally { await lock.close(); await rm(path.join(directory, '.lock'), { force: true }); }
}
async function main() {
  const args = options(process.argv.slice(2)); let result;
  if (args.command === 'init') result = await init(args);
  else {
    const directory = await resolveEval(args.eval);
    if (args.command === 'report') result = await (await import('./report.mjs')).buildReport(directory, args.run);
    else if (args.command === 'review') result = await (await import('./report.mjs')).buildReview(directory);
    else { const evidence = await loadEval(directory); result = args.command === 'validate' ? await validate(evidence) : await runSuite(evidence, args); }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (args.command === 'validate' && !result.passed) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${error.code ?? 'EVAL_ERROR'}: ${error.message}\n`); process.exitCode = 1; });
