import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { summarizeRun } from '../skills/build-evals/scripts/report.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../skills/build-evals/scripts/eval.mjs', import.meta.url));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
const writeJsonl = (file, rows) => writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
const kinds = ['fresh', 'historical', 'regrade'];
const criterion = { id: 'correct', required: true };

function summary(kind, evidence, planned = evidence.length) {
  const cases = Array.from({ length: planned }, (_, index) => ({ id: `synthetic-case-${index + 1}` }));
  const run = { id: 'synthetic-costs', kind, repetitions: 1, plannedCases: planned, plannedAttempts: planned, manifest: { criteria: [criterion], rubricStatus: 'confirmed' } };
  const rows = evidence.map((row, index) => ({ caseId: cases[index].id, repetition: 1, status: 'ok', output: 'Invented output.', verdicts: { correct: { status: 'pass', reason: 'Synthetic control.' } }, ...row }));
  return summarizeRun(run, cases, rows);
}

test('imported fresh, historical, and regrade reports include judge receipt costs without duplicated metrics', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-eval-costs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The fixture is wholly invented and the report command never calls a model.
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const invoke = (...args) => exec(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000 });
  await invoke('init', '--name', 'synthetic-costs', '--mode', 'low', '--demo');
  const relative = '.understudy/evals/synthetic-costs';
  const evalDir = path.join(root, relative);
  const manifest = await readJson(path.join(evalDir, 'manifest.json'));
  const cases = (await readFile(path.join(evalDir, 'cases.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(cases.length, 8);
  const verdicts = Object.fromEntries(manifest.criteria.map(item => [item.id, { status: 'pass', reason: 'Invented imported verdict.' }]));
  const rows = cases.map(item => ({ schemaVersion: 1, caseId: item.id, repetition: 1, status: 'ok', output: { price: 4 }, verdicts, judge: { costUsd: 0.25, model: 'synthetic-judge' } }));
  await mkdir(path.join(evalDir, 'results'), { mode: 0o700 });
  for (const kind of kinds) {
    const runId = `imported-${kind}`;
    const directory = path.join(evalDir, 'results', runId);
    await mkdir(directory, { mode: 0o700 });
    const run = { schemaVersion: 1, id: runId, kind, manifest, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', fingerprint: 'a'.repeat(64), repetitions: 1, plannedCases: 8, plannedAttempts: 8, ...(kind === 'regrade' ? { sourceRun: 'synthetic-source', sourceEvidenceDigest: 'b'.repeat(64) } : {}) };
    await writeJson(path.join(directory, 'run.json'), run);
    await writeJsonl(path.join(directory, 'cases.jsonl'), cases);
    await writeJsonl(path.join(directory, 'results.jsonl'), rows);
    await invoke('report', '--eval', relative, '--run', runId);
    const report = await readJson(path.join(directory, 'summary.json'));
    assert.deepEqual(report.judgeCostUsd, { observed: 8, planned: 8, sum: 2, complete: true }, kind);
    assert.equal(report.costUsd.sum, null, 'judge receipts must not be added to application costs');
    for (const filename of ['report.md', 'report.html']) {
      assert.match(await readFile(path.join(directory, filename), 'utf8'), /Grading-pass judge cost: \$2 observed, coverage 8\/8/);
    }
  }
});

test('known receipt cost takes precedence and unknown receipt cost falls back to metrics in every run kind', () => {
  const evidence = [
    { judge: { costUsd: 0 }, metrics: { judgeCostUsd: 9 } },
    { judge: { costUsd: 0.25 }, metrics: { judgeCostUsd: 0.5 } },
    { judge: { costUsd: null }, metrics: { judgeCostUsd: 0.5 } },
    { judge: { model: 'synthetic-judge' }, metrics: { judgeCostUsd: 0.25 } },
    { metrics: { judgeCostUsd: 0 } },
    { judge: { costUsd: null }, metrics: { judgeCostUsd: null } },
    {},
  ];
  for (const kind of kinds) {
    assert.deepEqual(summary(kind, evidence).judgeCostUsd, { observed: 5, planned: 7, sum: 1, complete: false }, kind);
    assert.deepEqual(summary(kind, [{ judge: { costUsd: 0 }, metrics: { judgeCostUsd: 7 } }]).judgeCostUsd, { observed: 1, planned: 1, sum: 0, complete: true }, `${kind}: known zero`);
  }
});

test('partial and failed grading receipts retain known cost while missing attempts stay unknown', () => {
  const evidence = [
    { judge: { costUsd: 0.25 } },
    { status: 'grader_error', verdicts: undefined, error: { code: 'SYNTHETIC_JUDGE_ERROR', message: 'Invented failure after a paid grading request.' }, judge: { costUsd: 0.75 } },
    { status: 'grader_error', verdicts: undefined, error: { code: 'SYNTHETIC_JUDGE_ERROR', message: 'Invented failure without cost evidence.' }, judge: { costUsd: null } },
  ];
  for (const kind of kinds) {
    const result = summary(kind, evidence, 4);
    assert.deepEqual(result.judgeCostUsd, { observed: 2, planned: 4, sum: 1, complete: false }, kind);
    assert.equal(result.execution.grader_error, 2);
    assert.equal(result.execution.pending, 1);
    assert.deepEqual(summary(kind, [{}]).judgeCostUsd, { observed: 0, planned: 1, sum: null, complete: false }, `${kind}: all costs absent`);
  }
});

test('invalid judge receipts are rejected even when a valid fallback metric exists', () => {
  for (const kind of kinds) {
    for (const costUsd of [-1, '0.25', Infinity]) {
      assert.throws(() => summary(kind, [{ judge: { costUsd }, metrics: { judgeCostUsd: 0.25 } }]), /Invalid judge cost/, `${kind}: ${costUsd}`);
    }
  }
});
