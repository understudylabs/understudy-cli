import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { htmlReport, markdownReport } from './present.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (caseId, repetition) => JSON.stringify([caseId, repetition]);
const own = (value, field) => Object.hasOwn(value, field);
const fail = message => { throw new Error(message); };

async function dependencies() {
  try {
    const lib = await import('../../build-evals/scripts/lib.mjs');
    const { summarizeRun } = await import('../../build-evals/scripts/report.mjs');
    for (const name of ['loadRun', 'resolveEval', 'validateRunId', 'initComparisonDirectory', 'writePrivate']) {
      if (typeof lib[name] !== 'function') fail(`Missing build-evals helper: ${name}`);
    }
    return { ...lib, summarizeRun };
  } catch (error) {
    throw new Error('Install the matching build-evals skill beside compare-models before using this optional helper. Native eval tools do not need this helper.', { cause: error });
  }
}

function outcome(row, criteria) {
  if (!row) return 'pending';
  const required = criteria.filter(criterion => criterion.required);
  if (required.some(criterion => row.verdicts?.[criterion.id]?.status === 'fail')) return 'fail';
  if (row.status === 'ok' && required.every(criterion => row.verdicts?.[criterion.id]?.status === 'pass')) return 'pass';
  return 'unscored';
}

function modelIdentity(row, requestedModel) {
  if (!row) return { status: 'missing', reason: 'This attempt has no saved result.' };
  const calls = row.receipt?.calls;
  if (!Array.isArray(calls) || calls.length === 0) return { status: 'unknown', reason: 'Per-call model receipts are missing; a legacy task-level model label is insufficient.' };
  if (calls.some(call => call.requestedModel !== null && call.requestedModel !== undefined && call.requestedModel !== requestedModel)) return { status: 'mismatch', reason: 'An application call requests another model. This helper requires every application call to request the selected model; fixed model dependencies need a native comparison viewer that attributes calls by responsibility. Recorded checks and spending remain visible, but do not establish a model regression or improvement.' };
  const mismatch = calls.some(call => (call.servedModel !== null && call.servedModel !== undefined && call.servedModel !== requestedModel) || call.fallbackUsed === true);
  if (mismatch) return { status: 'mismatch', reason: 'A served model or fallback differs from the declared model. Its outcome and spending remain visible.' };
  if (row.receipt.callsComplete !== true || calls.some(call => !call.requestId || call.requestedModel !== requestedModel || call.servedModel !== requestedModel || call.fallbackUsed !== false)) return { status: 'unknown', reason: 'Call coverage, request IDs, actual serving, or fallback evidence is incomplete.' };
  return { status: 'verified', reason: 'All declared calls have matching requested and served model receipts and no recorded fallback.' };
}

function attempt(row, checkpoint, item, repetition, run) {
  const evidence = row ?? checkpoint;
  return { caseId: item.id, repetition, executionStatus: row?.status ?? (checkpoint ? 'grading_pending' : 'pending'), quality: outcome(row, run.manifest.criteria), identity: modelIdentity(evidence, run.requestedModel), resultRecorded: Boolean(row), outputRecorded: Boolean(evidence && own(evidence, 'output')), output: evidence && own(evidence, 'output') ? evidence.output : null, verdicts: row?.verdicts ?? {}, trace: evidence?.trace ?? [], metrics: evidence?.metrics ?? {}, receipt: evidence?.receipt ?? null, judge: row?.judge ?? null, error: evidence?.error ?? null };
}

function category(left, right) {
  if (left.quality === 'pending' || right.quality === 'pending') return 'pending';
  if (left.identity.status !== 'verified' || right.identity.status !== 'verified') return 'unverified_model';
  if (left.quality === 'unscored' || right.quality === 'unscored') return 'unscored';
  if (left.quality === 'pass' && right.quality === 'fail') return 'regression';
  if (left.quality === 'fail' && right.quality === 'pass') return 'improvement';
  return left.quality === 'pass' ? 'both_pass' : 'both_fail';
}

function applicationLatency(attempts) {
  const timed = attempts.filter(row => typeof row.metrics.latencyMs === 'number' && Number.isFinite(row.metrics.latencyMs));
  const values = timed.map(row => row.metrics.latencyMs).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return { observed: values.length, planned: attempts.length, complete: values.length === attempts.length, pendingExecutionsIncluded: timed.filter(row => !row.resultRecorded).length, min: values[0] ?? null, median: values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null, p90: values[Math.ceil(values.length * .9) - 1] ?? null, max: values.at(-1) ?? null, mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
}

/** Compare validated immutable run snapshots; never load an adapter or grader. */
export function compareRuns(sources, summarizeRun) {
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > 10) fail('Supply a baseline and one to nine candidate runs.');
  const baseline = sources[0], runIds = new Set(), requestIds = new Set();
  for (const source of sources) {
    const { run, cases, rows } = source;
    if (run.kind !== 'fresh' || typeof run.requestedModel !== 'string' || !run.requestedModel.trim()) fail('Every input must be a fresh run with a frozen requestedModel. Historical and regraded runs need native comparison with explicit conditions.');
    if (runIds.has(run.id)) fail('Run IDs must be unique across the comparison.');
    runIds.add(run.id);
    if (!isDeepStrictEqual(run.manifest.workload, baseline.run.manifest.workload)) fail('Runs belong to different workloads.');
    if (!isDeepStrictEqual(cases, baseline.cases)) fail('Frozen cases, inputs, expected outcomes, or membership differ.');
    if (!isDeepStrictEqual(run.manifest, baseline.run.manifest) || run.fingerprint !== baseline.run.fingerprint || run.repetitions !== baseline.run.repetitions) fail('Runs must share the exact frozen eval fingerprint, manifest, grader, and common configuration. Only the separately recorded requestedModel may differ.');
    const evidence = new Map((source.executions ?? []).map(row => [key(row.caseId, row.repetition), row]));
    for (const row of rows) evidence.set(key(row.caseId, row.repetition), row);
    for (const row of evidence.values()) {
      const calls = row.receipt?.calls ?? [];
      const local = new Set();
      for (const call of calls) {
        if (!call.requestId) continue;
        if (local.has(call.requestId)) fail('A result contains duplicate per-call request IDs.');
        local.add(call.requestId);
      }
      for (const id of row.receipt?.requestIds ?? []) local.add(id);
      for (const id of local) {
        if (requestIds.has(id)) fail('The same request ID is attributed to multiple attempts or runs. Resolve copied or ambiguous evidence before comparing.');
        requestIds.add(id);
      }
    }
  }
  const runs = sources.map(({ run, cases, rows, executions = [], sourcePath }) => {
    const summary = summarizeRun(run, cases, rows);
    const records = new Map(rows.map(row => [key(row.caseId, row.repetition), row]));
    const checkpoints = new Map(executions.map(row => [key(row.caseId, row.repetition), row]));
    const attempts = cases.flatMap(item => Array.from({ length: run.repetitions }, (_, index) => attempt(records.get(key(item.id, index + 1)), checkpoints.get(key(item.id, index + 1)), item, index + 1, run)));
    const identity = Object.fromEntries(['verified', 'mismatch', 'unknown', 'missing'].map(status => [status, attempts.filter(value => value.identity.status === status).length]));
    const calls = attempts.flatMap(row => row.receipt?.calls ?? []);
    const callCosts = calls.filter(call => typeof call.costUsd === 'number' && Number.isFinite(call.costUsd));
    const costs = attempts.map(row => row.metrics.costUsd).filter(value => typeof value === 'number' && Number.isFinite(value));
    const applicationCost = { observed: costs.length, planned: attempts.length, sum: costs.length ? costs.reduce((total, value) => total + value, 0) : null, complete: costs.length === attempts.length, pendingExecutionsIncluded: attempts.filter(row => !row.resultRecorded && typeof row.metrics.costUsd === 'number').length };
    return { id: run.id, requestedModel: run.requestedModel, sourcePath, sourceDigest: digest({ run, cases, rows, executions }), startedAt: run.startedAt, completedAt: run.completedAt ?? null, summary, applicationCost, applicationLatencyMs: applicationLatency(attempts), identity, callEvidence: { recorded: calls.length, attemptsComplete: attempts.filter(row => row.receipt?.callsComplete === true).length, plannedAttempts: summary.plannedAttempts, priced: callCosts.length, costBases: [...new Set(callCosts.map(call => call.costBasis ?? 'unspecified'))], note: 'Per-call prices are evidence only and are not added to application task costs. A missing call can also hide missing spending.' }, attempts };
  });
  const pairs = runs.slice(1).map(candidate => {
    const rows = baseline.cases.flatMap(item => Array.from({ length: baseline.run.repetitions }, (_, index) => {
      const position = runs[0].attempts.findIndex(value => value.caseId === item.id && value.repetition === index + 1);
      const left = runs[0].attempts[position], right = candidate.attempts[position];
      return { caseId: item.id, title: item.title, repetition: index + 1, category: category(left, right), baseline: left, candidate: right };
    }));
    const counts = Object.fromEntries(['both_pass', 'both_fail', 'regression', 'improvement', 'unscored', 'unverified_model', 'pending'].map(value => [value, rows.filter(row => row.category === value).length]));
    return { candidateId: candidate.id, candidateModel: candidate.requestedModel, planned: rows.length, counts, rows };
  });
  return { schemaVersion: 1, workload: baseline.run.manifest.workload, baselineId: baseline.run.id, fingerprint: baseline.run.fingerprint, criteria: baseline.run.manifest.criteria, cases: baseline.cases, runs, pairs, limitations: ['Descriptive results for the selected frozen eval; no universal ranking, population estimate, confidence interval, or deployment approval is inferred.', 'Runs are paired by case ID and repetition. Repetitions are not additional independent tasks.', 'Matching file fingerprints do not prove unchanged external state, cache conditions, tool isolation, or undeclared configuration. Inspect the saved execution contract.', 'Model identity verification covers the declared call receipts. callsComplete is adapter-supplied evidence, not independent proof that every call was captured.', 'Application task costs, per-call prices, judge costs, and ledger debits are distinct. Missing cost is unknown, never zero.'] };
}

export async function buildComparison({ name, baseline, candidates }) {
  const lib = await dependencies();
  lib.validateRunId(name);
  if (!baseline || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 9) fail('Supply --baseline and one to nine --candidate run directories.');
  const sources = [];
  for (const input of [baseline, ...candidates]) {
    const absolute = path.resolve(input), runId = path.basename(absolute), results = path.dirname(absolute), evalDir = path.dirname(results);
    if (path.basename(results) !== 'results') fail('Use existing .understudy/evals/<name>/results/<run> directories.');
    const resolved = await lib.resolveEval(evalDir);
    const saved = await lib.loadRun(resolved, runId);
    if (sources.some(source => source.directory === saved.directory)) fail('The same run directory was supplied more than once.');
    if (await lib.exists(path.join(saved.directory, '.lock'))) fail('An input run is locked. Wait until execution finishes or reconcile the stopped run before comparing.');
    const root = await lib.appRoot();
    sources.push({ ...saved, sourcePath: path.relative(root, saved.directory) });
  }
  const comparison = compareRuns(sources, lib.summarizeRun);
  const directory = await lib.initComparisonDirectory(name);
  const paths = { html: path.join(directory, 'report.html'), markdown: path.join(directory, 'report.md'), summary: path.join(directory, 'summary.json') };
  await lib.writePrivate(paths.html, htmlReport(comparison), true);
  await lib.writePrivate(paths.markdown, markdownReport(comparison), true);
  await lib.writePrivate(paths.summary, `${JSON.stringify(comparison, null, 2)}\n`, true);
  return { directory, ...paths, baseline: comparison.baselineId, candidates: comparison.pairs.map(pair => pair.candidateId), note: 'Saved-data comparison only. No application, grader, or model was executed. Inspect application packaging to exclude .understudy before distribution.' };
}

function parseArgs(argv) {
  const args = { candidates: [] }, single = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--name', '--baseline', '--candidate'].includes(flag) || !value || value.startsWith('--')) fail('Usage: compare.mjs --name <id> --baseline <run-directory> --candidate <run-directory> [--candidate <run-directory> ...]');
    if (flag === '--candidate') args.candidates.push(value);
    else { if (single.has(flag)) fail(`Duplicate option: ${flag}`); single.add(flag); args[flag.slice(2)] = value; }
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await buildComparison(parseArgs(process.argv.slice(2))), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
