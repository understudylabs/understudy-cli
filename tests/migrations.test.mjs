import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { addMigrationCommands } from "../dist/commands/migrations.js";
import { createMigrationService } from "../dist/migrations/service.js";
import { MigrationStorage, digest } from "../dist/migrations/storage.js";
import { canonical, completedCallKeys, parseArguments } from "../dist/migrations/interactions.js";
import { matchFixture } from "../dist/migrations/fixtures.js";
import { reconstructInteractions, readTask } from "../dist/migrations/reconstruct.js";
import { reconstructPartitioned } from "../dist/migrations/partition.js";
import { verifyCaptures } from "../dist/migrations/captures.js";
import { queryTasks } from "../dist/migrations/inspection.js";

const org = "synthetic-org", project = "synthetic-project", workload = "synthetic-workload";
function authStore() {
  const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Date.now() / 1000 + 3600 })).toString("base64url");
  return { read: async () => ({ version: 1, method: "oauth", accessToken: `synthetic.${claims}.synthetic` }), write: async () => {}, clear: async () => {} };
}
async function setup(t, handler = async () => { throw new Error("Unexpected synthetic request"); }, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "synthetic-mapping-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const service = createMigrationService({ ...options, cwd: home, store: authStore(), baseUrl: "https://example.test", fetchImplementation: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/projects")) return Response.json({ projects: [{ id: project, org_id: org, slug: "synthetic-project", name: "Synthetic project" }], cursor: null });
    if (String(url).endsWith("/workloads")) return Response.json({ workloads: [{ id: workload, project_id: project, name: "synthetic-workload", capture_enabled: true }] });
    return handler(String(url), init);
  } });
  const run = await service.init({ runId: "synthetic-run", project, workload, org });
  return { home, calls, service, run, storage: new MigrationStorage(home), base: run.directory };
}
function envelope(id, request, response, extra = {}) {
  return { request_id: id, workos_org_id: org, project_id: project, workload_id: workload, trace_id: "synthetic-trace", ts: "2020-01-01T01:00:00.000Z", request_body: request, response_body: response, ...extra };
}
const user = { role: "user", content: "Find the synthetic sample." };
const call = { id: "synthetic-call", type: "function", function: { name: "read_sample", arguments: '{"second":2,"first":1}' } };
const assistant = { role: "assistant", content: null, tool_calls: [call] };
function corpus() {
  return [
    envelope("synthetic-request-a", { messages: [user] }, { error: { message: "Synthetic retry" } }, { status_code: 503, ts: "2020-01-01T00:59:00.000Z" }),
    envelope("synthetic-request-b", { messages: [user] }, { choices: [{ message: assistant, finish_reason: "tool_calls" }] }),
    envelope("synthetic-request-c", { messages: [user, assistant, { role: "tool", tool_call_id: call.id, content: "Synthetic sample found." }] }, { choices: [{ message: { role: "assistant", content: "The synthetic sample is present." }, finish_reason: "stop" }] }, { ts: "2020-01-01T01:01:00.000Z" }),
  ];
}
async function importCorpus(ctx, values = corpus()) {
  const directory = path.join(ctx.home, ".understudy", "synthetic-export");
  await mkdir(directory, { mode: 0o700 });
  const rows = [];
  for (const [i, value] of values.entries()) {
    const bytes = Buffer.from(JSON.stringify(value)); const file = `synthetic-${i}.jsonl`;
    await writeFile(path.join(directory, file), bytes, { mode: 0o600 });
    rows.push({ request_id: value.request_id, file, size: bytes.length, content_sha256: digest(bytes) });
  }
  const file = path.join(directory, "INDEX.jsonl");
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"), { mode: 0o600 });
  await ctx.service.import(ctx.run.runId, file);
  return { directory, file, rows };
}
test("mapping groups the full tool loop and retry into one task with no network access", async (t) => {
  const ctx = await setup(t); await importCorpus(ctx); ctx.calls.length = 0;
  const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.requests, 3); assert.equal(result.counts.tasks, 1);
  assert.equal(result.counts.completeTasks, 1); assert.equal(result.counts.fixturesRequired, 1);
  assert.equal(ctx.calls.length, 0);
  const tasks = JSON.parse(await readFile(path.join(ctx.base, "tasks.json"), "utf8"));
  assert.equal(tasks.tasks[0].turns[1].retryOf, "synthetic-request-a");
  assert.equal(tasks.tasks[0].exchanges[0].result, "Synthetic sample found.");
  assert.equal(tasks.tasks[0].exchanges[0].normalizedArguments, '{"first":1,"second":2}');
  for (const file of Object.values(result.artifacts)) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(file.startsWith(ctx.base));
  }
  assert.equal((await stat(ctx.base)).mode & 0o777, 0o700);
  await ctx.storage.writeJson(path.join(ctx.base, "cluster-decisions.json"), { arbitrary: "agent-owned shape" });
  const unchanged = await ctx.service.evidence(ctx.run.runId);
  assert.equal(unchanged.counts.tasks, 1);
  assert.equal(unchanged.status, "captured_with_gaps");
});

test("partitioned reconstruction preserves complete logical tasks and loads verified details on demand", async t => {
  const ctx = await setup(t); await importCorpus(ctx); await ctx.service.reconstruct(ctx.run.runId);
  const original = await ctx.storage.json(path.join(ctx.base, "tasks.json")); const verified = await verifyCaptures(ctx.storage, ctx.run);
  const partitioned = await reconstructPartitioned(ctx.storage, ctx.run, verified.index, verified.sourceDigest, reconstructInteractions);
  assert.equal(partitioned.schemaVersion, 2); assert.equal(partitioned.tasks.length, original.tasks.length);
  const detail = await readTask(ctx.storage, ctx.run, partitioned.tasks[0]); assert.deepEqual(detail, original.tasks[0]);
  assert.equal(partitioned.tasks[0].turns[0].messages, undefined); assert.ok(partitioned.tasks[0].exchanges[0].record);
  const report = await ctx.service.evidence(ctx.run.runId); assert.equal(report.counts.fixturesRequired, 1); assert.equal(report.counts.fixturesUsable, 1);
  const inspected = await ctx.service.inspect(ctx.run.runId, detail.id); assert.deepEqual(inspected.task, original.tasks[0]);
  const file = path.join(ctx.base, partitioned.tasks[0].detail.file); await ctx.storage.write(file, "{}");
  await assert.rejects(() => readTask(ctx.storage, ctx.run, partitioned.tasks[0]), /integrity/);
});

test("repacked message blocks preserve exact causal tool links without duplicate exchanges", async t => {
  const ctx = await setup(t);
  const first = { type: "tool_use", id: "synthetic-call-one", name: "read_sample", input: { key: 1, version: 2 } };
  const second = { type: "tool_use", id: "synthetic-call-two", name: "read_sample", input: { key: 3, version: 4 } };
  const result = tool => ({ type: "tool_result", tool_use_id: tool.id, content: "Synthetic fixture." });
  const history = [user, { role: "assistant", content: [first] }, { role: "user", content: [result(first)] }];
  const values = [
    envelope("synthetic-packed-a", { messages: [user] }, { content: [first], stop_reason: "tool_use" }),
    envelope("synthetic-packed-b", { messages: history }, { content: [second], stop_reason: "tool_use" }, { ts: "2020-01-01T01:01:00Z" }),
    envelope("synthetic-packed-c", { messages: [user, { role: "assistant", content: [first, { ...second, input: { version: 4, key: 3 } }] }, { role: "user", content: [result(first), result(second)] }] }, { content: [{ type: "text", text: "Both synthetic samples were read." }], stop_reason: "end_turn" }, { ts: "2020-01-01T01:02:00Z" }),
  ];
  await importCorpus(ctx, values); await ctx.service.reconstruct(ctx.run.runId);
  const original = await ctx.storage.json(path.join(ctx.base, "tasks.json"));
  assert.equal(original.tasks.length, 1); assert.equal(original.tasks[0].complete, true);
  assert.equal(original.tasks[0].exchanges.length, 2); assert.deepEqual(original.tasks[0].exchanges.map(e => e.turnId), ["turn-1", "turn-2"]);
  const verified = await verifyCaptures(ctx.storage, ctx.run);
  const partitioned = await reconstructPartitioned(ctx.storage, ctx.run, verified.index, verified.sourceDigest, reconstructInteractions);
  assert.deepEqual(await readTask(ctx.storage, ctx.run, partitioned.tasks[0]), original.tasks[0]);
});

test("tool identity links require exact arguments and preserve ambiguous producers", async t => {
  for (const ambiguous of [false, true]) {
    const ctx = await setup(t); const first = corpus()[1];
    const child = corpus()[2]; child.request_body.messages[0] = { role: "user", content: "Repacked synthetic context." };
    if (!ambiguous) child.request_body.messages[1] = { ...assistant, tool_calls: [{ ...call, function: { ...call.function, arguments: '{"first":9,"second":2}' } }] };
    const parents = ambiguous ? [first, { ...structuredClone(first), request_id: "synthetic-other-producer" }] : [first];
    await importCorpus(ctx, [...parents, child]); await ctx.service.reconstruct(ctx.run.runId);
    const tasks = await ctx.storage.json(path.join(ctx.base, "tasks.json"));
    assert.equal(tasks.tasks.length, 2);
    assert.equal(tasks.unresolved.length, ambiguous ? 1 : 0);
    assert.ok(tasks.tasks.every(task => task.requestIds.length === 1));
  }
});

test("a reused identity with different arguments cannot establish a unique causal link", () => {
  const call = { type: "call", id: "synthetic-reused", name: "read_sample", arguments: { key: 1 } };
  assert.deepEqual([...completedCallKeys([
    { role: "assistant", content: [call] },
    { role: "tool", content: [{ type: "result", id: call.id, result: "Synthetic result." }] },
    { role: "assistant", content: [{ ...call, arguments: { key: 2 } }] },
    { role: "tool", content: [{ type: "result", id: call.id, result: "Another synthetic result." }] },
  ])], []);
});

test("task inspection pages are bounded and cursors bind the evidence and filters", async t => {
  const ctx = await setup(t); const values = [corpus()[1], { ...corpus()[2], request_id: "synthetic-separate", trace_id: "synthetic-separate-trace" }];
  await importCorpus(ctx, values); await ctx.service.reconstruct(ctx.run.runId);
  const all = await ctx.service.tasks(ctx.run.runId, { limit: 1 });
  assert.equal(all.totalTasks, 2); assert.equal(all.tasks.length, 1); assert.ok(all.nextCursor);
  const next = await ctx.service.tasks(ctx.run.runId, { limit: 1, cursor: all.nextCursor });
  assert.notEqual(next.tasks[0].id, all.tasks[0].id); assert.equal(next.nextCursor, null);
  assert.equal((await ctx.service.tasks(ctx.run.runId, { complete: true })).matchedTasks, 1);
  assert.equal((await ctx.service.tasks(ctx.run.runId, { tool: "unobserved_tool" })).matchedTasks, 0);
  assert.equal((await ctx.service.tasks(ctx.run.runId, { cause: "tool_result_not_observed" })).matchedTasks, 1);
  await assert.rejects(() => ctx.service.tasks(ctx.run.runId, { cursor: all.nextCursor, complete: true }), /different evidence or filters/);
  const reconstruction = await ctx.storage.json(path.join(ctx.base, "tasks.json"));
  assert.throws(() => queryTasks({ ...reconstruction, taskDigest: "changed" }, { cursor: all.nextCursor }), /different evidence or filters/);
  for (const limit of [0, 101, 1.5, NaN]) assert.throws(() => queryTasks(reconstruction, { limit }), /page size/);
  const profile = await ctx.service.profile(ctx.run.runId);
  assert.equal(profile.tasks, 2); assert.equal(profile.toolsByTaskCount[0].count, 2); assert.equal(profile.observedToolSets.length, 1);
  assert.equal(profile.observedToolSets[0].taskCount, 2); assert.match(profile.interpretation, /not task clusters/);
  assert.equal((await stat(profile.artifact)).mode & 0o777, 0o600);
});

test("a truncated final stream remains incomplete captured evidence", async t => {
  const ctx = await setup(t);
  const stream = 'data: {"choices":[{"delta":{"content":"Synthetic result."},"finish_reason":"stop"}]}\n\n';
  await importCorpus(ctx, [envelope("synthetic-truncated", { messages: [user] }, stream)]);
  const mapped = await ctx.service.prepareCaptures(ctx.run.runId); assert.equal(mapped.counts.completeTasks, 0);
  const tasks = await ctx.storage.json(path.join(ctx.base, "tasks.json"));
  assert.ok(tasks.tasks[0].technicalCauses.includes("capture_stream_incomplete"));
});

test("partitioning keeps cross-trace explicit links and trace-free tool continuations together", async t => {
  for (const traceFree of [false, true]) {
    const ctx = await setup(t); const values = corpus().slice(1);
    values[0].trace_id = traceFree ? null : "synthetic-trace-one"; values[1].trace_id = traceFree ? null : "synthetic-trace-two";
    if (!traceFree) values[1].parent_request_id = values[0].request_id;
    await importCorpus(ctx, values); const verified = await verifyCaptures(ctx.storage, ctx.run);
    const reconstruction = await reconstructPartitioned(ctx.storage, ctx.run, verified.index, verified.sourceDigest, reconstructInteractions);
    assert.equal(reconstruction.tasks.length, 1); assert.equal(reconstruction.tasks[0].requestIds.length, 2); assert.equal(reconstruction.unresolved.length, 0);
  }
});

test("oversized connected components remain explicitly unresolved without sampling requests", async t => {
  const ctx = await setup(t); await importCorpus(ctx); const verified = await verifyCaptures(ctx.storage, ctx.run);
  const reconstruction = await reconstructPartitioned(ctx.storage, ctx.run, verified.index, verified.sourceDigest, reconstructInteractions, 1);
  assert.equal(reconstruction.requests, 3); assert.equal(reconstruction.tasks.length, 0);
  assert.equal(reconstruction.unresolved[0].requestIds.length, 3); assert.ok(reconstruction.unresolved[0].technicalCauses.includes("reconstruction_component_exceeds_memory_budget"));
});

test("independent tasks sharing one trace are processed separately within the memory allowance", async t => {
  const ctx = await setup(t);
  const values = ["left", "right"].map(side => envelope(`synthetic-${side}`, { messages: [{ role: "user", content: `Inspect the synthetic ${side} tile.` }] }, { choices: [{ message: { role: "assistant", content: `The synthetic ${side} tile is present.` }, finish_reason: "stop" }] }));
  await importCorpus(ctx, values); const verified = await verifyCaptures(ctx.storage, ctx.run);
  const allowance = Math.max(...verified.index.rows.map(r => r.bytes));
  const reconstruction = await reconstructPartitioned(ctx.storage, ctx.run, verified.index, verified.sourceDigest, reconstructInteractions, allowance);
  assert.equal(reconstruction.tasks.length, 2); assert.equal(reconstruction.unresolved.length, 0); assert.equal(reconstruction.traceCount, 1);
});

test("an existing private export can be imported and mapped without authenticating or changing accounts", async t => {
  const ctx = await setup(t); const exported = await importCorpus(ctx); const scope = path.join(ctx.base, "export-scope.json"); await ctx.storage.writeJson(scope, ctx.run.scope);
  const offline = createMigrationService({ cwd: ctx.home, store: { read: async () => { throw new Error("Authentication must not run"); } }, fetchImplementation: async () => { throw new Error("Network must not run"); } });
  const imported = await offline.importRun({ scope, index: exported.file, runId: "synthetic-imported-run" });
  assert.equal(imported.scopeOrigin, "private_export"); assert.equal(imported.liveScopeVerified, false); assert.equal(imported.requests, 3);
  const report = await offline.migrate({ project, workload, resume: imported.runId }); assert.equal(report.counts.tasks, 1);
  await assert.rejects(() => offline.migrate({ project: "different-project", workload, resume: imported.runId }), /selectors/);
});

test("a copied complete run resumes in a project without reading its old directory", async t => {
  const ctx = await setup(t), exported = await importCorpus(ctx), scope = path.join(ctx.base, "export-scope.json");
  await ctx.storage.writeJson(scope, ctx.run.scope);
  const imported = await ctx.service.importRun({ scope, index: exported.file, runId: "synthetic-copy" });
  await ctx.service.migrate({ project, workload, resume: imported.runId });
  const destination = await mkdtemp(path.join(tmpdir(), "synthetic-copy-project-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "--quiet", destination]).status, 0);
  const storage = new MigrationStorage(destination);
  await storage.write(path.join(storage.root, "prepared.txt"), "Synthetic preparation");
  await mkdir(path.join(storage.root, "migrations"), { mode: 0o700 });
  await cp(imported.directory, storage.runPath(imported.runId), { recursive: true, errorOnExist: true, force: false });
  await rm(ctx.home, { recursive: true, force: true });
  const nested = path.join(destination, "src"); await mkdir(nested);
  const offline = createMigrationService({ cwd: nested, store: { read: async () => { throw new Error("No authentication expected"); } }, fetchImplementation: async () => { throw new Error("No network expected"); } });
  const result = await offline.migrate({ project, workload, resume: imported.runId });
  assert.equal(result.counts.tasks, 1); assert.equal(result.counts.requests, 3);
  assert.equal(result.directory, storage.runPath(imported.runId));
});

test("strict fixture lookup rejects absent, repeated, differently scoped, and malformed calls", async (t) => {
  const ctx = await setup(t); await importCorpus(ctx); await ctx.service.prepareCaptures(ctx.run.runId);
  const plan = JSON.parse(await readFile(path.join(ctx.base, "tool-fixture-plan.json"), "utf8"));
  const e = plan.exchanges[0]; const call = { taskId: e.taskId, turnId: e.turnId, toolName: e.toolName, arguments: { first: 1, second: 2 }, occurrence: 0 };
  const used = new Set(); assert.equal(matchFixture(plan, call, used).ok, true);
  assert.equal(matchFixture(plan, call, used).category, null);
  assert.equal(matchFixture(plan, { ...call, taskId: "different-task" }).category, null);
  assert.equal(matchFixture(plan, { ...call, arguments: '{"a":1,"a":2}' }).category, "Format");
  assert.equal(matchFixture(plan, { ...call, arguments: { first: "1", second: 2 } }).category, null);
  const missing = structuredClone(plan); missing.exchanges[0].hasResult = false;
  assert.equal(matchFixture(missing, call).code, "fixture_unavailable");
  assert.equal(matchFixture(missing, call).category, null);
});

test("canonical arguments preserve value types and array order", () => {
  assert.equal(canonical(parseArguments('{"b":2,"a":1}')), '{"a":1,"b":2}');
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.throws(() => parseArguments('{"nested":{"a":1,"a":2}}'), /duplicate/);
  assert.throws(() => parseArguments("9007199254740993"), /unsupported/);
  assert.throws(() => parseArguments('{"a":1,}'));
});

test("private storage rejects nested repositories, symlinks, permissive files, and path escapes", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(() => ctx.storage.write(path.join(ctx.home, "escaped.json"), "{}"), /private state/);
  const publicFile = path.join(ctx.base, "public.json"); await writeFile(publicFile, "{}", { mode: 0o644 });
  await assert.rejects(() => ctx.storage.read(publicFile), /owner-only/);
  const alias = path.join(ctx.base, "alias.json"); await symlink(publicFile, alias);
  await assert.rejects(() => ctx.storage.read(alias), /symlinks/);
  await mkdir(path.join(ctx.base, ".git"), { mode: 0o700 });
  await assert.rejects(() => ctx.storage.read(path.join(ctx.base, "run.json")), /repositories/);
  assert.throws(() => ctx.storage.runPath("../escape"), /run id/);
});

test("scope cannot cross OAuth organization or ambiguous project selectors", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(() => ctx.service.init({ runId: "wrong-org", org: "other-org", project, workload }), /organization/);
  await assert.rejects(() => ctx.service.init({ runId: "placeholder", project: "{{project}}", workload }), /placeholders/);
  await assert.rejects(() => ctx.service.init({ runId: ctx.run.runId, project, workload }), /already exists/);
});

test("tampered or cross-scope imports are rejected and stale task results cannot be reported", async (t) => {
  const ctx = await setup(t); const imported = await importCorpus(ctx);
  await ctx.service.prepareCaptures(ctx.run.runId);
  const index = JSON.parse(await readFile(path.join(ctx.base, "captures.json"), "utf8"));
  await writeFile(path.join(ctx.base, index.rows[0].file), "{}", { mode: 0o600 });
  await assert.rejects(() => ctx.service.verify(ctx.run.runId), /integrity/);
  await assert.rejects(() => ctx.service.evidence(ctx.run.runId), /integrity/);
  const wrong = corpus()[0]; wrong.workos_org_id = "other-org";
  const bytes = Buffer.from(JSON.stringify(wrong));
  await writeFile(path.join(imported.directory, imported.rows[0].file), bytes, { mode: 0o600 });
  imported.rows[0].size = bytes.length; imported.rows[0].content_sha256 = digest(bytes);
  await writeFile(imported.file, imported.rows.map(JSON.stringify).join("\n"), { mode: 0o600 });
  await assert.rejects(() => ctx.service.import(ctx.run.runId, imported.file), /scope/);
});

test("independent objectives sharing one trace remain separate tasks", async (t) => {
  const ctx = await setup(t);
  const samples = ["first", "second"].map((label) => envelope(`synthetic-${label}`, { messages: [{ role: "user", content: `Synthetic ${label} objective.` }] }, { choices: [{ message: { role: "assistant", content: `Synthetic ${label} result.` }, finish_reason: "stop" }] }));
  await importCorpus(ctx, samples); const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 2); assert.equal(result.counts.traces, 1);
});

test("Responses chains reconstruct tools and missing parents remain unresolved", async (t) => {
  const ctx = await setup(t);
  const samples = [
    envelope("synthetic-first", { input: "Read the synthetic sample." }, { id: "synthetic-response", status: "completed", output: [{ type: "function_call", call_id: "synthetic-tool", name: "read_sample", arguments: "{}" }] }),
    envelope("synthetic-second", { previous_response_id: "synthetic-response", input: [{ type: "function_call_output", call_id: "synthetic-tool", output: "Synthetic sample" }] }, { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic finding" }] }] }, { ts: "2020-01-01T01:01:00.000Z" }),
    envelope("synthetic-third", { previous_response_id: "absent-response", input: "Continue." }, { status: "completed", output: [] }),
  ];
  await importCorpus(ctx, samples); const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 1); assert.equal(result.counts.unresolvedGroups, 1);
  assert.equal(result.counts.fixturesUsable, 1);
});

function page(body, captures, next = null) {
  return { canonical_scope: { schema_version: "understudy.export-scope.v1", selector: "workload-window", org_id: org, project_id: project, workload_id: workload, from: body.from, to: body.to, ingestion_cutoff: "2020-01-03T00:00:00.000Z" }, captures, next_cursor: next };
}
function reference(value) {
  return { request_id: value.request_id, capture_key: `${org}/${project}/synthetic-key/2020/01/01/${value.request_id}.jsonl`, captured_at: value.ts, url: `https://synthetic.r2.cloudflarestorage.com/${value.request_id}` };
}

test("hosted export follows empty continuation pages, freezes scope, and resumes without downloading again", async (t) => {
  const samples = corpus(); let pages = 0, downloads = 0;
  const ctx = await setup(t, async (url, init) => {
    if (url.endsWith("/captures/export")) {
      const body = JSON.parse(init.body); pages++;
      if (!body.cursor) return Response.json(page(body, [], "synthetic-cursor"));
      assert.equal(body.ingestion_cutoff, "2020-01-03T00:00:00.000Z");
      return Response.json(page(body, samples.map(reference)));
    }
    assert.equal(init.headers, undefined); assert.equal(init.redirect, "error");
    downloads++; return Response.json(samples.find((v) => url.endsWith(v.request_id)));
  });
  const first = await ctx.service.export(ctx.run.runId, "2020-01-01");
  assert.equal(first.verified, 3); assert.equal(first.completeForDay, true);
  await ctx.service.export(ctx.run.runId, "2020-01-01");
  assert.equal(pages, 2); assert.equal(downloads, 3);
  const saved = await readFile(path.join(ctx.base, "exports", "2020-01-01.json"), "utf8");
  assert.doesNotMatch(saved, /https:|r2\.cloudflarestorage/);
});

test("export resumes the committed page after an interrupted later download", async (t) => {
  const samples = corpus(); let interrupt = true; let firstPages = 0;
  const ctx = await setup(t, async (url, init) => {
    if (url.endsWith("/captures/export")) {
      const body = JSON.parse(init.body);
      if (!body.cursor) { firstPages++; return Response.json(page(body, [reference(samples[0])], "second-page")); }
      return Response.json(page(body, [reference(samples[1])]));
    }
    if (url.endsWith(samples[1].request_id) && interrupt) throw new TypeError("Synthetic transport interruption");
    return Response.json(samples.find((v) => url.endsWith(v.request_id)));
  });
  await assert.rejects(() => ctx.service.export(ctx.run.runId, "2020-01-01"), /Resume/);
  interrupt = false;
  const result = await ctx.service.export(ctx.run.runId, "2020-01-01");
  assert.equal(result.verified, 2); assert.equal(firstPages, 1);
});

test("export reports absent objects and rejects cross-scope pages and untrusted download URLs", async (t) => {
  let mode = "missing"; const sample = corpus()[0];
  const ctx = await setup(t, async (url, init) => {
    if (url.endsWith("/captures/export")) {
      const body = JSON.parse(init.body); const result = page(body, [reference(sample)]);
      if (mode === "scope") result.canonical_scope.org_id = "other-org";
      if (mode === "url") result.captures[0].url = "https://example.test/private";
      return Response.json(result);
    }
    return new Response(null, { status: 404 });
  });
  const result = await ctx.service.export(ctx.run.runId, "2020-01-01");
  assert.equal(result.unavailable, 1); assert.equal(result.completeForDay, false);
  const beforeResume = await ctx.service.verify(ctx.run.runId);
  await ctx.service.export(ctx.run.runId, "2020-01-01");
  const afterResume = await ctx.service.verify(ctx.run.runId);
  assert.equal(afterResume.sourceDigest, beforeResume.sourceDigest);
  assert.equal(afterResume.gaps.length, 1);
  const checkpoint = path.join(ctx.base, "exports", "2020-01-01.json");
  await rm(checkpoint); mode = "scope";
  await assert.rejects(() => ctx.service.export(ctx.run.runId, "2020-01-01"), /scope/);
  mode = "url";
  await assert.rejects(() => ctx.service.export(ctx.run.runId, "2020-01-01"), /trusted HTTPS/);
});

test("all-inventory export follows empty pages and reconciles every listed request", async (t) => {
  const samples = corpus(); let inventoryPages = 0;
  const ctx = await setup(t, async (url, init) => {
    if (url.includes("/captures?")) {
      inventoryPages++;
      if (!url.includes("cursor=")) return Response.json({ captures: [], truncated: true, cursor: "empty-page" });
      return Response.json({ captures: samples.map((sample) => ({ key: reference(sample).capture_key, request_id: sample.request_id, uploaded: sample.ts, size: Buffer.byteLength(JSON.stringify(sample)) })), truncated: false });
    }
    if (url.endsWith("/captures/export")) return Response.json(page(JSON.parse(init.body), samples.map(reference)));
    return Response.json(samples.find((v) => url.endsWith(v.request_id)));
  });
  const result = await ctx.service.exportAll(ctx.run.runId);
  assert.equal(inventoryPages, 2); assert.equal(result.inventoryRequests, 3);
  assert.equal(result.completeForInventory, true); assert.deepEqual(result.missing, []);
  assert.equal(result.snapshotIsolation, false);
});

test("inventory rejects nonadvancing cursors without writing a complete inventory", async (t) => {
  const ctx = await setup(t, async () => Response.json({ captures: [], truncated: true, cursor: "repeated" }));
  await assert.rejects(() => ctx.service.inventory(ctx.run.runId), /repeated/);
  await assert.rejects(() => readFile(path.join(ctx.base, "inventory.json")), { code: "ENOENT" });
});

test("capture and replay have separate responsibilities and no workflow flags", async () => {
  const calls = [];
  const service = Object.fromEntries(["migrate", "importRun", "tasks", "inspect", "replay"].map(name => [name, async (...args) => { calls.push([name, ...args]); return { counts: {}, directory: "synthetic-directory" }; }]));
  function cli() { const p = new Command().option("--json").exitOverride().configureOutput({writeErr:()=>{}}); addMigrationCommands(p, service, () => {}); return p; }
  assert.deepEqual(cli().commands.map(c => c.name()), ["migrate", "replay"]);
  await cli().parseAsync(["replay", "--run", "synthetic-run", "--harness", "synthetic.cjs", "--model", "synthetic-model", "--max-calls", "3", "--max-output-tokens", "100", "--json"], {from:"user"});
  assert.deepEqual(calls[0], ["replay", "synthetic-run", {harness:"synthetic.cjs",model:"synthetic-model",maxCalls:3,maxOutputTokens:100}, undefined]);
  const before = calls.length;
  for (const option of ["--plan", "--view", "--check"]) await assert.rejects(() => cli().parseAsync(["migrate", "--project", project, "--workload", workload, option], {from:"user"}), /unknown option/);
  for (const option of ["--experiment", "--schema", "--results"]) await assert.rejects(() => cli().parseAsync(["replay", "--run", "synthetic-run", "--harness", "synthetic.cjs", "--model", "synthetic-model", "--max-calls", "1", "--max-output-tokens", "100", option], {from:"user"}), /unknown option/);
  assert.equal(calls.length, before);
});

test("Anthropic tool errors remain captured errors and repeated history does not duplicate calls", async (t) => {
  const ctx = await setup(t);
  const tool = { type: "tool_use", id: "synthetic-anthropic-call", name: "read_sample", input: { id: "synthetic" } };
  const samples = [
    envelope("synthetic-anthropic-first", { messages: [user] }, { content: [tool], stop_reason: "tool_use" }),
    envelope("synthetic-anthropic-second", { messages: [user, { role: "assistant", content: [tool] }, { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, is_error: true, content: "Synthetic sample is unavailable." }] }] }, { content: [{ type: "text", text: "The sample was unavailable." }], stop_reason: "end_turn" }, { ts: "2020-01-01T01:02:00.000Z" }),
  ];
  await importCorpus(ctx, samples); const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 1); assert.equal(result.counts.fixturesRequired, 1);
  const plan = JSON.parse(await readFile(path.join(ctx.base, "tool-fixture-plan.json"), "utf8"));
  const e = plan.exchanges[0];
  const matched = matchFixture(plan, { taskId: e.taskId, turnId: e.turnId, toolName: e.toolName, arguments: { id: "synthetic" }, occurrence: 0 });
  assert.equal(matched.isError, true);
});

test("streaming final responses are reconstructed and a new Responses objective is separate", async (t) => {
  const ctx = await setup(t);
  const stream = 'data: {"choices":[{"delta":{"content":"Synthetic result."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n';
  const first = envelope("synthetic-stream", { messages: [user] }, stream);
  const response = envelope("synthetic-responses-first", { input: "Synthetic first objective." }, { id: "synthetic-parent-response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic first result." }] }] });
  const next = envelope("synthetic-responses-next", { previous_response_id: "synthetic-parent-response", input: "Synthetic next objective." }, { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic next result." }] }] }, { ts: "2020-01-01T01:02:00.000Z" });
  await importCorpus(ctx, [first, response, next]); const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 3); assert.equal(result.counts.completeTasks, 3);
});

test("a unique tool/history continuation links requests even without trace metadata", async (t) => {
  const ctx = await setup(t); const samples = corpus().slice(1).map((sample) => ({ ...sample, trace_id: null }));
  await importCorpus(ctx, samples); const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 1); assert.equal(result.counts.completeTasks, 1);
});

test("malformed captured tool arguments become an explicit fixture gap without discarding the task", async (t) => {
  const ctx = await setup(t); const sample = corpus()[1];
  sample.response_body.choices[0].message = { ...assistant, tool_calls: [{ ...call, function: { name: "read_sample", arguments: '{"x":1,"x":2}' } }] };
  await importCorpus(ctx, [sample]); const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 1); assert.equal(result.counts.fixturesUsable, 0);
  const plan = JSON.parse(await readFile(path.join(ctx.base, "tool-fixture-plan.json"), "utf8"));
  assert.ok(plan.exchanges[0].technicalCauses.includes("invalid_tool_arguments"));
});

test("placeholder selectors are rejected before opening credential storage", async () => {
  const service = createMigrationService({ store: { read: async () => { throw new Error("Credentials must not be touched"); } } });
  await assert.rejects(() => service.init({ project: "{{project}}", workload: "{{workload}}" }), /placeholders/);
});


test("migrate collects hosted captures and reconstructs a tool loop in one invocation", async (t) => {
  const samples = corpus(); let downloads = 0, inventories = 0;
  const ctx = await setup(t, async (url, init) => {
    if (url.includes("/captures?")) {
      inventories++;
      return Response.json({ captures: samples.map((sample) => ({ key: reference(sample).capture_key, request_id: sample.request_id, uploaded: sample.ts, size: Buffer.byteLength(JSON.stringify(sample)) })), truncated: false });
    }
    if (url.endsWith("/captures/export")) return Response.json(page(JSON.parse(init.body), samples.map(reference)));
    downloads++;
    return Response.json(samples.find((sample) => url.endsWith(sample.request_id)));
  });
  const output = [];
  const cli = new Command().option("--json").exitOverride();
  addMigrationCommands(cli, ctx.service, (text) => output.push(JSON.parse(text)));
  await cli.parseAsync(["migrate", "--project", project, "--workload", workload, "--from", "2020-01-01", "--to", "2020-01-02", "--json"], { from: "user" });
  const result = output[0];
  assert.equal(result.counts.requests, 3);
  assert.equal(result.counts.tasks, 1);
  assert.equal(result.counts.fixturesRequired, 1);
  assert.equal(result.status, "captured");
  assert.equal(Object.keys(result.artifacts).length, 3);
  const report = JSON.parse(await readFile(result.artifacts["capture-evidence.json"], "utf8"));
  assert.equal(report.coverage.completeForWindow, true);
  assert.equal(report.coverage.completeForInventory, null);
  assert.equal(report.integrity.serverDigestVerified, false);
  assert.equal(report.integrity.localHashesVerified, true);
  await ctx.service.migrate({ project, workload, resume: result.runId });
  assert.equal(downloads, 3);
  assert.equal(inventories, 0);
  await assert.rejects(() => ctx.service.migrate({ project, workload, org: "another-org", resume: result.runId }), /does not match/);
  assert.equal(downloads, 3);
});

test("migrate reports an empty capture inventory without inventing tasks or families", async (t) => {
  const ctx = await setup(t, async (url) => {
    assert.ok(url.includes("/captures?"));
    return Response.json({ captures: [], truncated: false });
  });
  const result = await ctx.service.migrate({ project, workload });
  assert.equal(result.status, "no_captures");
  assert.equal(result.counts.requests, 0);
  assert.equal(result.counts.tasks, 0);
  assert.equal(result.counts.fixturesRequired, 0);
  assert.equal(Object.hasOwn(result.artifacts, "task-clusters.json"), false);
});

test("migrate preserves its run and gives a resume command after collection interruption", async (t) => {
  const ctx = await setup(t, async () => { throw new TypeError("Synthetic network interruption"); });
  await assert.rejects(() => ctx.service.migrate({ project, workload }), /Saved run: mapping-.*Resume with: understudy migrate/);
});


test("migrate distinguishes unavailable capture objects from an empty workload", async (t) => {
  const sample = corpus()[0];
  const ctx = await setup(t, async (url, init) => {
    if (url.includes("/captures?")) return Response.json({ captures: [{ key: reference(sample).capture_key, request_id: sample.request_id, uploaded: sample.ts, size: Buffer.byteLength(JSON.stringify(sample)) }], truncated: false });
    if (url.endsWith("/captures/export")) return Response.json(page(JSON.parse(init.body), [reference(sample)]));
    return new Response(null, { status: 404 });
  });
  const result = await ctx.service.migrate({ project, workload });
  assert.equal(result.status, "needs_capture_evidence");
  assert.equal(result.counts.tasks, 0);
  const report = JSON.parse(await readFile(result.artifacts["capture-evidence.json"], "utf8"));
  assert.equal(report.coverage.completeForInventory, false);
  assert.equal(report.coverage.missingInventoryRequests.length, 1);
});


test("streaming chat tool calls link to the following request with null assistant content", async (t) => {
  const ctx = await setup(t);
  const samples = corpus().slice(1);
  samples[0].response_body = [
    { choices: [{ delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: call.id, type: "function", function: call.function }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n";
  await importCorpus(ctx, samples);
  const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 1);
  assert.equal(result.counts.completeTasks, 1);
  assert.equal(result.counts.fixturesRequired, 1);
});

test("streaming Anthropic argument normalization preserves duplicate-key evidence", async (t) => {
  const ctx = await setup(t);
  const stream = [
    { type: "message_start", message: { id: "synthetic-stream-message" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-stream-call", name: "read_sample", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"key":1,"key":2}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  await importCorpus(ctx, [envelope("synthetic-argument-stream", { messages: [user] }, stream)]);
  const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.fixturesUsable, 0);
  const plan = JSON.parse(await readFile(result.artifacts["tool-fixture-plan.json"], "utf8"));
  assert.ok(plan.exchanges[0].technicalCauses.includes("invalid_tool_arguments"));
});

test("consecutive retries stay in one logical task and retain the immediate attempt", async (t) => {
  const ctx = await setup(t); const samples = corpus();
  const secondFailure = { ...structuredClone(samples[0]), request_id: "synthetic-retry-again", ts: "2020-01-01T00:59:30.000Z" };
  await importCorpus(ctx, [samples[0], secondFailure, ...samples.slice(1)]);
  const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 1); assert.equal(result.counts.unresolvedGroups, 0);
  const tasks = JSON.parse(await readFile(path.join(ctx.base, "tasks.json"), "utf8"));
  assert.equal(tasks.tasks[0].turns[2].retryOf, secondFailure.request_id);
});

test("explicit links take precedence over equal, missing, or reversed timestamps", async (t) => {
  for (const times of [["2020-01-01T01:00:00Z", "2020-01-01T01:00:00Z"], [null, null], ["2020-01-01T02:00:00Z", "2020-01-01T01:00:00Z"]]) {
    const ctx = await setup(t); const samples = corpus().slice(1);
    samples[0].request_id = "synthetic-z-parent"; samples[0].ts = times[0];
    samples[1].request_id = "synthetic-a-child"; samples[1].ts = times[1];
    samples[1].parent_request_id = samples[0].request_id;
    await importCorpus(ctx, samples);
    const result = await ctx.service.prepareCaptures(ctx.run.runId);
    assert.equal(result.counts.tasks, 1); assert.equal(result.counts.unresolvedGroups, 0);
    const tasks = JSON.parse(await readFile(path.join(ctx.base, "tasks.json"), "utf8"));
    assert.deepEqual(tasks.tasks[0].requestIds, samples.map((sample) => sample.request_id));
  }
});

test("explicit dependency cycles remain unresolved without looping", async (t) => {
  const ctx = await setup(t); const samples = corpus().slice(1);
  samples[0].parent_request_id = samples[1].request_id;
  samples[1].parent_request_id = samples[0].request_id;
  await importCorpus(ctx, samples);
  const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.tasks, 0); assert.equal(result.counts.unresolvedGroups, 2);
});

test("serialized JSON containing data fields is not parsed as SSE", async (t) => {
  const ctx = await setup(t);
  const response = { choices: [{ message: { role: "assistant", content: "The data: field is present." }, finish_reason: "stop" }] };
  await importCorpus(ctx, [envelope("synthetic-data-text", { messages: [user] }, JSON.stringify(response))]);
  const result = await ctx.service.prepareCaptures(ctx.run.runId);
  assert.equal(result.counts.completeTasks, 1);
  const tasks = JSON.parse(await readFile(path.join(ctx.base, "tasks.json"), "utf8"));
  assert.deepEqual(tasks.tasks[0].terminalResponse, response);
});

test("legacy function-call loops retain captured exchanges and results", async (t) => {
  for (const streaming of [false, true]) {
    const ctx = await setup(t);
    const legacy = { role: "assistant", content: null, function_call: call.function };
    const response = streaming ? `data: ${JSON.stringify({ choices: [{ delta: { function_call: call.function }, finish_reason: "function_call" }] })}\n\ndata: [DONE]\n` : { choices: [{ message: legacy, finish_reason: "function_call" }] };
    const samples = [envelope("synthetic-legacy-first", { messages: [user] }, response),
      envelope("synthetic-legacy-next", { messages: [user, legacy, { role: "function", name: "read_sample", content: "Captured legacy result." }] }, { choices: [{ message: { role: "assistant", content: "The sample is present." }, finish_reason: "stop" }] }, { ts: "2020-01-01T01:01:00Z" })];
    await importCorpus(ctx, samples); const result = await ctx.service.prepareCaptures(ctx.run.runId);
    assert.equal(result.counts.tasks, 1); assert.equal(result.counts.fixturesRequired, 1); assert.equal(result.counts.fixturesUsable, 1);
    const plan = JSON.parse(await readFile(result.artifacts["tool-fixture-plan.json"], "utf8"));
    assert.equal(plan.exchanges[0].result, "Captured legacy result.");
  }
});


test("inventory size mismatches cannot claim complete inventory coverage", async (t) => {
  const sample = corpus()[2];
  const ctx = await setup(t, async (url, init) => {
    if (url.includes("/captures?")) return Response.json({ captures: [{ key: reference(sample).capture_key, request_id: sample.request_id, uploaded: sample.ts, size: 1 }], truncated: false });
    if (url.endsWith("/captures/export")) return Response.json(page(JSON.parse(init.body), [reference(sample)]));
    return Response.json(sample);
  });
  const result = await ctx.service.migrate({ project, workload });
  const report = JSON.parse(await readFile(result.artifacts["capture-evidence.json"], "utf8"));
  assert.equal(report.coverage.completeForInventory, false);
  assert.equal(report.coverage.inventorySizeMismatches.length, 1);
  assert.equal(report.coverage.inventorySizeMismatches[0].expectedBytes, 1);
  assert.equal(report.coverage.inventorySizeMismatches[0].actualBytes, Buffer.byteLength(JSON.stringify(sample)));
});

test("dated migration skips lifetime inventory, covers empty days, and keeps its window on resume", async t => {
  const sample = corpus()[2], windows = []; let downloads = 0;
  const ctx = await setup(t, async (url, init) => {
    if (url.endsWith('/captures/export')) {
      const body = JSON.parse(init.body); windows.push(body.from);
      return Response.json(page(body, body.from.startsWith('2020-01-01') ? [reference(sample)] : []));
    }
    assert.ok(url.startsWith('https://synthetic.r2.cloudflarestorage.com/'));
    downloads++; return Response.json(sample);
  });
  const result = await ctx.service.migrate({project, workload, from:'2019-12-27', to:'2020-01-03'});
  assert.equal(windows.length, 7); assert.equal(downloads, 1);
  assert.equal(result.coverage.completeForWindow, true);
  assert.equal(result.coverage.completeForInventory, null);
  assert.equal(result.coverage.indexedRequests, 1);
  assert.deepEqual(result.coverage.window, {from:'2019-12-27T00:00:00.000Z',to:'2020-01-03T00:00:00.000Z'});
  assert.equal(result.counts.requests, 1);
  const coverage = await ctx.storage.json(path.join(result.directory,'export-coverage.json'));
  assert.equal(coverage.days.length, 7); assert.equal(coverage.bytes, Buffer.byteLength(JSON.stringify(sample)));
  const originalIndex = await readFile(path.join(result.directory,'captures.json'),'utf8');
  const resumed = await ctx.service.migrate({project,workload,resume:result.runId});
  assert.equal(resumed.sourceDigest,result.sourceDigest);
  assert.equal(await readFile(path.join(result.directory,'captures.json'),'utf8'),originalIndex);
  assert.equal(downloads, 1); assert.equal(windows.length, 7); assert.deepEqual(resumed.coverage.window,result.coverage.window);
  await assert.rejects(()=>ctx.service.migrate({project,workload,resume:result.runId,lastDays:'7'}), /saved date range/);
});

test("migrate resumes unfinished days even when a preceding day wrote captures.json", async t => {
  let interrupt = true; const seen = [];
  const samples = [corpus()[0], {...corpus()[2], ts:'2020-01-02T01:00:00.000Z'}];
  const ctx = await setup(t, async (url, init) => {
    if (url.endsWith('/captures/export')) {
      const body=JSON.parse(init.body); seen.push(body.from);
      return Response.json(page(body,[reference(samples[body.from.startsWith('2020-01-01') ? 0 : 1])]));
    }
    if (interrupt && url.endsWith(samples[1].request_id)) throw new Error('Synthetic download interruption');
    return Response.json(samples.find(s=>url.endsWith(s.request_id)));
  });
  const run=await ctx.service.init({project,workload,runId:'synthetic-window-resume',from:'2020-01-01',to:'2020-01-03'});
  await assert.rejects(()=>ctx.service.migrate({project,workload,resume:run.runId}),/Resume/);
  assert.equal((await ctx.storage.json(path.join(run.directory,'captures.json'))).rows.length,1);
  interrupt=false;
  const result=await ctx.service.migrate({project,workload,resume:run.runId});
  assert.equal(result.counts.requests,2); assert.equal(result.coverage.completeForWindow,true);
  assert.deepEqual(seen,['2020-01-01T00:00:00.000Z','2020-01-02T00:00:00.000Z','2020-01-02T00:00:00.000Z']);
});

test("date selectors reject invalid ranges before authentication and last-days selects completed UTC days", async t => {
  const {selectCaptureWindow}=await import('../dist/migrations/captures.js');
  const midnight=Math.floor(Date.now()/86400000)*86400000;
  assert.deepEqual(selectCaptureWindow({lastDays:'7'}),{from:new Date(midnight-7*86400000).toISOString(),to:new Date(midnight).toISOString()});
  const offline=createMigrationService({store:{read:async()=>{throw new Error('Must not authenticate');}}});
  for (const selection of [{lastDays:'0'},{lastDays:'-1'},{lastDays:'1.2'},{lastDays:'1e3'},{lastDays:'999999999999999999999'},{lastDays:'7',from:'2020-01-01'},{from:'2020-01-01'},{to:'2020-01-02'},{from:'2020-02-30',to:'2020-03-01'},{from:'2020-01-02',to:'2020-01-01'},{from:'2020-01-01',to:'9999-01-01'}]) {
    await assert.rejects(()=>offline.migrate({project,workload,...selection}),e=>!e.message.includes('Must not authenticate'));
  }
  const calls=[];const cli=new Command().option('--json').exitOverride();
  addMigrationCommands(cli,{migrate:async v=>{calls.push(v);return {counts:{}};}},()=>{});
  await cli.parseAsync(['migrate','--project',project,'--workload',workload,'--last-days','7'],{from:'user'});
  assert.equal(calls[0].lastDays,'7');
  const parse = async args => {
    const cli=new Command().exitOverride();addMigrationCommands(cli,{migrate:async v=>{calls.push(v);return {counts:{}};}},()=>{});
    await cli.parseAsync(['migrate','--project',project,'--workload',workload,...args],{from:'user'});return calls.at(-1);
  };
  assert.equal((await parse([])).lastDays,'1');
  assert.equal((await parse(['--resume','synthetic-run'])).lastDays,undefined);
  assert.equal((await parse(['--from','2020-01-01','--to','2020-01-02'])).lastDays,undefined);
});

test("dated export distinguishes zero indexed captures from unavailable objects", async t => {
  for (const missing of [false,true]) {
    const ctx=await setup(t,async (url,init)=>url.endsWith('/captures/export')
      ? Response.json(page(JSON.parse(init.body),missing?[reference(corpus()[0])]:[]))
      : new Response(null,{status:404}));
    const result=await ctx.service.migrate({project,workload,from:'2020-01-01',to:'2020-01-02'});
    assert.equal(result.status,missing?'needs_capture_evidence':'no_captures');
    assert.equal(result.coverage.completeForWindow,!missing);
    assert.equal(result.coverage.indexedRequests,missing?1:0);
  }
});

test("capture downloads are bounded, preserve manifest order, and drain workers before returning an error", async t => {
  const samples=Array.from({length:19},(_,i)=>envelope(`synthetic-parallel-${i}`,{messages:[user]},{}));
  let active=0,peak=0,completed=0,fail=false;
  const ctx=await setup(t,async (url,init)=>{
    if(url.endsWith('/captures/export')) return Response.json(page(JSON.parse(init.body),samples.map(reference)));
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,3));
    active--;completed++;
    if(fail && url.endsWith(samples[0].request_id)) throw new Error('Synthetic interruption');
    return Response.json(samples.find(s=>url.endsWith('/'+s.request_id)));
  });
  const result=await ctx.service.export(ctx.run.runId,'2020-01-01');
  assert.equal(result.verified,19); assert.ok(peak>1); assert.ok(peak<=16); assert.equal(active,0);
  const index=await ctx.storage.json(path.join(ctx.base,'captures.json'));
  assert.deepEqual(index.rows.map(r=>r.requestId),samples.map(s=>s.request_id));
  await rm(path.join(ctx.base,'exports','2020-01-01.json'));fail=true;completed=0;
  await assert.rejects(()=>ctx.service.export(ctx.run.runId,'2020-01-01'),/Resume/);
  assert.equal(active,0);assert.ok(completed<=16);
  await assert.rejects(()=>readFile(path.join(ctx.base,'exports','2020-01-01.json')),{code:'ENOENT'});
});

test("capture progress reports safe counts and distinguishes download, verification, and reconstruction", async t => {
  const events=[],sample=corpus()[2];
  const ctx=await setup(t,async (url,init)=>url.endsWith('/captures/export')?Response.json(page(JSON.parse(init.body),[reference(sample)])):Response.json(sample),{onCaptureProgress:event=>events.push(event)});
  await ctx.service.migrate({project,workload,from:'2020-01-01',to:'2020-01-02'});
  assert.equal(events[0].phase,'download');assert.equal(events.at(-1).phase,'reconstruct');
  const verification=events.find(e=>e.phase==='verify');
  assert.equal(verification.saved,1); assert.equal(verification.bytes,Buffer.byteLength(JSON.stringify(sample)));
  assert.equal(events.at(-1).saved,1);assert.doesNotMatch(JSON.stringify(events),/synthetic-request|https:|token|authorization/i);
});

test("a resumed completed export rejects corrupted capture bytes", async t => {
  const sample=corpus()[0];
  const ctx=await setup(t,async (url,init)=>url.endsWith('/captures/export')?Response.json(page(JSON.parse(init.body),[reference(sample)])):Response.json(sample));
  const result=await ctx.service.migrate({project,workload,from:'2020-01-01',to:'2020-01-02'});
  const index=await ctx.storage.json(path.join(result.directory,'captures.json'));
  await ctx.storage.write(path.join(result.directory,index.rows[0].file),Buffer.from('synthetic corruption'));
  await assert.rejects(()=>ctx.service.migrate({project,workload,resume:result.runId}),/integrity/);
});

test('download enforces declared byte bounds and cancels rejected responses', async t=>{
  let cancelled=false;
  const ctx=await setup(t,async(url,init)=>{
    if(url.endsWith('/captures/export'))return Response.json(page(JSON.parse(init.body),[reference(corpus()[0])]));
    return new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-length':'10'}});
  });
  await assert.rejects(()=>ctx.service.export(ctx.run.runId,'2020-01-01'),/reserved byte limit/);
  assert.equal(cancelled,true);
  await assert.rejects(()=>readFile(path.join(ctx.base,'exports','2020-01-01.json')),{code:'ENOENT'});
});

test('encoded and unknown response sizes use the full allowance rather than trusting compressed length', async t=>{
  const sample=corpus()[2];
  for(const headers of [{},{'content-encoding':'gzip','content-length':'1'}]){
    const ctx=await setup(t,async(url,init)=>url.endsWith('/captures/export')?Response.json(page(JSON.parse(init.body),[reference(sample)])):new Response(JSON.stringify(sample),{headers}));
    assert.equal((await ctx.service.export(ctx.run.runId,'2020-01-01')).verified,1);
  }
});

test('verification rejects files larger than their reservation before reading the file body', async t=>{
  const ctx=await setup(t);await importCorpus(ctx);
  const index=await ctx.storage.json(path.join(ctx.base,'captures.json'));index.rows[0].bytes=1;
  await ctx.storage.writeJson(path.join(ctx.base,'captures.json'),index);
  const original=ctx.storage.read.bind(ctx.storage);let bounded=false;
  ctx.storage.read=async(file,max)=>{if(file.endsWith(index.rows[0].file)){assert.equal(max,1);bounded=true;}return original(file,max);};
  await assert.rejects(()=>verifyCaptures(ctx.storage,ctx.run),/declared byte size/);
  assert.equal(bounded,true);
});

test('body admission limits unknown-size downloads while small declared bodies remain concurrent', async t=>{
  for(const knownSize of [false,true]){
    let active=0,peak=0;
    const samples=Array.from({length:16},(_,i)=>envelope(`synthetic-admission-${i}`,{messages:[user]},{}));
    const ctx=await setup(t,async(url,init)=>{
      if(url.endsWith('/captures/export'))return Response.json(page(JSON.parse(init.body),samples.map(reference)));
      const bytes=Buffer.from(JSON.stringify(samples.find(s=>url.endsWith('/'+s.request_id))));let started=false;
      return new Response(new ReadableStream({async pull(controller){
        if(started){active--;controller.close();return;}
        started=true;active++;peak=Math.max(peak,active);
        await new Promise(resolve=>setTimeout(resolve,5));controller.enqueue(bytes);
      }},{highWaterMark:0}),{headers:knownSize?{'content-length':String(bytes.length)}:{}});
    });
    assert.equal((await ctx.service.export(ctx.run.runId,'2020-01-01')).verified,16);
    assert.equal(active,0);assert.equal(peak,knownSize?16:2);
  }
});
