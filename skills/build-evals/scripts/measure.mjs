#!/usr/bin/env node
/** Offline measurements; no model calls.
 * wilson95(successes,total) -> estimate/lower/upper (null for no observations).
 * calibrationReport(rows,criterionIds) -> split/criterion counts and conditional rates.
 * auditGroupedSplits(rows) rejects duplicate IDs and related groups across splits.
 * groupedBootstrap([{caseId,groupId,rep:0,value:1}],{seed:1,draws:2000})
 * averages trials within cases, then resamples independent groups, keeping cases together.
 * retrievalMetrics({retrieved:['a'],relevance:{a:1,b:0},k:1,labelsComplete:true,required:['a']})
 * uses explicit zero labels for irrelevant items; missing labels are unknown.
 * Effective labelsComplete also requires labels for every retrieved and required ID.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { privatePath, resolveEval, validateManifest, validateRunId, writePrivate } from './lib.mjs';

const splits = ['train', 'dev', 'test'];
const humanLabels = ['pass', 'fail', 'defer'];
const predictions = ['pass', 'fail', 'unscored', 'error'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const average = values => {
  const result = values.reduce((sum, value) => sum + value / values.length, 0);
  requireThat(Number.isFinite(result), 'Metric magnitudes exceed supported numeric precision.');
  return result;
};

export function wilson95(successes, total) {
  requireThat(Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(successes)
    && successes >= 0 && successes <= total, 'Counts must be integers with 0 <= successes <= total.');
  if (!total) return { estimate: null, lower: null, upper: null, n: 0, method: 'wilson95' };
  const z = 1.959963984540054, p = successes / total, scale = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / scale;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / scale;
  return { estimate: p, lower: Math.max(0, center - half), upper: Math.min(1, center + half), n: total, method: 'wilson95' };
}

export function auditGroupedSplits(rows) {
  requireThat(Array.isArray(rows), 'Rows must be an array.');
  const ids = new Set(), groups = new Map();
  const counts = Object.fromEntries(splits.map(split => [split, { rows: 0, groups: 0 }]));
  for (const row of rows) {
    requireThat(object(row) && text(row.id) && text(row.groupId) && splits.includes(row.split),
      'Every row needs a nonempty id, groupId, and train/dev/test split.');
    requireThat(!ids.has(row.id), 'Duplicate example ID.');
    requireThat(!groups.has(row.groupId) || groups.get(row.groupId) === row.split, 'A related group crosses splits.');
    ids.add(row.id);
    if (!groups.has(row.groupId)) counts[row.split].groups++;
    groups.set(row.groupId, row.split);
    counts[row.split].rows++;
  }
  return { rows: rows.length, groups: groups.size, splits: counts };
}

export function calibrationReport(rows, criterionIds) {
  const grouping = auditGroupedSplits(rows);
  requireThat(Array.isArray(criterionIds) && criterionIds.length > 0 && criterionIds.every(text)
    && new Set(criterionIds).size === criterionIds.length, 'Criteria must be nonempty unique IDs.');
  for (const row of rows) {
    requireThat(text(row.reviewer), 'Every human annotation requires a nonempty reviewer.');
    requireThat(object(row.human) && object(row.predicted), 'Human and predicted labels must be objects.');
    for (const [key, label] of Object.entries(row.human))
      requireThat(criterionIds.includes(key) && humanLabels.includes(label), 'Unknown criterion or invalid human label.');
    for (const [key, label] of Object.entries(row.predicted))
      requireThat(criterionIds.includes(key) && predictions.includes(label), 'Unknown criterion or invalid predicted label.');
    requireThat(row.reason === undefined || typeof row.reason === 'string', 'Annotation reason must be text.');
  }
  const result = {};
  for (const split of splits) {
    result[split] = {};
    for (const criterion of criterionIds) {
      const selected = rows.filter(row => row.split === split);
      const counts = { total: selected.length, humanPass: 0, humanFail: 0, deferred: 0, missingHuman: 0,
        predictedPass: 0, predictedFail: 0, unscored: 0, errors: 0, missingPrediction: 0,
        truePass: 0, falseFail: 0, trueFail: 0, falsePass: 0 };
      const byClass = { pass: { total: 0, decided: 0, unscored: 0, errors: 0, missing: 0 },
        fail: { total: 0, decided: 0, unscored: 0, errors: 0, missing: 0 } };
      for (const row of selected) {
        const h = row.human[criterion], p = row.predicted[criterion];
        counts[h === 'pass' ? 'humanPass' : h === 'fail' ? 'humanFail' : h === 'defer' ? 'deferred' : 'missingHuman']++;
        counts[p === 'pass' ? 'predictedPass' : p === 'fail' ? 'predictedFail' : p === 'unscored' ? 'unscored' : p === 'error' ? 'errors' : 'missingPrediction']++;
        if (h !== 'pass' && h !== 'fail') continue;
        byClass[h].total++;
        if (p !== 'pass' && p !== 'fail') {
          byClass[h][p === 'unscored' ? 'unscored' : p === 'error' ? 'errors' : 'missing']++;
          continue;
        }
        byClass[h].decided++;
        counts[h === 'pass' ? (p === 'pass' ? 'truePass' : 'falseFail') : (p === 'fail' ? 'trueFail' : 'falsePass')]++;
      }
      const decided = counts.truePass + counts.falseFail + counts.trueFail + counts.falsePass;
      const labeled = counts.humanPass + counts.humanFail;
      const independent = new Set(selected.map(row => row.groupId)).size === selected.length;
      const rate = (correct, n) => {
        const value = wilson95(correct, n);
        return independent ? value : { ...value, lower: null, upper: null, method: 'interval-unavailable-related-rows' };
      };
      Object.defineProperty(result[split], criterion, { enumerable: true, value: {
        counts, byClass, coverage: { labeled, decided, total: counts.total,
          fractionOfLabeledDecided: labeled ? decided / labeled : null },
        tpr: rate(counts.truePass, counts.truePass + counts.falseFail),
        tnr: rate(counts.trueFail, counts.trueFail + counts.falsePass),
        completeCoverage: counts.total > 0 && labeled === counts.total && decided === labeled
          && counts.humanPass > 0 && counts.humanFail > 0,
      } });
    }
  }
  return { schemaVersion: 1, grouping, splits: result,
    rateScope: 'TPR/TNR condition on decisive predictions and binary human labels; exclusions are reported separately.',
    intervalScope: 'Wilson intervals require independent rows; related rows have no interval here.',
    validationClaim: 'No acceptance threshold applied. Reviewer identity, prediction provenance, and held-out freshness are supplied, not independently verified.' };
}

export function groupedBootstrap(rows, { seed = 1, draws = 2000 } = {}) {
  requireThat(Array.isArray(rows) && rows.length > 0, 'Bootstrap needs observed rows.');
  requireThat(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'Seed must be an unsigned 32-bit integer.');
  requireThat(Number.isInteger(draws) && draws >= 100 && draws <= 100000, 'Draws must be an integer from 100 to 100000.');
  const cases = new Map(), seen = new Set();
  for (const row of rows) {
    requireThat(object(row) && text(row.caseId) && text(row.groupId) && Number.isFinite(row.value)
      && Number.isSafeInteger(row.rep ?? 0) && (row.rep ?? 0) >= 0, 'Invalid bootstrap row.');
    const key = JSON.stringify([row.caseId, row.rep ?? 0]);
    requireThat(!seen.has(key), 'Duplicate case/repetition.');
    seen.add(key);
    const entry = cases.get(row.caseId) ?? { groupId: row.groupId, values: [] };
    requireThat(entry.groupId === row.groupId, 'One case cannot belong to multiple groups.');
    entry.values.push({ rep: row.rep ?? 0, value: row.value });
    cases.set(row.caseId, entry);
  }
  const groups = new Map();
  for (const [id, entry] of [...cases].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const values = groups.get(entry.groupId) ?? [];
    values.push(average(entry.values.sort((a, b) => a.rep - b.rep).map(row => row.value)));
    groups.set(entry.groupId, values);
  }
  const independent = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, values]) => values);
  const output = { estimate: average(independent.flat()), lower: null, upper: null, cases: cases.size,
    groups: groups.size, attempts: rows.length, draws, seed, method: 'group-percentile-bootstrap95', warning: null };
  if (groups.size < 2) return { ...output, warning: 'Fewer than two independent groups; uncertainty is not estimable.' };
  let state = seed;
  const samples = [];
  for (let draw = 0; draw < draws; draw++) {
    const selected = [];
    for (let i = 0; i < independent.length; i++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const group = independent[Math.floor((state / 4294967296) * independent.length)];
      for (const value of group) selected.push(value);
    }
    samples.push(average(selected));
  }
  samples.sort((a, b) => a - b);
  if (samples[0] === samples.at(-1)) return { ...output, warning: 'Degenerate resampling; equal observed scores do not establish zero uncertainty.' };
  const quantile = p => {
    const index = (samples.length - 1) * p, lower = Math.floor(index), fraction = index - lower;
    return samples[lower] * (1 - fraction) + samples[Math.ceil(index)] * fraction;
  };
  return { ...output, lower: quantile(0.025), upper: quantile(0.975) };
}

export function retrievalMetrics({ retrieved, relevance, k, labelsComplete = false, required = [] }) {
  requireThat(Array.isArray(retrieved) && retrieved.every(text) && new Set(retrieved).size === retrieved.length,
    'Retrieved IDs must be unique nonempty strings.');
  requireThat(object(relevance) && Object.values(relevance).every(value => Number.isFinite(value) && value >= 0),
    'Relevance must map IDs to finite nonnegative scores; omit unknown labels.');
  requireThat(Number.isSafeInteger(k) && k > 0 && typeof labelsComplete === 'boolean', 'Invalid retrieval cutoff or completeness flag.');
  requireThat(Array.isArray(required) && required.every(text) && new Set(required).size === required.length, 'Required IDs must be unique.');
  const top = retrieved.slice(0, k), known = id => Object.hasOwn(relevance, id);
  const missingLabels = [...new Set([...retrieved, ...required].filter(id => !known(id)))];
  const complete = labelsComplete && missingLabels.length === 0;
  const topKnown = top.every(known), hits = top.filter(id => known(id) && relevance[id] > 0).length;
  const relevantCount = Object.values(relevance).filter(value => value > 0).length;
  const maxGain = Object.values(relevance).reduce((max, value) => Math.max(max, value), 0);
  const dcg = values => values.reduce((sum, value, index) => sum + (maxGain ? value / maxGain : 0) / Math.log2(index + 2), 0);
  const ideal = dcg(Object.values(relevance).sort((a, b) => b - a).slice(0, k));
  const first = top.findIndex(id => known(id) && relevance[id] > 0);
  return { k, returned: top.length, missingLabels, labelsComplete: complete,
    recallAtK: complete && relevantCount ? hits / relevantCount : null,
    precisionAtK: topKnown ? hits / k : null,
    reciprocalRank: topKnown ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    nDCGAtK: complete && ideal > 0 ? dcg(top.map(id => relevance[id])) / ideal : null,
    allRequired: required.length && required.every(id => known(id) && relevance[id] > 0)
      ? required.every(id => top.includes(id)) : null };
}

/** Read supplied human labels and saved judge predictions, never invoke a model.
 * node measure.mjs calibrate --eval .understudy/evals/<name> --id <new-slug>
 * Returns report paths. The immutable report binds exact calibration and manifest bytes.
 */
export async function calibrate(evalPath, id) {
  validateRunId(id);
  const directory = await resolveEval(evalPath);
  const manifestFile = path.join(directory, 'manifest.json'), sourceFile = path.join(directory, 'calibration.jsonl');
  await privatePath(manifestFile); await privatePath(sourceFile);
  const [manifestBytes, sourceBytes] = await Promise.all([readFile(manifestFile), readFile(sourceFile)]);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
  requireThat(manifest.name === path.basename(directory), 'Manifest name does not match the eval directory.');
  const source = sourceBytes.toString('utf8');
  requireThat(source.endsWith('\n'), 'Calibration JSONL must end with a newline.');
  const rows = source.split('\n').filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid calibration JSON on line ${index + 1}.`); }
  });
  requireThat(rows.length > 0, 'Calibration has no examples.');
  const report = calibrationReport(rows, manifest.criteria.map(criterion => criterion.id));
  report.id = id;
  report.workload = manifest.workload;
  report.source = { file: 'calibration.jsonl', sha256: createHash('sha256').update(sourceBytes).digest('hex') };
  report.manifest = { file: 'manifest.json', sha256: createHash('sha256').update(manifestBytes).digest('hex') };
  report.createdAt = new Date().toISOString();
  report.testFreshness = 'Unverified: this command cannot establish that test examples were unseen or unused before this run.';
  const format = metric => metric.estimate === null ? 'Unknown (n=0)' :
    `${metric.estimate.toFixed(3)} (n=${metric.n})${metric.lower === null ? '; interval unavailable' : ` [${metric.lower.toFixed(3)}, ${metric.upper.toFixed(3)}]`}`;
  const cell = value => String(value).replace(/\s+/g, ' ').replace(/[\\`*_[\]<>#|]/g, '\\$&');
  const markdown = ['# Grader calibration', '', '## Source workload', '', '| Identity | Value |', '| --- | --- |',
    ...Object.entries(report.workload).map(([field, value]) => `| ${field} | ${cell(value)} |`), '',
    report.validationClaim, '', report.testFreshness, '', report.rateScope,
    '', report.intervalScope, '', 'Rates below exclude non-decisions. Inspect coverage before using them.', '',
    '| Split | Criterion | Decided / labeled / selected | TPR | TNR | Deferred | Unscored / errors / missing predictions |',
    '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const split of splits) for (const [criterion, value] of Object.entries(report.splits[split])) {
    const c = value.counts, coverage = value.coverage;
    markdown.push(`| ${split} | ${criterion} | ${coverage.decided} / ${coverage.labeled} / ${coverage.total} | ${format(value.tpr)} | ${format(value.tnr)} | ${c.deferred} | ${c.unscored} / ${c.errors} / ${c.missingPrediction} |`);
  }
  markdown.push('', 'Class-specific excluded predictions and all confusion counts are in report.json.', '',
    `Calibration SHA-256: ${report.source.sha256}`, '', `Manifest SHA-256: ${report.manifest.sha256}`, '');
  await privatePath(path.join(directory, 'calibration', '.placeholder'), true);
  const output = path.join(directory, 'calibration', id);
  try { await mkdir(output, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Calibration report ID already exists; choose a new ID.'); throw error; }
  await writePrivate(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, true);
  await writePrivate(path.join(output, 'report.md'), markdown.join('\n'), true);
  return { report: path.relative(directory, path.join(output, 'report.json')),
    markdown: path.relative(directory, path.join(output, 'report.md')) };
}

async function main(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    process.stdout.write('Usage: node measure.mjs calibrate --eval .understudy/evals/<name> --id <new-slug>\n');
    return;
  }
  requireThat(argv[0] === 'calibrate', 'Unknown measurement command.');
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    requireThat(['--eval', '--id'].includes(argv[i]) && text(argv[i + 1]) && !Object.hasOwn(options, argv[i]), 'Expected unique --eval and --id options.');
    options[argv[i]] = argv[i + 1];
  }
  requireThat(text(options['--eval']) && text(options['--id']), 'Supply --eval and --id.');
  process.stdout.write(`${JSON.stringify(await calibrate(options['--eval'], options['--id']))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; });
