import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateCases, validateManifest } from '../skills/build-evals/scripts/lib.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../skills/build-evals/scripts/eval.mjs', import.meta.url));
const demoManifest = JSON.parse(await readFile(new URL('../skills/build-evals/templates/demo-eval.json', import.meta.url), 'utf8'));
const parse = async file => JSON.parse(await readFile(file, 'utf8'));
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const json = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
async function fixture(t, demo = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-eval-workload-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const call = async (...args) => {
    try { return { status: 0, ...await exec(process.execPath, [script, ...args], { cwd: root, env, timeout: 20000, maxBuffer: 2e6 }) }; }
    catch (error) { return { status: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  await ok('init', '--name', 'parcel', '--mode', 'low', ...(demo ? ['--demo'] : []));
  const relative = '.understudy/evals/parcel', directory = path.join(root, relative);
  return { root, directory, relative, call, ok, validate: () => ok('validate', '--eval', relative) };
}

test('manifest requires one complete declared workload identity', () => {
  assert.equal(validateManifest(structuredClone(demoManifest)).workload.source, 'synthetic');
  for (const field of ['source', 'organizationId', 'projectId', 'workloadId', 'name']) {
    const missing = structuredClone(demoManifest); delete missing.workload[field];
    assert.throws(() => validateManifest(missing), /workload/i);
    const blank = structuredClone(demoManifest); blank.workload[field] = '  ';
    assert.throws(() => validateManifest(blank), /workload/i);
  }
  const missing = structuredClone(demoManifest); delete missing.workload;
  assert.throws(() => validateManifest(missing), /workload/i);
  const unknown = structuredClone(demoManifest); unknown.workload.extra = 'invented';
  assert.throws(() => validateManifest(unknown), /workload/i);
});

test('starter initialization leaves workload resolution required before validation', async t => {
  const f = await fixture(t, false);
  const manifest = await parse(path.join(f.directory, 'manifest.json'));
  assert.deepEqual(manifest.workload, { source: 'understudy', organizationId: '', projectId: '', workloadId: '', name: '' });
  const result = await f.call('validate', '--eval', f.relative);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Workload organizationId must be nonempty/);
  await assert.rejects(lstat(path.join(f.directory, 'validation.json')), { code: 'ENOENT' });
});

test('synthetic workload declaration cannot contain trace-origin cases or source references', () => {
  const item = { id: 'invented', title: 'Wholly invented case', input: {}, expected: {}, origin: 'synthetic', sourceRefs: [], tags: [], split: 'regression' };
  assert.equal(validateCases([item], demoManifest.workload).length, 1);
  assert.throws(() => validateCases([{ ...item, origin: 'trace' }], demoManifest.workload), /Synthetic workloads require invented cases/);
  assert.throws(() => validateCases([{ ...item, sourceRefs: ['synthetic-reference'] }], demoManifest.workload), /Synthetic workloads require invented cases/);
});

test('offline demo freezes workload identity and regrade rejects every identity change', async t => {
  const f = await fixture(t); await f.validate();
  await f.ok('run', '--eval', f.relative, '--run', 'baseline');
  const manifestFile = path.join(f.directory, 'manifest.json'), original = await parse(manifestFile);
  const baselineFile = path.join(f.directory, 'results/baseline/run.json');
  assert.deepEqual((await parse(baselineFile)).manifest.workload, demoManifest.workload);
  assert.deepEqual((await parse(path.join(f.directory, 'results/baseline/summary.json'))).quality, { pass: 6, fail: 2, unscored: 0, pending: 0 });
  for (const [index, field] of ['source', 'organizationId', 'projectId', 'workloadId', 'name'].entries()) {
    const changed = structuredClone(original);
    changed.workload[field] = field === 'source' ? 'understudy' : `synthetic-other-${field}`;
    await json(manifestFile, changed); await f.validate();
    const runId = `blocked-${index}`, result = await f.call('regrade', '--eval', f.relative, '--from', 'baseline', '--run', runId);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /same workload identity/);
    await assert.rejects(lstat(path.join(f.directory, 'results', runId)), { code: 'ENOENT' });
  }
  await json(manifestFile, original); await f.validate();
  await f.ok('regrade', '--eval', f.relative, '--from', 'baseline', '--run', 'same-workload');
  assert.deepEqual((await parse(path.join(f.directory, 'results/same-workload/run.json'))).manifest.workload, original.workload);
  assert.deepEqual((await parse(baselineFile)).manifest.workload, original.workload);
});

test('adapter receives source workload identity while execution receipts may use a separate test scope', async t => {
  const f = await fixture(t), manifestFile = path.join(f.directory, 'manifest.json');
  const manifest = await parse(manifestFile);
  // All identities here are invented; no gateway, account, credential, or network is used.
  manifest.workload = { source: 'understudy', organizationId: 'synthetic-source-organization', projectId: 'synthetic-source-project', workloadId: 'synthetic-source-workload', name: 'Invented source task' };
  await json(manifestFile, manifest);
  await writeFile(path.join(f.directory, 'adapter.mjs'), `export async function run(task, context) {
    if ('expected' in task || 'observed' in task) throw new Error('Answer leakage');
    return { output: { price: (task.input.grams <= 500 ? 4 : 7) + (task.input.priority ? 3 : 0), sourceWorkload: context.workload },
      metrics: { costUsd: 0 }, receipt: { model: 'synthetic-offline-runner', scope: {
        organizationId: 'synthetic-test-organization', projectId: 'synthetic-test-project', workloadId: 'synthetic-test-workload' } } };
  }\n`);
  await f.validate(); await f.ok('run', '--eval', f.relative, '--run', 'separate-scope');
  const rows = await lines(path.join(f.directory, 'results/separate-scope/results.jsonl'));
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.status, 'ok');
    assert.deepEqual(row.output.sourceWorkload, manifest.workload);
    assert.equal(row.receipt.scope.workloadId, 'synthetic-test-workload');
    assert.notEqual(row.receipt.scope.workloadId, manifest.workload.workloadId);
  }
});
