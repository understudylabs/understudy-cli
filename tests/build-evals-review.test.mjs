import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../skills/build-evals/scripts/eval.mjs', import.meta.url));
const parse = async file => JSON.parse(await readFile(file, 'utf8'));
const readRows = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const writeRows = (file, values) => writeFile(file, values.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-eval-review-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const call = async (...args) => {
    const result = await exec(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000 });
    return JSON.parse(result.stdout);
  };
  const relative = '.understudy/evals/parcel';
  await call('init', '--name', 'parcel', '--mode', 'medium', '--demo');
  await call('validate', '--eval', relative);
  await call('run', '--eval', relative, '--run', 'baseline');
  const directory = path.join(root, relative, 'results/baseline');
  const run = await parse(path.join(directory, 'run.json'));
  const cases = await readRows(path.join(directory, 'cases.jsonl'));
  const rows = await readRows(path.join(directory, 'results.jsonl'));
  const render = async (recorded, frozenRun = run, frozenCases = cases) => {
    await writeJson(path.join(directory, 'run.json'), frozenRun);
    await writeRows(path.join(directory, 'cases.jsonl'), frozenCases);
    await writeRows(path.join(directory, 'results.jsonl'), recorded);
    // Changed-evidence scenarios use a coherent synthetic fixture in both
    // journals; conflicting execution evidence is rejected by separate tests.
    const executions = recorded.map(row => {
      const checkpoint = { ...row, status: 'ok', metrics: { ...row.metrics, judgeCostUsd: null } };
      delete checkpoint.verdicts; delete checkpoint.judge; delete checkpoint.error;
      return checkpoint;
    });
    await writeRows(path.join(directory, 'executions.jsonl'), executions);
    await call('report', '--eval', relative, '--run', 'baseline');
    return readFile(path.join(directory, 'report.html'), 'utf8');
  };
  const artifacts = async () => ({ html: await readFile(path.join(directory, 'report.html'), 'utf8'), markdown: await readFile(path.join(directory, 'report.md'), 'utf8'), summary: await parse(path.join(directory, 'summary.json')) });
  const review = async manifest => {
    await writeJson(path.join(root, relative, 'manifest.json'), manifest);
    await call('review', '--eval', relative);
    return { html: await readFile(path.join(root, relative, 'review.html'), 'utf8'), markdown: await readFile(path.join(root, relative, 'review.md'), 'utf8') };
  };
  return { run, cases, rows, render, artifacts, review };
}

const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Execute the generated page's real review code against a minimal DOM. Browser
// storage survives boot() calls, while the page and editors are rebuilt each time.
function boot(html, storage = new Map()) {
  const element = () => ({ value: '', dataset: {}, textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const elements = Object.fromEntries(['search', 'status', 'tag', 'visible', 'review-status', 'reviewer', 'export', 'import', 'save', 'forget', 'print'].map(id => [id, element()]));
  const fields = [...html.matchAll(/<fieldset\s+([^>]*data-review-key="[^"]*"[^>]*)>([\s\S]*?)<\/fieldset>/g)].map(match => {
    const field = element();
    field.dataset.reviewKey = decode(match[1].match(/data-review-key="([^"]*)"/)[1]);
    field.dataset.evidenceId = match[1].match(/data-evidence-id="([^"]*)"/)?.[1];
    field.select = match[2].includes('<select') ? element() : null;
    field.textarea = element();
    field.querySelector = selector => selector === 'select' ? field.select : field.textarea;
    return field;
  });
  const scope = html.match(/<body data-scope="([^"]*)"/)[1];
  const downloads = [];
  const document = {
    body: { dataset: { scope } },
    getElementById: id => elements[id],
    querySelector: selector => elements[selector.slice(1)],
    querySelectorAll: selector => selector === '[data-review-key]' ? fields : [],
    createElement: () => ({ click() {} }),
  };
  vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1], vm.createContext({
    document, Blob, window: { addEventListener() {}, print() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:synthetic-review'; }, revokeObjectURL() {} },
    setTimeout: fn => fn(),
  }));
  const field = (caseId, criterionId) => {
    const result = fields.find(item => item.dataset.reviewKey === JSON.stringify([caseId, 1, criterionId]));
    assert.ok(result, 'The generated page contains the requested annotation editor.');
    return result;
  };
  return {
    scope, storage, field,
    status: () => elements['review-status'].textContent,
    annotate(caseId, criterionId, label, note) {
      elements.reviewer.value = 'Synthetic reviewer';
      const editor = field(caseId, criterionId);
      if (editor.select) editor.select.value = label;
      editor.textarea.value = note;
      editor.listeners.input();
    },
    save: () => elements.save.listeners.click(),
    async export() { elements.export.listeners.click(); return downloads.at(-1).text(); },
    async import(text) { await elements.import.listeners.change({ target: { value: 'synthetic-review.jsonl', files: [{ size: Buffer.byteLength(text), text: async () => text }] } }); },
  };
}

test('saved and exported human annotations survive unrelated completed attempts', async t => {
  const f = await fixture(t);
  const partial = { ...f.run }; delete partial.completedAt;
  const html = await f.render(f.rows.slice(0, 1), partial);
  const page = boot(html);
  const caseId = f.cases[0].id, criterionId = f.run.manifest.criteria[0].id;
  page.annotate(caseId, null, null, 'Synthetic discovery note before the run completes.');
  page.annotate(caseId, criterionId, 'Pass', 'This completed attempt satisfies the criterion.');
  page.save();
  const exported = await page.export();
  const stored = [...page.storage.values()];

  const resumedHtml = await f.render(f.rows, f.run);
  const resumed = boot(resumedHtml, page.storage);
  assert.equal(resumed.scope, page.scope, 'Appending rows and completing a run must not change its review scope.');
  assert.equal(resumed.field(caseId, criterionId).select.value, 'Pass');
  assert.equal(resumed.field(caseId, null).textarea.value, 'Synthetic discovery note before the run completes.');
  assert.match(resumed.status(), /Restored 2/);
  assert.deepEqual([...page.storage.values()], stored, 'Restore does not rewrite the stored evidence.');
  const imported = boot(resumedHtml);
  await imported.import(exported);
  assert.match(imported.status(), /Imported 2/);
  assert.equal(imported.field(caseId, criterionId).select.value, 'Pass');
  const labels = exported.trim().split('\n').map(JSON.parse);
  assert.ok(labels.every(row => row.schemaVersion === 2 && /^[a-f0-9]{64}$/.test(row.evidenceId)));
});

test('changed attempt evidence skips only stale browser notes and rejects mixed imports atomically', async t => {
  const f = await fixture(t);
  const originalHtml = await f.render(f.rows.slice(0, 2));
  const original = boot(originalHtml);
  const first = f.cases[0].id, second = f.cases[1].id, criterion = f.run.manifest.criteria[0].id;
  original.annotate(first, null, null, 'Discovery note tied to the original first output.');
  original.annotate(first, criterion, 'Pass', 'First original result.');
  original.annotate(second, criterion, 'Pass', 'Second unchanged result.');
  original.save();
  const exported = await original.export(), originalStored = [...original.storage.values()];

  for (const [name, change] of [
    ['output', row => { row.output = { price: 999 }; }],
    ['trace', row => { row.trace = [...(row.trace ?? []), { role: 'tool', name: 'synthetic-tool', content: 'A changed recorded result.' }]; }],
    ['execution status', row => { row.status = 'grader_error'; row.error = { code: 'SYNTHETIC_GRADER_ERROR', message: 'Grading did not complete.' }; }],
  ]) await t.test(name, async () => {
    const changed = structuredClone(f.rows.slice(0, 2)); change(changed[0]);
    const html = await f.render(changed);
    const restored = boot(html, original.storage);
    assert.equal(restored.scope, original.scope, 'The frozen run is unchanged; only one attempt is stale.');
    assert.equal(restored.field(first, criterion).select.value, '');
    assert.equal(restored.field(first, null).textarea.value, '');
    assert.equal(restored.field(second, criterion).select.value, 'Pass');
    assert.match(restored.status(), /Restored 1/);
    assert.match(restored.status(), /2 stale/i);
    assert.deepEqual([...original.storage.values()], originalStored);

    restored.annotate(second, criterion, 'Defer', 'Current note must survive a rejected import.');
    await restored.import(exported);
    assert.match(restored.status(), /Import failed:.*evidence/i);
    assert.equal(restored.field(first, criterion).select.value, '');
    assert.equal(restored.field(second, criterion).select.value, 'Defer');
    const unchangedOnly = exported.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.caseId === second).map(row => JSON.stringify(row)).join('\n');
    await restored.import(unchangedOnly);
    assert.match(restored.status(), /Imported 1/);
    assert.equal(restored.field(second, criterion).select.value, 'Pass');
  });
});

test('frozen contract changes reject prior labels even when the recorded run fingerprint is unchanged', async t => {
  const f = await fixture(t);
  const original = boot(await f.render(f.rows.slice(0, 1)));
  const caseId = f.cases[0].id, criterion = f.run.manifest.criteria[0].id;
  original.annotate(caseId, criterion, 'Pass', 'Label under the original contract.'); original.save();
  const exported = await original.export();
  for (const kind of ['criterion', 'expected', 'input', 'workload']) await t.test(kind, async () => {
    const run = structuredClone(f.run), cases = structuredClone(f.cases);
    if (kind === 'criterion') run.manifest.criteria[0].description = 'Changed synthetic requirement.';
    else if (kind === 'expected') cases[0].expected = { price: 99 };
    else if (kind === 'workload') run.manifest.workload.workloadId = 'synthetic-other-parcel-workload';
    else cases[0].input.grams = 499;
    const changed = boot(await f.render(f.rows.slice(0, 1), run, cases), original.storage);
    assert.notEqual(changed.scope, original.scope);
    assert.equal(changed.field(caseId, criterion).select.value, '');
    changed.annotate(caseId, criterion, 'Defer', 'New-contract observation.');
    await changed.import(exported);
    assert.match(changed.status(), /Import failed/);
    assert.equal(changed.field(caseId, criterion).select.value, 'Defer');
    assert.equal(changed.field(caseId, criterion).textarea.value, 'New-contract observation.');
  });
});

test('report and discovery review expose one escaped source workload before the evidence', async t => {
  const f = await fixture(t);
  const run = structuredClone(f.run);
  const workload = {
    source: 'synthetic',
    organizationId: 'synthetic-org<&>',
    projectId: 'synthetic-project"quoted"',
    workloadId: "synthetic-workload'quoted'",
    name: 'Synthetic <script>alert("review")</script> & **parcel** | quotes',
  };
  run.manifest.workload = workload;
  await f.render(f.rows, run);
  const report = await f.artifacts();
  assert.deepEqual(report.summary.workload, workload, 'The summary carries the frozen source workload.');
  const review = await f.review(run.manifest);
  for (const artifact of [report, review]) {
    const header = artifact.html.match(/<header>([\s\S]*?)<\/header>/)[1];
    assert.match(header, /<h2>Source workload<\/h2>/);
    assert.match(header, /<th scope="row">Source<\/th><td>synthetic<\/td>/);
    assert.match(header, /synthetic-org&lt;&amp;&gt;/);
    assert.match(header, /synthetic-project&quot;quoted&quot;/);
    assert.match(header, /synthetic-workload&#39;quoted&#39;/);
    assert.match(header, /Synthetic &lt;script&gt;alert\(&quot;review&quot;\)&lt;\/script&gt; &amp; \*\*parcel\*\* \| quotes/);
    assert.ok(!header.includes('<script>'), 'Workload text cannot add an executable element.');
    const markdownHeader = artifact.markdown.split('## Frozen scope')[0];
    assert.match(markdownHeader, /## Source workload/);
    assert.ok(markdownHeader.includes('| Name | Synthetic \\<script\\>alert("review")\\</script\\> & \\*\\*parcel\\*\\* \\| quotes |'));
    assert.ok(markdownHeader.includes('| Organization ID | synthetic-org\\<&\\> |'));
    assert.ok(markdownHeader.includes('| Project ID | synthetic-project"quoted" |'));
    assert.ok(markdownHeader.includes("| Workload ID | synthetic-workload'quoted' |"));
    assert.match(markdownHeader, /\| Source \| synthetic \|/);
    assert.match(header, /Execution authorization is separate from this source identity/);
    assert.match(markdownHeader, /Execution authorization is separate from this source identity/);
    boot(artifact.html);
  }
});
