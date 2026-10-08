import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { wilson95, calibrationReport, auditGroupedSplits, groupedBootstrap, retrievalMetrics }
  from '../skills/build-evals/scripts/measure.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../skills/build-evals/scripts/measure.mjs', import.meta.url));
const row = (id, human, predicted, split = 'test') => ({ id, groupId: id, split,
  human: { quality: human }, predicted: predicted ? { quality: predicted } : {}, reviewer: 'Synthetic reviewer' });

test('Wilson handles boundaries without false certainty and validates counts', () => {
  assert.deepEqual(wilson95(0, 0), { estimate: null, lower: null, upper: null, n: 0, method: 'wilson95' });
  const perfect = wilson95(10, 10);
  assert.equal(perfect.estimate, 1); assert.ok(Math.abs(perfect.lower - 0.7224672) < 1e-6);
  assert.ok(perfect.upper <= 1); assert.ok(wilson95(0, 10).upper > 0.27);
  for (const counts of [[2, 1], [-1, 2], [0.5, 2], [1, Infinity]]) assert.throws(() => wilson95(...counts));
});

test('calibration separates classes, non-decisions, human deferrals and missing labels', () => {
  const rows = [row('one', 'pass', 'pass'), row('two', 'pass', 'fail'), row('three', 'fail', 'fail'),
    row('four', 'fail', 'pass'), row('five', 'fail', 'unscored'), row('six', 'defer', 'error'),
    row('seven', 'pass', undefined), { ...row('eight', 'pass', 'pass'), human: {} }];
  const report = calibrationReport(rows, ['quality']), q = report.splits.test.quality;
  assert.equal(q.counts.total, 8); assert.equal(q.counts.deferred, 1); assert.equal(q.counts.missingHuman, 1);
  assert.equal(q.counts.errors, 1); assert.equal(q.counts.missingPrediction, 1);
  assert.equal(q.tpr.estimate, 0.5); assert.equal(q.tnr.estimate, 0.5);
  assert.deepEqual(q.coverage, { total: 8, labeled: 6, decided: 4, fractionOfLabeledDecided: 2 / 3 });
  assert.equal(q.byClass.pass.missing, 1); assert.equal(q.byClass.fail.unscored, 1);
  assert.equal(q.completeCoverage, false); assert.equal(report.splits.train.quality.tpr.estimate, null);
  assert.match(report.rateScope, /decisive/); assert.match(report.validationClaim, /not independently verified/);
});

test('calibration rejects leakage and invalid provenance, and withholds dependent-row intervals', () => {
  const one = row('one', 'pass', 'pass');
  assert.throws(() => auditGroupedSplits([one, one]), /Duplicate/);
  assert.throws(() => auditGroupedSplits([one, { ...row('two', 'fail', 'fail', 'dev'), groupId: 'one' }]), /crosses/);
  assert.throws(() => calibrationReport([{ ...one, reviewer: ' ' }], ['quality']), /reviewer/);
  assert.throws(() => calibrationReport([{ ...one, predicted: { quality: 'maybe' } }], ['quality']), /invalid predicted/);
  assert.throws(() => calibrationReport([one], ['other']), /Unknown criterion/);
  const related = calibrationReport([one, { ...row('two', 'fail', 'fail'), groupId: 'one' }], ['quality']);
  assert.equal(related.splits.test.quality.tpr.lower, null);
  assert.match(related.splits.test.quality.tpr.method, /related/);
});

test('bootstrap weights cases equally and preserves groups instead of counting trials as cases', () => {
  const rows = [{ caseId: 'a', groupId: 'a', rep: 0, value: 0 },
    { caseId: 'a', groupId: 'a', rep: 1, value: 1 }, { caseId: 'b', groupId: 'b', rep: 0, value: 1 }];
  const result = groupedBootstrap(rows, { seed: 17, draws: 1000 });
  assert.equal(result.estimate, 0.75); assert.equal(result.cases, 2); assert.equal(result.attempts, 3);
  assert.equal(result.lower, 0.5); assert.equal(result.upper, 1);
  assert.deepEqual(result, groupedBootstrap([...rows].reverse(), { seed: 17, draws: 1000 }));
  assert.equal(groupedBootstrap(rows.map(item => ({ ...item, groupId: 'related' }))).lower, null);
  assert.equal(groupedBootstrap(rows.map(item => ({ ...item, value: 1 }))).lower, null);
  assert.throws(() => groupedBootstrap([rows[0], rows[0]]), /Duplicate/);
  assert.throws(() => groupedBootstrap(rows, { seed: -1 }), /Seed/);
  assert.throws(() => groupedBootstrap(rows, { draws: 2 }), /Draws/);
});

test('retrieval metrics require explicit labels and account for all required evidence', () => {
  const input = { retrieved: ['b', 'a'], relevance: { a: 1, b: 0, c: 1 }, k: 2,
    labelsComplete: true, required: ['a', 'c'] };
  const result = retrievalMetrics(input);
  assert.equal(result.labelsComplete, true); assert.deepEqual(result.missingLabels, []);
  assert.equal(result.recallAtK, 0.5); assert.equal(result.precisionAtK, 0.5);
  assert.equal(result.reciprocalRank, 0.5); assert.equal(result.allRequired, false);
  assert.ok(Math.abs(result.nDCGAtK - ((1 / Math.log2(3)) / (1 + 1 / Math.log2(3)))) < 1e-12);
  const unknown = retrievalMetrics({ ...input, relevance: { a: 1, c: 1 } });
  assert.equal(unknown.recallAtK, null); assert.equal(unknown.precisionAtK, null);
  assert.equal(unknown.reciprocalRank, null); assert.deepEqual(unknown.missingLabels, ['b']);
  assert.equal(unknown.nDCGAtK, null); assert.equal(unknown.labelsComplete, false);
  const partial = retrievalMetrics({ ...input, labelsComplete: false });
  assert.equal(partial.recallAtK, null); assert.equal(partial.nDCGAtK, null);
  assert.equal(partial.precisionAtK, 0.5);
  assert.throws(() => retrievalMetrics({ ...input, retrieved: ['a', 'a'] }), /unique/);
  assert.throws(() => retrievalMetrics({ ...input, relevance: { a: -1 } }), /nonnegative/);
});

test('retrieval completeness cannot override missing required or retrieved labels', () => {
  const input = { retrieved: ['a'], relevance: { a: 1 }, k: 1,
    labelsComplete: true, required: ['a', 'b'] };
  const missingRequired = retrievalMetrics(input);
  assert.deepEqual(missingRequired.missingLabels, ['b']);
  assert.equal(missingRequired.labelsComplete, false);
  assert.equal(missingRequired.recallAtK, null); assert.equal(missingRequired.nDCGAtK, null);
  assert.equal(missingRequired.allRequired, null);
  assert.equal(missingRequired.precisionAtK, 1); assert.equal(missingRequired.reciprocalRank, 1);

  const missingRetrieved = retrievalMetrics({ ...input, retrieved: ['a', 'b'], k: 2 });
  assert.deepEqual(missingRetrieved.missingLabels, ['b']);
  assert.equal(missingRetrieved.labelsComplete, false);
  assert.equal(missingRetrieved.recallAtK, null); assert.equal(missingRetrieved.nDCGAtK, null);
  assert.equal(missingRetrieved.precisionAtK, null); assert.equal(missingRetrieved.reciprocalRank, null);
  assert.equal(missingRetrieved.allRequired, null);

  const outsideCutoff = retrievalMetrics({ ...input, retrieved: ['a', 'b'], required: ['a'] });
  assert.deepEqual(outsideCutoff.missingLabels, ['b']);
  assert.equal(outsideCutoff.labelsComplete, false);
  assert.equal(outsideCutoff.recallAtK, null); assert.equal(outsideCutoff.nDCGAtK, null);
  assert.equal(outsideCutoff.precisionAtK, 1); assert.equal(outsideCutoff.reciprocalRank, 1);
  assert.equal(outsideCutoff.allRequired, true);
});

test('complete retrieval labels retain perfect scores and distinguish zero denominators from no hits', () => {
  const input = { retrieved: ['a'], relevance: { a: 1, b: 0 }, k: 1,
    labelsComplete: true, required: ['a'] };
  const perfect = retrievalMetrics(input);
  assert.equal(perfect.labelsComplete, true); assert.deepEqual(perfect.missingLabels, []);
  assert.equal(perfect.recallAtK, 1); assert.equal(perfect.nDCGAtK, 1);
  assert.equal(perfect.precisionAtK, 1); assert.equal(perfect.reciprocalRank, 1);
  assert.equal(perfect.allRequired, true);

  const noRelevant = retrievalMetrics({ ...input, relevance: { a: 0, b: 0 }, required: [] });
  assert.equal(noRelevant.labelsComplete, true);
  assert.equal(noRelevant.recallAtK, null); assert.equal(noRelevant.nDCGAtK, null);
  assert.equal(noRelevant.precisionAtK, 0); assert.equal(noRelevant.reciprocalRank, 0);
  assert.equal(noRelevant.allRequired, null);

  const emptyLabels = retrievalMetrics({ ...input, retrieved: [], relevance: {}, required: [] });
  assert.equal(emptyLabels.recallAtK, null); assert.equal(emptyLabels.nDCGAtK, null);
  assert.equal(emptyLabels.precisionAtK, 0); assert.equal(emptyLabels.reciprocalRank, 0);

  const noHits = retrievalMetrics({ ...input, retrieved: [] });
  assert.equal(noHits.recallAtK, 0); assert.equal(noHits.nDCGAtK, 0);
  assert.equal(noHits.precisionAtK, 0); assert.equal(noHits.reciprocalRank, 0);
  assert.equal(noHits.allRequired, false);
});

test('calibrate writes private immutable reports bound to exact inputs without claiming test freshness', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-eval-measure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.understudy', 'evals', 'synthetic');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = { schemaVersion: 1, name: 'synthetic', mode: 'medium', description: 'Wholly invented test.',
    workload: { source: 'synthetic', organizationId: 'synthetic-org', projectId: 'synthetic-project', workloadId: 'synthetic-workload', name: 'Synthetic | <parcel>' },
    purpose: 'selected-regression', rubricStatus: 'confirmed', selection: { method: 'invented', limitations: ['Synthetic only.'] },
    criteria: [{ id: 'quality', description: 'An invented requirement.', required: true }], adapter: 'adapter.mjs',
    grader: 'grader.mjs', fingerprintFiles: [], settings: { repetitions: 1, timeoutMs: 1000 } };
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  const source = [row('one', 'pass', 'pass'), row('two', 'fail', 'fail')].map(JSON.stringify).join('\n') + '\n';
  await writeFile(path.join(directory, 'manifest.json'), manifestBytes, { mode: 0o600 });
  await writeFile(path.join(directory, 'calibration.jsonl'), source, { mode: 0o600 });
  const args = [script, 'calibrate', '--eval', '.understudy/evals/synthetic', '--id', 'check-one'];
  const run = await execute(process.execPath, args, { cwd: root });
  const outputs = JSON.parse(run.stdout), reportFile = path.join(directory, outputs.report);
  const saved = await readFile(reportFile, 'utf8'), report = JSON.parse(saved);
  assert.equal(report.source.sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(report.manifest.sha256, createHash('sha256').update(manifestBytes).digest('hex'));
  assert.deepEqual(report.workload, manifest.workload);
  assert.equal(report.splits.test.quality.tpr.estimate, 1); assert.match(report.testFreshness, /Unverified/);
  assert.match(await readFile(path.join(directory, outputs.markdown), 'utf8'), /Decided \/ labeled \/ selected/);
  assert.ok((await readFile(path.join(directory, outputs.markdown), 'utf8')).includes('Synthetic \\| \\<parcel\\>'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(reportFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(reportFile))).mode & 0o777, 0o700);
  }
  await assert.rejects(execute(process.execPath, args, { cwd: root }), /already exists/);
  assert.equal(await readFile(reportFile, 'utf8'), saved);
  await writeFile(path.join(directory, 'calibration.jsonl'), source.trimEnd(), { mode: 0o600 });
  await assert.rejects(execute(process.execPath, [...args.slice(0, -1), 'check-two'], { cwd: root }), /newline/);
});
