import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../skills/build-evals/scripts/eval.mjs', import.meta.url));
const parse = async file => JSON.parse(await readFile(file, 'utf8'));
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const json = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const jsonl = (file, rows) => writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-eval-controls-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const call = async (...args) => {
    try { return { status: 0, ...await exec(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000, maxBuffer: 2e6 }) }; }
    catch (error) { return { status: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  await ok('init', '--name', 'parcel', '--mode', 'low', '--demo');
  return { directory: path.join(root, '.understudy/evals/parcel'), relative: '.understudy/evals/parcel', call, ok };
}

test('interaction controls grade full execution evidence and distinguish identical outputs with different tool use or receipts', async t => {
  const f = await fixture(t);
  const manifest = await parse(path.join(f.directory, 'manifest.json'));
  manifest.criteria = [
    { id: 'lookup-used', description: 'The invented stock lookup must be used.', required: true },
    { id: 'receipt-matches', description: 'The supplied model receipt must match the synthetic fixture.', required: true },
  ];
  await json(path.join(f.directory, 'manifest.json'), manifest);
  const execution = {
    output: { available: true },
    trace: [{ role: 'tool', name: 'lookup-stock', content: { sku: 'invented-sku', available: true } }],
    metrics: { costUsd: 0.25, judgeCostUsd: null, latencyMs: 12, modelLatencyMs: 8, inputTokens: 3, outputTokens: 2 },
    receipt: { model: 'synthetic-model', requestIds: ['synthetic-request'], scope: { environment: 'test', workload: 'synthetic-stock' } },
  };
  const item = { id: 'stock', title: 'Wholly invented stock lookup', input: { sku: 'invented-sku' }, expected: { available: true }, origin: 'synthetic', sourceRefs: [], tags: [], split: 'regression', observed: execution };
  await jsonl(path.join(f.directory, 'cases.jsonl'), [item]);
  const control = (id, evidence, lookup, receipt) => ({ id, caseId: item.id, execution: evidence, expectedVerdicts: { 'lookup-used': lookup, 'receipt-matches': receipt }, note: 'Wholly synthetic execution evidence for an interaction grader.' });
  const missingTool = structuredClone(execution); missingTool.trace = [];
  const wrongReceipt = structuredClone(execution); wrongReceipt.receipt.model = 'synthetic-other-model';
  await jsonl(path.join(f.directory, 'controls.jsonl'), [
    control('recorded-lookup', execution, 'pass', 'pass'),
    control('same-output-no-tool', missingTool, 'fail', 'pass'),
    control('same-output-wrong-receipt', wrongReceipt, 'pass', 'fail'),
  ]);
  await writeFile(path.join(f.directory, 'grader.mjs'), `export async function grade(item, execution) {
    const expectedMetrics = ${JSON.stringify(execution.metrics)};
    if (!execution.metrics || Object.entries(expectedMetrics).some(([key, value]) => execution.metrics[key] !== value)) throw new Error('Execution metrics were not preserved.');
    const used = execution.trace?.some(step => step.role === 'tool' && step.name === 'lookup-stock' && step.content.sku === item.input.sku && step.content.available === true);
    const received = execution.receipt?.model === 'synthetic-model' && execution.receipt.requestIds?.[0] === 'synthetic-request' && execution.receipt.scope?.environment === 'test' && execution.receipt.scope?.workload === 'synthetic-stock';
    return { verdicts: {
      'lookup-used': { status: used ? 'pass' : 'fail', reason: used ? 'Required synthetic lookup recorded.' : 'Required lookup absent.' },
      'receipt-matches': { status: received ? 'pass' : 'fail', reason: received ? 'Synthetic receipt matches.' : 'Synthetic receipt does not match.' }
    }, judge: { costUsd: 0 } };
  }\n`, { mode: 0o600 });
  await writeFile(path.join(f.directory, 'adapter.mjs'), `export async function run() { return ${JSON.stringify(execution)}; }\n`, { mode: 0o600 });
  const result = await f.ok('validate', '--eval', f.relative);
  assert.equal(result.passed, true);
  assert.deepEqual(result.coverage, { 'lookup-used': { pass: 2, fail: 1 }, 'receipt-matches': { pass: 2, fail: 1 } });
  for (const [command, run] of [['run', 'fresh'], ['grade', 'historical']]) {
    await f.ok(command, '--eval', f.relative, '--run', run);
    const rows = await lines(path.join(f.directory, 'results', run, 'results.jsonl'));
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].verdicts['lookup-used'].status, 'pass');
    assert.equal(rows[0].verdicts['receipt-matches'].status, 'pass');
    assert.deepEqual(rows[0].trace, execution.trace);
    assert.deepEqual(rows[0].receipt, execution.receipt);
  }
});

test('existing output-only controls retain their meaning, including a null output', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'controls.jsonl'), controls = await lines(file);
  controls.push({ id: 'null-output', caseId: controls[0].caseId, output: null, expectedVerdicts: { 'output-shape': 'fail', 'quote-correct': 'unscored' }, note: 'Null is an explicit output, not absent execution evidence.' });
  await jsonl(file, controls);
  const result = await f.ok('validate', '--eval', f.relative);
  assert.equal(result.passed, true);
  assert.equal(result.controls.length, controls.length);
});

test('controls reject ambiguous envelopes and malformed execution evidence before grading', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'controls.jsonl');
  const original = (await lines(file))[0], withoutOutput = structuredClone(original); delete withoutOutput.output;
  const invalid = [
    { ...original, execution: { output: original.output } },
    withoutOutput,
    { ...withoutOutput, execution: null },
    { ...withoutOutput, execution: { trace: [] } },
    { ...withoutOutput, execution: { output: original.output, trace: [{ role: 'tool', name: 'lookup-stock' }] } },
    { ...withoutOutput, execution: { output: original.output, receipt: { requestIds: 'synthetic-request' } } },
    { ...withoutOutput, execution: { output: original.output, metrics: { latencyMs: -1 } } },
    { ...withoutOutput, execution: { output: original.output, judge: { costUsd: 0 } } },
    { ...original, trace: [] },
  ];
  for (const row of invalid) {
    await jsonl(file, [row]);
    const result = await f.call('validate', '--eval', f.relative);
    assert.notEqual(result.status, 0, JSON.stringify(row));
    assert.match(result.stderr, /INVALID_EVAL|MISSING_OUTPUT/);
    assert.equal(result.stdout, '', 'Malformed controls must be rejected before producing grader results.');
  }
});
