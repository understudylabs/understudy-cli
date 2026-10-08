import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateExecution } from '../skills/build-evals/scripts/lib.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../skills/build-evals/scripts/eval.mjs', import.meta.url));
const demoAdapter = fileURLToPath(new URL('../skills/compare-models/templates/demo-adapter.mjs', import.meta.url));
const parse = async file => JSON.parse(await readFile(file, 'utf8'));

test('model variants use one frozen adapter and cannot change identity on resume', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-model-variants-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000 })).stdout);
  await run('init', '--name', 'parcel', '--mode', 'low', '--demo');
  const dir = path.join(root, '.understudy/evals/parcel');
  await writeFile(path.join(dir, 'adapter.mjs'), await readFile(demoAdapter), { mode: 0o600 });
  await run('validate', '--eval', dir);
  await run('run', '--eval', dir, '--run', 'baseline', '--model', 'synthetic/incumbent');
  await run('run', '--eval', dir, '--run', 'fast', '--model', 'synthetic/fast');
  const baseline = await parse(path.join(dir, 'results/baseline/run.json'));
  const fast = await parse(path.join(dir, 'results/fast/run.json'));
  assert.equal(baseline.fingerprint, fast.fingerprint);
  assert.equal(baseline.requestedModel, 'synthetic/incumbent');
  assert.equal(fast.requestedModel, 'synthetic/fast');
  const original = await readFile(path.join(dir, 'results/baseline/results.jsonl'), 'utf8');
  const rows = original.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 8);
  assert.ok(rows.every(row => row.receipt.calls[0].requestedModel === baseline.requestedModel));
  const summary = await parse(path.join(dir, 'results/baseline/summary.json'));
  assert.equal(summary.quality.fail, 2);
  await assert.rejects(run('run', '--eval', dir, '--run', 'baseline', '--model', 'synthetic/fast'), /different inputs, model, or settings/);
  await assert.rejects(run('run', '--eval', dir, '--run', 'baseline'), /different inputs, model, or settings/);
  await run('run', '--eval', dir, '--run', 'baseline', '--model', 'synthetic/incumbent');
  assert.equal(await readFile(path.join(dir, 'results/baseline/results.jsonl'), 'utf8'), original);
  await run('regrade', '--eval', dir, '--from', 'baseline', '--run', 'rescored');
  assert.equal((await parse(path.join(dir, 'results/rescored/run.json'))).requestedModel, baseline.requestedModel);
});

test('call receipts retain mixed models, unknowns and separate cost basis without breaking legacy executions', () => {
  const calls = [
    { requestId: 'synthetic-call-1', requestedModel: 'synthetic/a', servedModel: 'synthetic/a', fallbackUsed: false, costUsd: 0.02, costBasis: 'synthetic' },
    { requestId: 'synthetic-call-2', requestedModel: 'synthetic/a', servedModel: 'synthetic/b', fallbackUsed: true, costUsd: null },
    { requestId: null, requestedModel: 'synthetic/a', servedModel: null, fallbackUsed: null },
  ];
  const value = { output: 'invented', metrics: { costUsd: null }, receipt: { calls, callsComplete: true } };
  assert.deepEqual(validateExecution(value), value);
  assert.equal(value.metrics.costUsd, null, 'call estimates do not silently fill aggregate costs');
  assert.deepEqual(validateExecution({ output: null, receipt: { model: 'synthetic/a', requestIds: ['synthetic-call-1'] } }), { output: null, receipt: { model: 'synthetic/a', requestIds: ['synthetic-call-1'] } });
  for (const receipt of [
    { callsComplete: true },
    { calls, callsComplete: 'yes' },
    { calls: [calls[0], calls[0]] },
    { calls: [{ ...calls[0], costBasis: undefined }] },
    { calls: [{ ...calls[0], fallbackUsed: undefined }] },
    { calls: [{ ...calls[0], servedModel: '' }] },
    { calls, callsComplete: true, model: 'synthetic/a' },
    { calls: [calls[0]], callsComplete: true, requestIds: ['synthetic-call-2'] },
  ]) assert.throws(() => validateExecution({ output: null, receipt }));
});
