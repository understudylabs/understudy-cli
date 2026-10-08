import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const evalScript = path.join(root, 'skills/build-evals/scripts/eval.mjs');
const compareScript = path.join(root, 'skills/compare-models/scripts/compare.mjs');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
const writeRows = (file, values) => writeFile(file, values.map(value => JSON.stringify(value)).join('\n') + (values.length ? '\n' : ''), { mode: 0o600 });

async function fixture(t) {
  const app = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-model-comparison-')));
  t.after(() => rm(app, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: app, USERPROFILE: app, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const invoke = (script, args) => exec(process.execPath, [script, ...args], { cwd: app, env, timeout: 30000 });
  await invoke(evalScript, ['init', '--name', 'synthetic-eval', '--mode', 'low', '--demo']);
  const evalDir = path.join(app, '.understudy/evals/synthetic-eval');
  const manifest = await json(path.join(evalDir, 'manifest.json'));
  const cases = (await readFile(path.join(evalDir, 'cases.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  await mkdir(path.join(evalDir, 'results'), { mode: 0o700 });
  const sources = [];
  for (const id of ['baseline', 'candidate']) {
    const directory = path.join(evalDir, 'results', id), requestedModel = `synthetic/${id}`;
    await mkdir(directory, { mode: 0o700 });
    const run = { schemaVersion: 1, id, kind: 'fresh', requestedModel, manifest: structuredClone(manifest), startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', fingerprint: 'a'.repeat(64), repetitions: 1, plannedCases: cases.length, plannedAttempts: cases.length };
    const rows = cases.map((item, index) => ({ schemaVersion: 1, caseId: item.id, repetition: 1, status: 'ok', output: { quote: index }, verdicts: Object.fromEntries(manifest.criteria.map(criterion => [criterion.id, { status: index === (id === 'baseline' ? 0 : 1) ? 'fail' : 'pass', reason: 'Wholly invented example verdict.' }])), metrics: { costUsd: id === 'baseline' ? 0.1 : 0.05, latencyMs: 20 }, receipt: { callsComplete: true, calls: [{ requestId: `synthetic-${id}-${index}`, requestedModel, servedModel: requestedModel, fallbackUsed: false, costUsd: id === 'baseline' ? 0.1 : 0.05, costBasis: 'synthetic' }] } }));
    sources.push({ directory, run, cases: structuredClone(cases), rows, executions: [] });
  }
  async function save() {
    for (const source of sources) {
      await writeJson(path.join(source.directory, 'run.json'), source.run);
      await writeRows(path.join(source.directory, 'cases.jsonl'), source.cases);
      await writeRows(path.join(source.directory, 'results.jsonl'), source.rows);
      await writeRows(path.join(source.directory, 'executions.jsonl'), source.executions);
    }
  }
  const compare = async (name = 'synthetic-comparison', script = compareScript, args = []) => {
    await save();
    return invoke(script, ['--name', name, '--baseline', sources[0].directory, '--candidate', sources[1].directory, ...args]);
  };
  return { app, env, evalDir, sources, save, compare, invoke };
}

test('offline comparison pairs frozen rows, preserves provenance and writes private standalone reports', async t => {
  const f = await fixture(t);
  // These files must never be imported or executed by a report helper.
  await writeFile(path.join(f.evalDir, f.sources[0].run.manifest.adapter), 'throw new Error("Application must not execute");\n', { mode: 0o600 });
  await writeFile(path.join(f.evalDir, f.sources[0].run.manifest.grader), 'throw new Error("Grader must not execute");\n', { mode: 0o600 });
  const result = JSON.parse((await f.compare()).stdout);
  const summary = await json(result.summary);
  assert.deepEqual(summary.pairs[0].counts, { both_pass: 6, both_fail: 0, regression: 1, improvement: 1, unscored: 0, unverified_model: 0, pending: 0 });
  assert.equal(summary.runs[0].identity.verified, 8);
  assert.equal(summary.runs[1].callEvidence.recorded, 8);
  assert.equal(summary.runs[1].applicationCost.observed, 8);
  assert.equal(summary.runs[1].applicationCost.complete, true);
  assert.match(summary.runs[0].sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(path.isAbsolute(summary.runs[0].sourcePath), false);
  const html = await readFile(result.html, 'utf8');
  assert.match(html, /id="candidate"/);
  assert.match(html, /id="outcome"/);
  assert.match(html, /id="search"/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=/i);
  assert.match(await readFile(result.markdown, 'utf8'), /Checks and full evidence/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
    for (const file of [result.html, result.markdown, result.summary]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  await assert.rejects(f.compare(), /already exists/);
});

test('unknown and fallback identities remain visible without claiming candidate improvements or hiding costs', async t => {
  const f = await fixture(t), candidate = f.sources[1];
  candidate.rows[0].receipt.calls[0].servedModel = 'synthetic/fallback';
  candidate.rows[0].receipt.calls[0].fallbackUsed = true;
  candidate.rows[1].receipt = { model: candidate.run.requestedModel };
  candidate.rows[2].receipt.callsComplete = false;
  candidate.rows[3].receipt.calls[0].servedModel = null;
  candidate.rows[4].metrics.costUsd = null;
  candidate.rows[4].receipt.calls[0].costUsd = null;
  const result = JSON.parse((await f.compare()).stdout), summary = await json(result.summary);
  assert.equal(summary.pairs[0].counts.improvement, 0);
  assert.equal(summary.pairs[0].counts.regression, 0);
  assert.equal(summary.pairs[0].counts.unverified_model, 4);
  assert.equal(summary.runs[1].summary.quality.pass, 7, 'raw checks remain distinct from verified candidate outcomes');
  assert.deepEqual(summary.runs[1].identity, { verified: 4, mismatch: 1, unknown: 3, missing: 0 });
  assert.equal(summary.runs[1].applicationCost.observed, 7);
  assert.equal(summary.runs[1].applicationCost.complete, false);
  assert.ok(Math.abs(summary.runs[1].applicationCost.sum - 0.35) < 1e-9);
  assert.match(await readFile(result.html, 'utf8'), /incomplete/);
  assert.match(await readFile(result.html, 'utf8'), /synthetic\/fallback/);
});

test('fixed auxiliary models require responsibility-aware comparison without attributing raw checks to a candidate', async t => {
  const f = await fixture(t);
  for (const source of f.sources) {
    for (const [index, row] of source.rows.entries()) {
      row.receipt.calls.push({ requestId: `synthetic-${source.run.id}-classifier-${index}`, requestedModel: 'synthetic/fixed-classifier', servedModel: 'synthetic/fixed-classifier', fallbackUsed: false, costUsd: 0, costBasis: 'synthetic' });
    }
  }
  const result = JSON.parse((await f.compare()).stdout), summary = await json(result.summary);
  assert.deepEqual(summary.pairs[0].counts, { both_pass: 0, both_fail: 0, regression: 0, improvement: 0, unscored: 0, unverified_model: 8, pending: 0 });
  for (const run of summary.runs) {
    assert.equal(run.identity.verified, 0);
    assert.equal(run.summary.quality.pass, 7, 'recorded checks survive even though attribution is outside helper scope');
    assert.equal(run.summary.quality.fail, 1);
    assert.equal(run.callEvidence.recorded, 16, 'fixed dependencies remain in the evidence');
    assert.equal(run.applicationCost.observed, 8);
    for (const attempt of run.attempts) {
      assert.match(attempt.identity.reason, /native comparison viewer that attributes calls by responsibility/);
      assert.equal(attempt.receipt.calls[1].servedModel, 'synthetic/fixed-classifier');
    }
  }
  assert.equal(summary.pairs[0].rows[0].baseline.quality, 'fail');
  assert.equal(summary.pairs[0].rows[0].candidate.quality, 'pass');
  assert.equal(summary.pairs[0].rows[1].baseline.quality, 'pass');
  assert.equal(summary.pairs[0].rows[1].candidate.quality, 'fail');
  const html = await readFile(result.html, 'utf8');
  assert.doesNotMatch(html, /data-category="(?:regression|improvement)"/);
  assert.match(html, /native comparison viewer that attributes calls by responsibility/);
});

test('execution errors, human-unscored results and pending checkpoints preserve evidence and known spending', async t => {
  const f = await fixture(t), candidate = f.sources[1];
  candidate.rows[0] = { ...candidate.rows[0], status: 'timeout', error: { code: 'SYNTHETIC_TIMEOUT', message: 'Invented timeout.' } };
  delete candidate.rows[0].verdicts;
  for (const verdict of Object.values(candidate.rows[1].verdicts)) verdict.status = 'unscored';
  const checkpoint = candidate.rows.pop();
  delete checkpoint.verdicts;
  checkpoint.metrics.latencyMs = 250;
  candidate.executions.push(checkpoint);
  candidate.executions.push(structuredClone(candidate.rows[2]));
  const result = JSON.parse((await f.compare()).stdout), summary = await json(result.summary);
  assert.equal(summary.pairs[0].counts.unscored, 2);
  assert.equal(summary.pairs[0].counts.pending, 1);
  assert.equal(summary.runs[1].summary.execution.timeout, 1);
  assert.equal(summary.runs[1].applicationCost.pendingExecutionsIncluded, 1);
  assert.equal(summary.runs[1].applicationCost.observed, 8);
  assert.deepEqual(summary.runs[1].applicationLatencyMs, { observed: 8, planned: 8, complete: true, pendingExecutionsIncluded: 1, min: 20, median: 20, p90: 250, max: 250, mean: 48.75 });
  assert.match(await readFile(result.html, 'utf8'), /20.0 ms median \(8\/8 attempts\)/);
  const pending = summary.runs[1].attempts.at(-1);
  assert.equal(pending.executionStatus, 'grading_pending');
  assert.equal(pending.quality, 'pending');
  assert.equal(pending.outputRecorded, true);
  assert.deepEqual(pending.output, checkpoint.output);
});

test('task timing includes executions awaiting grading while missing timings stay unknown', async t => {
  const f = await fixture(t);
  for (const source of f.sources) {
    source.executions = source.rows.map(({ verdicts, ...row }) => row);
    source.rows = [];
    for (const row of source.executions) delete row.metrics.latencyMs;
  }
  f.sources[1].executions[0].metrics.latencyMs = 0;
  f.sources[1].executions[1].metrics.latencyMs = 250;
  const result = JSON.parse((await f.compare()).stdout), summary = await json(result.summary);
  assert.equal(summary.runs[0].applicationLatencyMs.median, null);
  assert.equal(summary.runs[0].applicationLatencyMs.observed, 0);
  assert.deepEqual(summary.runs[1].applicationLatencyMs, { observed: 2, planned: 8, complete: false, pendingExecutionsIncluded: 2, min: 0, median: 125, p90: 250, max: 250, mean: 125 });
  assert.equal(summary.runs[1].summary.quality.pending, 8, 'Timing evidence must not imply grading completed.');
  assert.match(await readFile(result.html, 'utf8'), /125.0 ms median \(2\/8 attempts; incomplete\)/);
});

test('unknown costs remain null and known zero is preserved without summing call and task costs twice', async t => {
  const f = await fixture(t);
  for (const row of f.sources[0].rows) { delete row.metrics.costUsd; row.receipt.calls[0].costUsd = 999; }
  for (const row of f.sources[1].rows) { row.metrics.costUsd = 0; row.judge = { costUsd: 0.01, model: 'synthetic/judge' }; }
  const result = JSON.parse((await f.compare()).stdout), summary = await json(result.summary);
  assert.equal(summary.runs[0].applicationCost.sum, null);
  assert.equal(summary.runs[0].applicationCost.observed, 0);
  assert.equal(summary.runs[1].applicationCost.sum, 0);
  assert.equal(summary.runs[1].applicationCost.complete, true);
  assert.ok(Math.abs(summary.runs[1].summary.judgeCostUsd.sum - 0.08) < 1e-9);
});

test('different tenants, cases, checks and run configurations are rejected before any report is written', async t => {
  for (const [label, mutate, pattern] of [
    ['workload', source => { source.run.manifest.workload.organizationId = 'synthetic-other-org'; }, /different workloads/],
    ['input', source => { source.cases[0].input = { wholly: 'different invented task' }; }, /Frozen cases/],
    ['expected', source => { source.cases[0].expected = { wholly: 'different expected result' }; }, /Frozen cases/],
    ['grader', source => { source.run.fingerprint = 'b'.repeat(64); }, /fingerprint/],
    ['criteria', source => { source.run.manifest.criteria[0].description += ' Different rule.'; }, /fingerprint/],
    ['settings', source => { source.run.manifest.settings.timeoutMs += 1; }, /fingerprint/],
    ['legacy', source => { delete source.run.requestedModel; }, /frozen requestedModel/],
    ['historical', source => { source.run.kind = 'historical'; }, /fresh run/],
  ]) await t.test(label, async t => {
    const f = await fixture(t);
    mutate(f.sources[1]);
    await assert.rejects(f.compare(), pattern);
    await assert.rejects(stat(path.join(f.app, '.understudy/comparisons/synthetic-comparison')), /ENOENT/);
  });
});

test('duplicate attempts, request identities and directories cannot inflate the comparison', async t => {
  for (const [label, mutate, pattern] of [
    ['attempt', source => source.rows.push(structuredClone(source.rows[0])), /duplicate/],
    ['call', source => { source.rows[1].receipt.calls[0].requestId = source.rows[0].receipt.calls[0].requestId; }, /same request ID/],
    ['cross-run', source => { source.rows[0].receipt.calls[0].requestId = 'synthetic-baseline-0'; }, /same request ID/],
  ]) await t.test(label, async t => {
    const f = await fixture(t);
    mutate(f.sources[1]);
    await assert.rejects(f.compare(), pattern);
  });
  const f = await fixture(t);
  await assert.rejects(f.compare('synthetic-duplicate', compareScript, ['--candidate', f.sources[0].directory]), /same run directory/);
});

test('hostile evidence is escaped and cannot execute from the report', async t => {
  const f = await fixture(t), hostile = '</script><script>globalThis.syntheticAttack=1</script><img src="https://example.test/pixel">';
  f.sources[1].rows[0].output = hostile;
  f.sources[1].rows[0].trace = [{ role: 'tool', content: hostile }];
  const result = JSON.parse((await f.compare()).stdout), html = await readFile(result.html, 'utf8');
  assert.doesNotMatch(html, /<script>globalThis\.syntheticAttack/);
  assert.doesNotMatch(html, /<img src=/);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;/);
  assert.equal((html.match(/<script>/g) ?? []).length, 1, 'only the fixed presentation script is executable');
  assert.equal((await json(result.summary)).runs[1].attempts[0].output, hostile);
});

test('generated report control logic selects candidates, regressions and searched evidence', async t => {
  const f = await fixture(t);
  const result = JSON.parse((await f.compare()).stdout), html = await readFile(result.html, 'utf8');
  // Execute only our fixed presentation script against a small document double.
  // This tests event wiring and filters; it is not a browser-rendering test.
  const controls = Object.fromEntries(['candidate', 'outcome', 'search', 'print', 'count'].map(id => [id, {
    value: id === 'candidate' ? 'candidate' : '', textContent: '', listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
  }]));
  const node = (dataset, textContent = '') => ({ dataset, textContent, hidden: false, classList: { toggle(_name, value) { this.owner.hidden = value; } } });
  const pairs = [...html.matchAll(/<section class="pair" data-candidate="([^"]+)">([\s\S]*?)(?=<section class="pair"|<\/main>)/g)].map(match => {
    const pair = node({ candidate: match[1] }); pair.classList.owner = pair;
    pair.cards = [...match[2].matchAll(/<article class="case" data-category="([^"]+)">([\s\S]*?)<\/article>/g)].map(cardMatch => {
      const card = node({ category: cardMatch[1] }, cardMatch[2].replace(/<[^>]+>/g, ' ')); card.classList.owner = card; return card;
    });
    pair.querySelectorAll = () => pair.cards;
    return pair;
  });
  let printed = false;
  const document = { querySelector: selector => controls[selector.slice(1)], getElementById: id => controls[id], querySelectorAll: () => pairs };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document, window: { print() { printed = true; } } });
  assert.equal(controls.count.textContent, '8 of 8 attempts shown');
  controls.outcome.value = 'regression'; controls.outcome.listeners.input();
  assert.equal(controls.count.textContent, '1 of 8 attempts shown');
  assert.equal(pairs[0].cards.filter(card => !card.hidden)[0].dataset.category, 'regression');
  controls.search.value = 'absent invented phrase'; controls.search.listeners.input();
  assert.equal(controls.count.textContent, '0 of 8 attempts shown');
  controls.candidate.value = 'another-run'; controls.candidate.listeners.input();
  assert.equal(pairs[0].hidden, true);
  controls.print.listeners.click(); assert.equal(printed, true);
});

test('installed sibling skills work without a source checkout and missing dependency has concrete guidance', async t => {
  const f = await fixture(t), installed = path.join(f.app, 'installed-skills');
  await mkdir(installed);
  await cp(path.join(root, 'skills/compare-models/scripts'), path.join(installed, 'compare-models/scripts'), { recursive: true });
  const installedScript = path.join(installed, 'compare-models/scripts/compare.mjs');
  await assert.rejects(f.compare('missing-dependency', installedScript), /Install the matching build-evals skill beside compare-models/);
  await cp(path.join(root, 'skills/build-evals/scripts'), path.join(installed, 'build-evals/scripts'), { recursive: true });
  const result = JSON.parse((await f.compare('installed-result', installedScript)).stdout);
  assert.equal((await json(result.summary)).pairs.length, 1);
});

test('private paths reject links, running inputs and unignored or tracked output state', async t => {
  await t.test('symlink input', async t => {
    const f = await fixture(t);
    await f.save();
    await symlink(f.sources[0].directory, path.join(f.evalDir, 'results/linked'));
    await assert.rejects(f.invoke(compareScript, ['--name', 'linked', '--baseline', path.join(f.evalDir, 'results/linked'), '--candidate', f.sources[1].directory]), /Symlinks/);
  });
  await t.test('running input', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.sources[0].directory, '.lock'), '', { mode: 0o600 });
    await assert.rejects(f.compare(), /locked/);
  });
  await t.test('tracked private data', async t => {
    const f = await fixture(t);
    await exec('git', ['init'], { cwd: f.app, env: f.env });
    await f.save();
    await exec('git', ['add', '-f', '.understudy/evals/synthetic-eval/manifest.json'], { cwd: f.app, env: f.env });
    await assert.rejects(f.compare(), /tracked files/);
  });
  await t.test('comparison output is not ignored', async t => {
    const f = await fixture(t);
    await exec('git', ['init'], { cwd: f.app, env: f.env });
    await writeFile(path.join(f.app, '.understudy/.gitignore'), 'evals/\n', { mode: 0o600 });
    await assert.rejects(f.compare(), /Git-ignored/);
  });
  await t.test('output escaping', async t => {
    const f = await fixture(t);
    await assert.rejects(f.compare('../outside'), /Names must use/);
  });
});
