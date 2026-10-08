import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, lstat, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const sourceScript = fileURLToPath(new URL('../skills/build-evals/scripts/eval.mjs', import.meta.url));
const sourceCli = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const parse = async file => JSON.parse(await readFile(file, 'utf8'));
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const json = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const jsonl = (file, rows) => writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
async function fixture(t, { mode = 'low', installed = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-understudy-eval-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // No inherited application credentials are needed or supplied to this local demo.
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  let script = sourceScript;
  if (installed) {
    const destination = path.join(root, 'installed-skills');
    await exec(process.execPath, [sourceCli, 'skills', 'install', 'build-evals', '--directory', destination, '--json'], { cwd: root, env });
    script = path.join(destination, 'build-evals/scripts/eval.mjs');
  }
  const call = async (...args) => {
    try { const result = await exec(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000, maxBuffer: 2e6 }); return { status: 0, ...result }; }
    catch (error) { return { status: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  await ok('init', '--name', 'parcel', '--mode', mode, '--demo');
  const relative = '.understudy/evals/parcel', directory = path.join(root, relative);
  const validate = () => ok('validate', '--eval', relative);
  const run = id => ok('run', '--eval', relative, '--run', id);
  return { root, env, script, directory, relative, call, ok, validate, run };
}

test('installed eval skill runs its offline demo, resumes without duplicate work, and regrades saved outputs', async t => {
  const f = await fixture(t, { installed: true });
  assert.equal((await f.validate()).passed, true);
  await f.run('baseline');
  const runDir = path.join(f.directory, 'results/baseline');
  const rows = await lines(path.join(runDir, 'results.jsonl'));
  assert.equal(rows.length, 8);
  assert.equal(rows.filter(row => Object.values(row.verdicts).some(verdict => verdict.status === 'fail')).length, 2);
  const originalRows = await readFile(path.join(runDir, 'results.jsonl'), 'utf8');
  await f.run('baseline');
  assert.equal(await readFile(path.join(runDir, 'results.jsonl'), 'utf8'), originalRows);
  const summary = await parse(path.join(runDir, 'summary.json'));
  assert.deepEqual(summary.quality, { pass: 6, fail: 2, unscored: 0, pending: 0 });
  assert.equal(summary.costUsd.sum, 0);
  assert.equal(summary.plannedCases, 8);
  const file = path.join(f.directory, 'adapter.mjs');
  await writeFile(file, "export async function run() { throw new Error('An offline regrade must not call this adapter.'); }\n");
  await f.validate();
  const refused = await f.call('run', '--eval', f.relative, '--run', 'baseline');
  assert.notEqual(refused.status, 0, 'changed adapter cannot resume the old execution');
  await f.ok('regrade', '--eval', f.relative, '--from', 'baseline', '--run', 'regraded');
  const regraded = await parse(path.join(f.directory, 'results/regraded/summary.json'));
  assert.equal(regraded.kind, 'regrade');
  assert.deepEqual(regraded.quality, summary.quality);
  assert.equal(await readFile(path.join(runDir, 'results.jsonl'), 'utf8'), originalRows);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    for (const fileName of ['run.json', 'cases.jsonl', 'results.jsonl', 'report.html', 'report.md', 'summary.json']) assert.equal((await lstat(path.join(runDir, fileName))).mode & 0o777, 0o600);
  }
});

test('meaningful negative controls catch an always-pass grader before execution', async t => {
  const f = await fixture(t);
  const manifest = await parse(path.join(f.directory, 'manifest.json'));
  const verdicts = Object.fromEntries(manifest.criteria.map(criterion => [criterion.id, { status: 'pass', reason: 'Synthetic broken checker accepts everything.' }]));
  await writeFile(path.join(f.directory, 'grader.mjs'), `export async function grade() { return ${JSON.stringify({ verdicts })}; }\n`);
  const result = await f.call('validate', '--eval', f.relative);
  assert.notEqual(result.status, 0);
  const validation = await parse(path.join(f.directory, 'validation.json'));
  assert.equal(validation.passed, false);
  assert.ok(validation.controls.some(control => !control.passed));
  assert.notEqual((await f.call('run', '--eval', f.relative, '--run', 'blocked')).status, 0);
});

test('historical missing outputs and incomplete runs retain all selected cases in reports', async t => {
  const f = await fixture(t, { mode: 'medium' });
  const casesFile = path.join(f.directory, 'cases.jsonl');
  const cases = await lines(casesFile);
  cases.forEach(item => delete item.observed);
  await jsonl(casesFile, cases);
  await f.validate();
  await f.ok('grade', '--eval', f.relative, '--run', 'historical');
  const directory = path.join(f.directory, 'results/historical');
  let summary = await parse(path.join(directory, 'summary.json'));
  assert.equal(summary.plannedCases, 8);
  assert.equal(summary.execution.missing_output, 8);
  assert.equal(summary.quality.pass, 0);
  assert.equal(summary.quality.fail, 0);
  assert.equal(summary.costUsd.sum, null);
  const run = await parse(path.join(directory, 'run.json')); delete run.completedAt;
  await json(path.join(directory, 'run.json'), run);
  await jsonl(path.join(directory, 'results.jsonl'), (await lines(path.join(directory, 'results.jsonl'))).slice(0, 3));
  await f.ok('report', '--eval', f.relative, '--run', 'historical');
  summary = await parse(path.join(directory, 'summary.json'));
  assert.equal(summary.execution.pending, 5);
  assert.equal(summary.perCase.length, 8);
  const html = await readFile(path.join(directory, 'report.html'), 'utf8');
  for (const item of cases) assert.ok(html.includes(item.id));
});

test('execution, fixture and timeout errors stay distinct from a bad model answer', async t => {
  const f = await fixture(t);
  const manifestFile = path.join(f.directory, 'manifest.json');
  const manifest = await parse(manifestFile); manifest.settings.timeoutMs = 500;
  await json(manifestFile, manifest);
  await writeFile(path.join(f.directory, 'adapter.mjs'), `export async function run(task) {
    if ('expected' in task || 'observed' in task) throw new Error('Answer leakage');
    if (task.input.grams === 250 && !task.input.priority) throw Object.assign(new Error('No matching tool fixture'), {code:'ENVIRONMENT_GAP'});
    if (task.input.grams === 250) throw new Error('Transport failed');
    if (task.input.grams === 500 && !task.input.priority) await new Promise(() => {});
    return {output:{price:999}};
  }\n`);
  await f.validate(); await f.run('faults');
  const summary = await parse(path.join(f.directory, 'results/faults/summary.json'));
  assert.equal(summary.execution.environment_gap, 1);
  assert.equal(summary.execution.execution_error, 1);
  assert.equal(summary.execution.timeout, 1);
  assert.equal(summary.quality.fail, 5);
  assert.equal(summary.quality.unscored, 3);
  assert.equal(summary.costUsd.sum, null);
});

test('malformed evidence, duplicate cases, unsafe paths and uncertain attempts fail closed', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'cases.jsonl'), cases = await lines(file);
  await jsonl(file, [...cases, cases[0]]);
  assert.notEqual((await f.call('validate', '--eval', f.relative)).status, 0);
  await jsonl(file, cases);
  await f.validate(); await f.run('baseline');
  const runDir = path.join(f.directory, 'results/baseline');
  await json(path.join(runDir, 'pending.json'), { caseId: cases[0].id, repetition: 1 });
  const blocked = await f.call('run', '--eval', f.relative, '--run', 'baseline');
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /pending|uncertain/i);
  await rm(path.join(runDir, 'pending.json'));
  const rows = await readFile(path.join(runDir, 'results.jsonl'), 'utf8');
  await writeFile(path.join(runDir, 'results.jsonl'), rows + '{"unfinished":');
  assert.notEqual((await f.call('report', '--eval', f.relative, '--run', 'baseline')).status, 0);
  await writeFile(path.join(runDir, 'results.jsonl'), rows);
  const escaped = path.join(f.root, 'outside.json'); await json(escaped, {});
  await rm(path.join(runDir, 'summary.json')); await symlink(escaped, path.join(runDir, 'summary.json'));
  assert.notEqual((await f.call('report', '--eval', f.relative, '--run', 'baseline')).status, 0);
  assert.deepEqual(await parse(escaped), {});
  if (process.platform !== 'win32') { await chmod(file, 0o644); assert.notEqual((await f.call('validate', '--eval', f.relative)).status, 0); }
});

test('a human-only Low eval runs without requiring an automated semantic judge', async t => {
  const f = await fixture(t);
  const manifestFile = path.join(f.directory, 'manifest.json');
  const manifest = await parse(manifestFile);
  manifest.criteria = [{ id: 'helpful', description: 'A qualified reviewer decides whether the answer is useful.', required: true, grading: 'human' }];
  await json(manifestFile, manifest);
  const cases = await lines(path.join(f.directory, 'cases.jsonl'));
  await jsonl(path.join(f.directory, 'controls.jsonl'), [{ id: 'pending-review', caseId: cases[0].id, output: { price: 4 }, expectedVerdicts: { helpful: 'unscored' }, note: 'Human-only criteria must remain pending rather than assume success.' }]);
  await writeFile(path.join(f.directory, 'grader.mjs'), "export async function grade() { return { verdicts: { helpful: { status: 'unscored', reason: 'Awaiting a qualified human review.' } }, judge: { costUsd: 0 } }; }\n");
  await f.validate(); await f.run('human-review');
  const summary = await parse(path.join(f.directory, 'results/human-review/summary.json'));
  assert.deepEqual(summary.quality, { pass: 0, fail: 0, unscored: 8, pending: 0 });
  assert.equal(summary.execution.ok, 8);
  assert.equal(summary.judgeCostUsd.sum, 0);
  await f.ok('review', '--eval', f.relative);
  assert.match(await readFile(path.join(f.directory, 'review.html'), 'utf8'), /A qualified reviewer decides/);
});

test('provisional requirements never claim verified success or a trusted cost-per-pass', async t => {
  const f = await fixture(t);
  const manifestFile = path.join(f.directory, 'manifest.json'), manifest = await parse(manifestFile);
  manifest.rubricStatus = 'provisional';
  await json(manifestFile, manifest);
  await f.validate(); await f.run('provisional');
  const summary = await parse(path.join(f.directory, 'results/provisional/summary.json'));
  assert.equal(summary.quality.pass, 6);
  assert.equal(summary.costPerPassingAttemptUsd, null);
  const html = await readFile(path.join(f.directory, 'results/provisional/report.html'), 'utf8');
  assert.match(html, /Provisional passes/);
  assert.doesNotMatch(html, /Confirmed success:|cost per verified successful/);
});

test('judge errors preserve successful application completion separately from quality', async t => {
  const f = await fixture(t);
  const grader = path.join(f.directory, 'grader.mjs');
  await writeFile(path.join(f.directory, 'checks.mjs'), await readFile(grader), { mode: 0o600 });
  await writeFile(grader, "import { grade as check } from './checks.mjs';\nexport async function grade(task, execution) { if (execution.trace) throw new Error('Synthetic judge unavailable'); return check(task, execution); }\n");
  const manifestFile = path.join(f.directory, 'manifest.json'), manifest = await parse(manifestFile);
  manifest.fingerprintFiles.push('checks.mjs');
  await json(manifestFile, manifest);
  await f.validate(); await f.run('judge-outage');
  const directory = path.join(f.directory, 'results/judge-outage');
  const summary = await parse(path.join(directory, 'summary.json'));
  assert.equal(summary.applicationCompletedAttempts, 8);
  assert.equal(summary.execution.grader_error, 8);
  assert.deepEqual(summary.quality, { pass: 0, fail: 0, unscored: 8, pending: 0 });
  assert.match(await readFile(path.join(directory, 'report.md'), 'utf8'), /Application completion: 8\/8/);
});

test('conflicting execution journals block reporting, resume, and regrading without rejecting grading-only changes', async t => {
  const f = await fixture(t);
  await f.validate(); await f.run('baseline');
  const directory = path.join(f.directory, 'results/baseline');
  const resultsFile = path.join(directory, 'results.jsonl');
  const original = await lines(resultsFile);
  const changes = [
    row => { row.output.price = 999; },
    row => { row.trace[0].content = 'A conflicting invented interaction.'; },
    row => { row.metrics.costUsd = 1; },
    row => { row.receipt.requestIds = ['synthetic-conflicting-receipt']; },
  ];
  for (const change of changes) {
    const rows = structuredClone(original); change(rows[0]);
    await jsonl(resultsFile, rows);
    const result = await f.call('report', '--eval', f.relative, '--run', 'baseline');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflicting.*execution.*evidence/i);
  }
  for (const args of [
    ['run', '--eval', f.relative, '--run', 'baseline'],
    ['regrade', '--eval', f.relative, '--from', 'baseline', '--run', 'blocked'],
  ]) {
    const result = await f.call(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflicting.*execution.*evidence/i);
  }
  await assert.rejects(lstat(path.join(f.directory, 'results/blocked')), { code: 'ENOENT' });

  const rows = structuredClone(original);
  rows[0].receipt = Object.fromEntries(Object.entries(rows[0].receipt).reverse());
  rows[0].status = 'grader_error';
  rows[0].error = { code: 'JUDGE_FAILURE', message: 'Synthetic grading failure after execution.' };
  delete rows[0].verdicts;
  rows[0].judge = { costUsd: 0.25 };
  rows[0].metrics.judgeCostUsd = 0.25;
  await jsonl(resultsFile, rows);
  await f.ok('report', '--eval', f.relative, '--run', 'baseline');
  await f.ok('regrade', '--eval', f.relative, '--from', 'baseline', '--run', 'recovered');
  assert.deepEqual((await parse(path.join(f.directory, 'results/recovered/summary.json'))).quality,
    { pass: 6, fail: 2, unscored: 0, pending: 0 });

  // A checkpoint without a completed grading row is recovery evidence, not a conflict.
  await jsonl(resultsFile, original.slice(1));
  const run = await parse(path.join(directory, 'run.json')); delete run.completedAt;
  await json(path.join(directory, 'run.json'), run);
  await f.ok('regrade', '--eval', f.relative, '--from', 'baseline', '--run', 'interrupted-recovery');
  const recovered = await lines(path.join(f.directory, 'results/interrupted-recovery/results.jsonl'));
  assert.equal(recovered.length, 8);
  assert.equal(recovered[0].status, 'ok');
  assert.deepEqual(recovered[0].output, original[0].output);
});
