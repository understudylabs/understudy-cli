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
const call = (requestId, servedModel = 'synthetic/model', extra = {}) => ({ requestId, requestedModel: 'synthetic/model', servedModel, fallbackUsed: false, ...extra });

function summary(evidence, planned = evidence.length, kind = 'fresh') {
  const cases = Array.from({ length: planned }, (_, index) => ({ id: `synthetic-case-${index + 1}` }));
  const run = { id: 'synthetic-models', kind, repetitions: 1, plannedCases: planned, plannedAttempts: planned, manifest: { criteria: [criterion], rubricStatus: 'confirmed' } };
  const rows = evidence.map((row, index) => ({ caseId: cases[index].id, repetition: 1, status: 'ok', output: 'Invented output.', verdicts: { correct: { status: 'pass', reason: 'Synthetic control.' } }, ...row }));
  return summarizeRun(run, cases, rows);
}

test('per-call served identities count calls and distinct attempts without needing legacy receipt.model', () => {
  for (const kind of kinds) {
    const result = summary([{ receipt: { callsComplete: true, calls: [call('synthetic-first'), call('synthetic-second')] } }], 1, kind);
    assert.deepEqual(result.actualModels.models, [{ model: 'synthetic/model', attempts: 1, calls: 2 }]);
    assert.equal(result.actualModels.observed, 1);
    assert.equal(result.actualModels.missing, 0);
    assert.equal(result.actualModels.legacy.observed, 0);
    assert.deepEqual(result.actualModels.callCoverage, { recordedCalls: 2, knownServedModels: 2, unknownServedModels: 0, attemptsWithCallLists: 1, attemptsDeclaredComplete: 1, attemptsWithCompleteServedIdentity: 1, attemptsWithoutCompleteServedIdentity: 0, plannedAttempts: 1, complete: true });
  }
});

test('a matching legacy label and call receipts never count the same attempt or call twice', () => {
  const result = summary([{ receipt: { model: 'synthetic/model', callsComplete: true, calls: [call('synthetic-first'), call('synthetic-second')] }, judge: { model: 'synthetic/judge' } }]);
  assert.deepEqual(result.actualModels.models, [{ model: 'synthetic/model', attempts: 1, calls: 2 }]);
  assert.equal(result.actualModels.observed, 1);
  assert.deepEqual(result.actualModels.legacy.models, [{ model: 'synthetic/model', attempts: 1 }]);
  assert.deepEqual(result.judgeModels, { models: [{ model: 'synthetic/judge', attempts: 1 }], observed: 1, missing: 0, planned: 1 });
});

test('mixed models and fallbacks stay visible without adding per-model attempts into coverage', () => {
  const result = summary([{ receipt: { callsComplete: true, calls: [call('synthetic-first'), call('synthetic-second'), call('synthetic-fallback', 'synthetic/backup', { fallbackUsed: true })] } }]);
  assert.deepEqual(result.actualModels.models, [{ model: 'synthetic/model', attempts: 1, calls: 2 }, { model: 'synthetic/backup', attempts: 1, calls: 1 }]);
  assert.equal(result.actualModels.observed, 1);
  assert.equal(result.actualModels.callCoverage.knownServedModels, 3);
  assert.equal(result.actualModels.callCoverage.complete, true, 'known served identities do not imply requested-model conformance');
  assert.match(result.actualModels.basis, /mixed-model attempts can appear under several models/);
});

test('partial, missing and unknown call lists cannot claim complete serving coverage', () => {
  const result = summary([
    { receipt: { callsComplete: false, calls: [call('synthetic-partial')] } },
    { receipt: { callsComplete: true, calls: [call('synthetic-unknown', null)] } },
    { receipt: { model: 'synthetic/legacy' } },
    { receipt: { callsComplete: true, calls: [] } },
    { receipt: { calls: [call(null)] } },
  ], 6);
  assert.deepEqual(result.actualModels.models, [{ model: 'synthetic/model', attempts: 2, calls: 2 }, { model: 'synthetic/legacy', attempts: 1, calls: 0 }]);
  assert.equal(result.actualModels.observed, 3);
  assert.equal(result.actualModels.missing, 3);
  assert.deepEqual(result.actualModels.callCoverage, { recordedCalls: 3, knownServedModels: 2, unknownServedModels: 1, attemptsWithCallLists: 4, attemptsDeclaredComplete: 2, attemptsWithCompleteServedIdentity: 0, attemptsWithoutCompleteServedIdentity: 6, plannedAttempts: 6, complete: false });
});

test('new unknown call identities are not filled from a requested model or legacy attempt label', () => {
  const result = summary([{ receipt: { model: 'synthetic/legacy', callsComplete: false, calls: [call('synthetic-unknown', null)] } }]);
  assert.deepEqual(result.actualModels.models, []);
  assert.equal(result.actualModels.observed, 0);
  assert.equal(result.actualModels.callCoverage.unknownServedModels, 1);
  assert.deepEqual(result.actualModels.legacy.models, [{ model: 'synthetic/legacy', attempts: 1 }]);
});

test('legacy-only receipts retain their attempt counts without inventing call counts or coverage', () => {
  const result = summary([{ receipt: { model: 'synthetic/legacy' } }, { receipt: { model: 'synthetic/legacy' } }, {}]);
  assert.deepEqual(result.actualModels.models, [{ model: 'synthetic/legacy', attempts: 2, calls: 0 }]);
  assert.equal(result.actualModels.observed, 2);
  assert.equal(result.actualModels.missing, 1);
  assert.equal(result.actualModels.callCoverage.recordedCalls, 0);
  assert.equal(result.actualModels.callCoverage.complete, false);
});

test('failed executions retain known serving evidence and pending attempts remain in the denominator', () => {
  const result = summary([{ status: 'execution_error', verdicts: undefined, error: { code: 'SYNTHETIC_ERROR', message: 'Invented failure after a model response.' }, receipt: { callsComplete: true, calls: [call('synthetic-failed')] } }], 2);
  assert.equal(result.actualModels.observed, 1);
  assert.equal(result.actualModels.missing, 1);
  assert.equal(result.actualModels.callCoverage.attemptsWithCompleteServedIdentity, 1);
  assert.equal(result.actualModels.callCoverage.complete, false);
  assert.equal(result.quality.unscored, 1);
  assert.equal(result.quality.pending, 1);
});

test('saved-data HTML and Markdown reports show per-call models and honest coverage without executing code', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-eval-models-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const invoke = (...args) => exec(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000 });
  await invoke('init', '--name', 'synthetic-models', '--mode', 'low', '--demo');
  const relative = '.understudy/evals/synthetic-models', evalDir = path.join(root, relative);
  const manifest = await readJson(path.join(evalDir, 'manifest.json'));
  const cases = (await readFile(path.join(evalDir, 'cases.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const verdicts = Object.fromEntries(manifest.criteria.map(item => [item.id, { status: 'pass', reason: 'Invented imported verdict.' }]));
  const rows = cases.map((item, index) => ({ schemaVersion: 1, caseId: item.id, repetition: 1, status: 'ok', output: { price: 4 }, verdicts, receipt: { callsComplete: true, calls: [call(`synthetic-call-${index}-first`), call(`synthetic-call-${index}-second`)] } }));
  await mkdir(path.join(evalDir, 'results'), { mode: 0o700 });
  // Report generation must never import either executable file.
  for (const file of [manifest.adapter, manifest.grader]) await writeFile(path.join(evalDir, file), 'throw new Error("Must not execute while reporting");\n', { mode: 0o600 });
  for (const kind of kinds) {
    const runId = `models-${kind}`, directory = path.join(evalDir, 'results', runId);
    await mkdir(directory, { mode: 0o700 });
    const run = { schemaVersion: 1, id: runId, kind, manifest, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', fingerprint: 'a'.repeat(64), repetitions: 1, plannedCases: 8, plannedAttempts: 8, ...(kind === 'regrade' ? { sourceRun: 'synthetic-source', sourceEvidenceDigest: 'b'.repeat(64) } : {}) };
    await writeJson(path.join(directory, 'run.json'), run);
    await writeJsonl(path.join(directory, 'cases.jsonl'), cases);
    await writeJsonl(path.join(directory, 'results.jsonl'), rows);
    await invoke('report', '--eval', relative, '--run', runId);
    let result = await readJson(path.join(directory, 'summary.json'));
    assert.deepEqual(result.actualModels.models, [{ model: 'synthetic/model', attempts: 8, calls: 16 }]);
    for (const filename of ['report.html', 'report.md']) {
      const rendered = await readFile(path.join(directory, filename), 'utf8');
      assert.match(rendered, /Application attempts with a reported model identity: 8\/8/);
      assert.match(rendered, /Application call receipts: 16\/16 recorded calls/);
      assert.match(rendered, /adapter-declared complete call lists: 8\/8 attempts/);
      assert.match(rendered, /Legacy attempt labels: 0\/8/);
    }
    const partial = structuredClone(rows);
    partial[0].receipt.callsComplete = false;
    partial[0].receipt.calls[0].servedModel = null;
    await writeJsonl(path.join(directory, 'results.jsonl'), partial);
    await invoke('report', '--eval', relative, '--run', runId);
    result = await readJson(path.join(directory, 'summary.json'));
    assert.equal(result.actualModels.observed, 8);
    assert.equal(result.actualModels.callCoverage.complete, false);
    for (const filename of ['report.html', 'report.md']) {
      const rendered = await readFile(path.join(directory, filename), 'utf8');
      assert.match(rendered, /Application call receipts: 15\/16 recorded calls/);
      assert.match(rendered, /adapter-declared complete call lists: 7\/8 attempts/);
      assert.match(rendered, /Missing or partial lists may hide additional calls/);
    }
  }
});
