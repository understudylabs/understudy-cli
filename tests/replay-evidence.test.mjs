// Every fixture and response in this file is wholly invented synthetic data.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMigrationService } from "../dist/migrations/service.js";
import { MigrationStorage, digest } from "../dist/migrations/storage.js";
import { canonical } from "../dist/migrations/interactions.js";
import { boundedRequest } from "../dist/migrations/transport.js";

const org = "synthetic-evidence-org", project = "synthetic-evidence-project", workload = "synthetic-evidence-workload";
const model = "synthetic-evidence-model";
const schema = { type: "object", properties: { panel: { type: "object", properties: { row: { type: "integer" } }, required: ["row"] }, tags: { type: "array", items: { type: "string" } } }, required: ["panel", "tags"] };
const tool = { name: "read_panel", input_schema: schema };
const final = { type: "message", role: "assistant", content: [{ type: "text", text: "Synthetic panel inspected." }], stop_reason: "end_turn" };

async function setup(t, harness) {
    const directory = await mkdtemp(path.join(tmpdir(), "synthetic-replay-evidence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Date.now() / 1000 + 3600 })).toString("base64url");
    const sent = [];
    const service = createMigrationService({
        cwd: directory, baseUrl: "https://example.test",
        store: { read: async () => ({ version: 1, method: "oauth", accessToken: `synthetic.${claims}.signature` }), write: async () => {}, clear: async () => {} },
        credential: async () => ({ organizationId: org, apiKey: "fake", inferenceUrl: "https://example.test" }),
        fetchImplementation: async (url, init) => {
            const endpoint = new URL(url).pathname;
            if (endpoint.endsWith("/projects")) return Response.json({ projects: [{ id: project, org_id: org, slug: project, name: "Synthetic evidence project" }], cursor: null });
            if (endpoint.endsWith("/workloads")) return Response.json({ workloads: [{ id: workload, project_id: project, name: workload, capture_enabled: true }] });
            if (endpoint.endsWith("/models")) return Response.json({ models: [{ id: model }] });
            assert.equal(String(url), "https://example.test/v1/messages");
            sent.push(JSON.parse(init.body));
            return Response.json(final, { headers: { "x-understudy-request-id": "synthetic-evidence-response", "x-understudy-effective-model": model, "x-understudy-environment": "test" } });
        },
    });
    const run = await service.init({ runId: "synthetic-evidence-run", project, workload });
    const storage = new MigrationStorage(directory), inputDirectory = path.join(storage.root, "input");
    const message = { role: "user", content: "Read the invented panel." };
    const call = { type: "tool_use", id: "synthetic-panel-call", name: tool.name, input: { panel: { row: 1 }, tags: ["synthetic"] } };
    const body = { model: "synthetic-original-model", messages: [message], tools: [tool], max_tokens: 200 };
    const captures = [
        { request_id: "synthetic-panel-first", request_body: body, response_body: { type: "message", role: "assistant", content: [call], stop_reason: "tool_use" } },
        { request_id: "synthetic-panel-last", parent_request_id: "synthetic-panel-first", request_body: { ...body, messages: [message, { role: "assistant", content: [call] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: { shade: { name: "silver" } } }] }] }, response_body: final },
    ];
    const rows = [];
    for (const [position, capture] of captures.entries()) {
        const bytes = JSON.stringify({ ...capture, endpoint: "/v1/messages", workos_org_id: org, project_id: project, workload_id: workload, trace_id: "synthetic-panel-trace", ts: `2020-02-01T00:0${position}:00Z` });
        const file = `synthetic-capture-${position}.jsonl`;
        await storage.write(path.join(inputDirectory, file), bytes);
        rows.push({ file, request_id: capture.request_id, size: Buffer.byteLength(bytes), content_sha256: digest(bytes) });
    }
    const index = path.join(inputDirectory, "index.jsonl");
    await storage.write(index, rows.map(row => JSON.stringify(row)).join("\n"));
    await service.import(run.runId, index);
    await service.prepareCaptures(run.runId);
    const harnessPath = path.join(inputDirectory, "harness.cjs");
    await storage.write(harnessPath, `module.exports = ${harness.toString()};\n`);
    const input = { id: "synthetic-evidence-replay", harness: harnessPath, model, maxCalls: 4, maxOutputTokens: 80 };
    return { sent, storage, input, replay: () => service.replay(run.runId, input) };
}

function assertDigests(journal) {
    for (const entry of journal.entries) {
        assert.equal(entry.inputDigest, digest(canonical(entry.input)));
        assert.equal(entry.outputDigest, digest(canonical(entry.output)));
    }
}

test("bounded requests own nested JSON while preserving protocol limits and serialization", () => {
    for (const [protocol, tokenField] of [["messages", "max_tokens"], ["chat", "max_completion_tokens"], ["responses", "max_output_tokens"]]) {
        const original = { messages: [{ role: "user", content: [{ type: "text", text: "Synthetic original." }] }], metadata: { labels: ["synthetic-original"], date: new Date("2020-02-01T00:00:00Z") }, max_tokens: 500, max_completion_tokens: 30, max_output_tokens: 300 };
        const bounded = boundedRequest(original, protocol, model, 80);
        original.messages[0].content[0].text = "Synthetic changed.";
        original.metadata.labels.push("synthetic-added");
        assert.equal(bounded.messages[0].content[0].text, "Synthetic original.");
        assert.deepEqual(bounded.metadata.labels, ["synthetic-original"]);
        assert.equal(bounded.metadata.date, "2020-02-01T00:00:00.000Z");
        assert.equal(bounded[tokenField], protocol === "chat" ? 30 : 80);
        assert.deepEqual(Object.keys(bounded).filter(key => key.startsWith("max_")), [tokenField]);
        assert.equal(bounded.model, model); assert.equal(bounded.stream, true);
        assert.equal(canonical(bounded), canonical(JSON.parse(JSON.stringify(bounded))));
    }
    for (const unsupported of [NaN, Infinity, undefined, 1n, () => {}]) {
        assert.throws(() => boundedRequest({ metadata: { unsupported } }, "messages", model, 80), /unsupported_number|non_json_value/);
    }
});

test("model requests snapshot at invocation and remain valid across conversation mutation and resume", async t => {
    const context = await setup(t, async function(api) {
        const taskId = api.taskIds[0];
        const body = { messages: [{ role: "user", content: [{ type: "text", text: "Synthetic first turn." }] }], metadata: { labels: ["first"] } };
        const firstPending = api.request({ id: "synthetic-first-operation", taskId, protocol: "messages", body });
        body.messages[0].content[0].text = "Synthetic second turn.";
        body.messages.push({ role: "assistant", content: "Synthetic continuation." });
        body.metadata.labels.push("second");
        const first = await firstPending;
        const second = await api.request({ id: "synthetic-second-operation", taskId, protocol: "messages", body });
        body.messages[0].content[0].text = "Synthetic final mutation.";
        body.messages.push({ role: "user", content: "Synthetic later turn." });
        body.metadata.labels.push("later");
        const digests = [first.receipt.requestDigest, second.receipt.requestDigest];
        first.receipt.raw = "Synthetic output mutation.";
        return digests;
    });
    const result = await context.replay(), journal = await context.storage.json(result.artifact);
    assert.equal(result.status, "recorded"); assert.equal(context.sent.length, 2);
    assert.equal(journal.entries[0].input.body.messages.length, 1);
    assert.equal(journal.entries[0].input.body.messages[0].content[0].text, "Synthetic first turn.");
    assert.deepEqual(journal.entries[0].input.body.metadata.labels, ["first"]);
    assert.equal(journal.entries[1].input.body.messages.length, 2);
    assert.equal(journal.entries[1].input.body.messages[0].content[0].text, "Synthetic second turn.");
    for (const [position, entry] of journal.entries.entries()) {
        assert.deepEqual(entry.input.body, context.sent[position]);
        assert.equal(result.harnessResult[position], digest(canonical(context.sent[position])));
        assert.equal(entry.output.raw, JSON.stringify(final));
    }
    assertDigests(journal);
    const resumed = await context.replay();
    assert.equal(resumed.status, "recorded"); assert.equal(resumed.modelCalls, 2); assert.equal(context.sent.length, 2);
    assert.deepEqual((await context.storage.json(resumed.artifact)).entries, journal.entries);
    assertDigests(await context.storage.json(resumed.artifact));
});

test("nested candidate arguments, effective arguments, schemas, and returned tool outputs are isolated", async t => {
    const context = await setup(t, async function(api) {
        const taskId = api.taskIds[0], source = await api.task(taskId);
        const candidate = { id: "synthetic-candidate-call", name: "read_panel", arguments: { panel: { row: 2 }, tags: ["candidate"] } };
        const effectiveArguments = { panel: { row: 1 }, tags: ["synthetic"] };
        const schema = source.requests[0].body.tools[0].input_schema;
        const pending = api.mockTool({ id: "synthetic-tool-operation", caseId: "synthetic-case", taskId, turnId: source.requests[0].turnId, call: candidate, effectiveArguments, schema });
        candidate.arguments.panel.row = 3; candidate.arguments.tags.push("queued-mutation");
        effectiveArguments.panel.row = 4; effectiveArguments.tags.push("queued-mutation");
        schema.properties.panel.properties.row.type = "string";
        const output = await pending;
        if (output.isError) throw new Error("Synthetic fixture should match its original input.");
        output.result.shade.name = "Synthetic changed output.";
        candidate.arguments.panel.row = 5; effectiveArguments.panel.row = 6;
        return { mutated: true };
    });
    const result = await context.replay(), journal = await context.storage.json(result.artifact), entry = journal.entries[0];
    assert.equal(result.status, "recorded"); assert.equal(context.sent.length, 0);
    assert.deepEqual(entry.input.call.arguments, { panel: { row: 2 }, tags: ["candidate"] });
    assert.deepEqual(entry.input.effectiveArguments, { panel: { row: 1 }, tags: ["synthetic"] });
    assert.equal(entry.input.schema.properties.panel.properties.row.type, "integer");
    assert.deepEqual(entry.output.result, { shade: { name: "silver" } });
    assertDigests(journal);
    const resumed = await context.replay();
    assert.equal(resumed.status, "recorded"); assert.equal(context.sent.length, 0);
    assert.deepEqual((await context.storage.json(resumed.artifact)).entries, journal.entries);
});

test("different operation inputs cannot reuse a completed request even with internally valid digests", async t => {
    const context = await setup(t, async function(api) {
        return api.request({ id: "synthetic-input-operation", taskId: api.taskIds[0], protocol: "messages", body: { messages: [{ role: "user", content: "Synthetic original request." }] } });
    });
    const result = await context.replay(), journal = await context.storage.json(result.artifact);
    journal.entries[0].input.body.messages[0].content = "Synthetic different recorded request.";
    journal.entries[0].inputDigest = digest(canonical(journal.entries[0].input));
    await context.storage.writeJson(result.artifact, journal);
    const resumed = await context.replay();
    assert.equal(resumed.status, "stopped"); assert.match(resumed.stop.message, /changed its recorded input/);
    assert.equal(context.sent.length, 1);
    assert.deepEqual((await context.storage.json(result.artifact)).entries, journal.entries);
});

test("unawaited request and tool preparation or execution failures retain handled queue promises", async t => {
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    const context = await setup(t, async function(api) {
        api.request({});
        api.mockTool({});
        api.request({ id: "synthetic-queued-request", taskId: "synthetic-missing-task", protocol: "messages", body: { messages: [] } });
        api.mockTool({ id: "synthetic-queued-tool", caseId: "synthetic-case", taskId: "synthetic-missing-task", turnId: "synthetic-turn", call: { id: "synthetic-call", name: "read_panel", arguments: {} } });
        return { submitted: 4 };
    });
    const result = await context.replay();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(result.status, "recorded");
    assert.equal(result.harnessResult.submitted, 4);
    assert.deepEqual((await context.storage.json(result.artifact)).entries, []);
    assert.equal(context.sent.length, 0);
});

test("tampered request and response evidence is rejected without rewriting damaged journals", async t => {
    const context = await setup(t, async function(api) {
        return api.request({ id: "synthetic-integrity-operation", taskId: api.taskIds[0], protocol: "messages", body: { messages: [{ role: "user", content: "Synthetic intact request." }] } });
    });
    const result = await context.replay(), original = await context.storage.json(result.artifact);
    for (const target of ["input", "output"]) {
        const journal = structuredClone(original);
        if (target === "input") journal.entries[0].input.body.messages.push({ role: "user", content: "Synthetic corrupt append." });
        else journal.entries[0].output.raw = "Synthetic corrupt output.";
        await context.storage.writeJson(result.artifact, journal);
        const before = await context.storage.read(result.artifact);
        await assert.rejects(context.replay(), /journal has changed/);
        assert.deepEqual(await context.storage.read(result.artifact), before);
        assert.equal(context.sent.length, 1);
    }
});
