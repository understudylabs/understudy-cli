import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { canonical, interaction } from "../dist/migrations/interactions.js";
import { decodeCandidate } from "../dist/migrations/protocol.js";
import { reconstructInteractions, readTask } from "../dist/migrations/reconstruct.js";
import { reconstructPartitioned } from "../dist/migrations/partition.js";
import { digest } from "../dist/migrations/storage.js";

// Every event, identity, message, and result in this file is wholly invented.
const user = { role: "user", content: "Inspect the synthetic tiles." };
const scope = {
  organization: { id: "synthetic-organization" },
  project: { id: "synthetic-project", slug: "synthetic-project", name: "Synthetic project" },
  workload: { id: "synthetic-workload", name: "Synthetic workload", captureEnabled: true },
};
const start = (id, arguments_, index) => ({
  ...(index === undefined ? {} : { index }), id, type: "function",
  function: { name: "inspect_synthetic_tile", arguments: arguments_ },
});
const fragment = (arguments_, identity = {}) => ({ ...identity, function: { arguments: arguments_ } });
const event = (toolCalls, finish = null) => ({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: finish }] });
const events = values => values.map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
function stream(fragments, { done = true, finish = "tool_calls" } = {}) {
  return events([...fragments.map(calls => event(calls)), ...(finish === null ? [] : [event([], finish)])]) + (done ? "data: [DONE]\n\n" : "");
}
function legacyStream(fragments, { done = true, finish = "function_call" } = {}) {
  return events([...fragments.map(function_call => ({ choices: [{ delta: { function_call }, finish_reason: null }] })),
    ...(finish === null ? [] : [{ choices: [{ delta: {}, finish_reason: finish }] }])]) + (done ? "data: [DONE]\n\n" : "");
}
function envelope(raw, extra = {}) {
  return {
    request_id: "synthetic-request-first", trace_id: "synthetic-trace",
    workos_org_id: scope.organization.id, project_id: scope.project.id, workload_id: scope.workload.id,
    ts: "2020-01-01T00:00:00.000Z", request_body: { messages: [user] }, response_body: raw, ...extra,
  };
}
function accepted(raw, expected) {
  const candidate = decodeCandidate(raw, "chat"), captured = interaction(envelope(raw));
  assert.equal(candidate.dependency, null);
  assert.equal(candidate.diagnostic, null);
  assert.equal(candidate.invalid, null);
  assert.equal(canonical(candidate.calls), canonical(expected));
  assert.equal(captured.streamComplete, true);
  assert.equal(captured.streamDiagnostic, null);
  const task = reconstructInteractions([captured], "synthetic-source").tasks[0];
  assert.deepEqual(task.exchanges.map(exchange => [exchange.callId, exchange.normalizedArguments]), expected.map(call => [call.id, canonical(call.arguments)]));
  assert.ok(task.exchanges.every(exchange => !exchange.technicalCauses.includes("invalid_tool_arguments")));
  return { candidate, captured, task };
}
function rejected(raw, code) {
  const candidate = decodeCandidate(raw, "chat"), captured = interaction(envelope(raw));
  assert.equal(candidate.dependency, "inference_stream_decode_error");
  assert.equal(candidate.diagnostic.code, code);
  assert.ok(candidate.diagnostic.message.length > 0);
  assert.equal(candidate.invalid, null);
  assert.equal(candidate.terminal, false);
  assert.deepEqual(candidate.calls, []);
  assert.equal(candidate.response, raw);
  assert.equal(captured.response, raw);
  assert.equal(captured.rawResponse, raw);
  assert.equal(captured.streamDiagnostic.code, code);
  assert.equal(captured.terminal, false);
  assert.deepEqual(captured.output, []);
  const task = reconstructInteractions([captured], "synthetic-source").tasks[0];
  assert.equal(task.complete, false);
  assert.ok(task.technicalCauses.includes("capture_stream_decode_error"));
  assert.equal(task.turns[0].rawResponse, raw);
  assert.equal(task.turns[0].streamDiagnostic.code, code);
  assert.deepEqual(task.exchanges, []);
}
const call = (id, tile) => ({ id, name: "inspect_synthetic_tile", arguments: { tile } });

test("indexed parallel tool calls preserve identities and interleaved argument fragments", () => {
  accepted(stream([
    [start("synthetic-call-a", '{"tile":', 2), start("synthetic-call-b", '{"tile":', 0)],
    [fragment("2}", { index: 0 })],
    [fragment("1}", { index: 2 })],
  ]), [call("synthetic-call-a", 1), call("synthetic-call-b", 2)]);
});

test("indexed streams may finish supplying identity metadata after initial arguments", () => {
  accepted(stream([
    [fragment('{"tile":', { index: 0 })],
    [start("synthetic-call-a", "1}", 0)],
  ]), [call("synthetic-call-a", 1)]);
});

test("sequential indexless calls recover only after each preceding container closes", () => {
  accepted(stream([
    [start("synthetic-call-a", '{"tile":')],
    [fragment("1}")],
    [start("synthetic-call-b", '{"tile":')],
    [fragment("2}")],
  ]), [call("synthetic-call-a", 1), call("synthetic-call-b", 2)]);
});

test("explicit identities disambiguate interleaved indexless fragments", () => {
  accepted(stream([
    [start("synthetic-call-a", '{"tile":'), start("synthetic-call-b", '{"tile":')],
    [fragment("2}", { id: "synthetic-call-b" })],
    [fragment("1}", { id: "synthetic-call-a" })],
  ]), [call("synthetic-call-a", 1), call("synthetic-call-b", 2)]);
});

test("anonymous fragments cannot select between open or scalar-prefix indexless calls", () => {
  for (const initial of ['{"tile":', "1"]) {
    rejected(stream([
      [start("synthetic-call-a", initial)],
      [start("synthetic-call-b", '{"tile":')],
      [fragment("2}")],
    ]), "ambiguous_tool_call_boundary");
  }
  rejected(stream([[fragment("{}")]]), "ambiguous_tool_call_boundary");
  rejected(stream([[start("synthetic-call-a", "{")], [{ function: { name: "inspect_synthetic_tile", arguments: "}" } }]]), "ambiguous_tool_call_boundary");
});

test("new indexless calls require their own name and identity", () => {
  rejected(stream([[fragment("{}", { id: "synthetic-call-a" })]]), "missing_tool_call_identity");
});

test("duplicate identities and changes to indexed call identity are rejected", () => {
  const cases = [
    { fragments: [[start("synthetic-call-a", "{}", 0), start("synthetic-call-a", "{}", 1)]], code: "duplicate_tool_call_id" },
    { fragments: [[start("synthetic-call-a", "{}")], [start("synthetic-call-a", "{}")]], code: "duplicate_tool_call_id" },
    { fragments: [[start("synthetic-call-a", '{"tile":')], [start("synthetic-call-a", '1}')]], code: "duplicate_tool_call_id" },
    { fragments: [[start("synthetic-call-a", "{}")], [start("synthetic-call-a", "")]], code: "duplicate_tool_call_id" },
    { fragments: [[start("synthetic-call-a", "{}", 0)], [start("synthetic-call-a", "{}")]], code: "duplicate_tool_call_id" },
    { fragments: [[start("synthetic-call-a", "{", 0)], [fragment("}", { index: 0, id: "synthetic-call-b" })]], code: "conflicting_tool_call_identity" },
    { fragments: [[start("synthetic-call-a", "{", 0)], [{ index: 0, function: { name: "different_synthetic_tool", arguments: "}" } }]], code: "conflicting_tool_call_identity" },
  ];
  for (const value of cases) rejected(stream(value.fragments), value.code);
});

test("invalid indexes are rejected rather than coerced into existing slots", () => {
  for (const index of [null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    rejected(stream([[start("synthetic-call-a", "{}", index)]]), "invalid_tool_call_index");
  }
});

test("invalid tool fragment shapes retain a stream diagnostic instead of coercing arguments", () => {
  for (const malformed of [null, [], "synthetic-fragment", { index: 0, function: [] }, { index: 0, function: null }]) {
    rejected(stream([[start("synthetic-call-a", "{}", 0)], [malformed]]), "invalid_tool_call_fragment");
  }
  rejected(stream([[start("synthetic-call-a", { tile: 1 }, 0)]]), "invalid_tool_call_fragment");
  rejected(events([event({ id: "synthetic-call-a" })]) + "data: [DONE]\n", "invalid_tool_call_fragment");
  rejected(stream([[start("", "{}", 0)]]), "invalid_tool_call_identity");
  rejected(stream([[{ index: 0, id: "synthetic-call-a", function: { name: null, arguments: "{}" } }]]), "invalid_tool_call_identity");
});

test("malformed events and events after completion retain the exact rejected bytes", () => {
  rejected('data: {"choices":broken}\n\ndata: [DONE]\n', "invalid_stream_event");
  rejected("data: []\n\ndata: [DONE]\n", "invalid_stream_event");
  rejected(stream([[start("synthetic-call-a", "{}", 0)]]) + events([event([])]), "event_after_stream_completion");
  rejected(events([event([start("synthetic-call-a", "{", 0)], "tool_calls"), event([fragment("}", { index: 0 })])]) + "data: [DONE]\n", "tool_call_after_finish");
});

test("output after a choice finishes cannot extend accepted text or legacy tool evidence", () => {
  for (const delta of [
    { content: "Late synthetic text." },
    { function_call: { name: "inspect_synthetic_tile", arguments: '{"tile":1}' } },
    { refusal: "Late synthetic refusal." },
  ]) {
    const raw = events([
      { choices: [{ delta: { content: "Synthetic result." }, finish_reason: "stop" }] },
      { choices: [{ delta, finish_reason: null }] },
    ]) + "data: [DONE]\n";
    rejected(raw, "output_after_finish");
  }
});

test("post-finish role metadata, empty deltas, and usage preserve accepted tool evidence", () => {
  const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  const raw = events([
    event([start("synthetic-call-a", '{"tile":1}', 0)]),
    event([], "tool_calls"),
    { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: null }] },
    { choices: [], usage },
  ]) + "data: [DONE]\n";
  const { candidate } = accepted(raw, [call("synthetic-call-a", 1)]);
  assert.deepEqual(candidate.response.usage, usage);
});

test("missing termination or call metadata is incomplete evidence, not invalid model arguments", () => {
  const raws = [
    stream([], { finish: null }),
    stream([[start("synthetic-call-a", "{}", 0)]], { done: false }),
    stream([[start("synthetic-call-a", "{}", 0)]], { finish: null }),
    stream([[start("synthetic-call-a", "{}", 0)]], { finish: "length" }),
    stream([[{ index: 0, function: { name: "inspect_synthetic_tile", arguments: "{}" } }]]),
    stream([[fragment("{}", { index: 0, id: "synthetic-call-a" })]]),
    stream([[{ index: 0, id: "synthetic-call-a", function: { name: "inspect_synthetic_tile" } }]]),
  ];
  for (const raw of raws) {
    const candidate = decodeCandidate(raw, "chat"), captured = interaction(envelope(raw));
    assert.equal(candidate.dependency, "inference_stream_incomplete");
    assert.equal(candidate.diagnostic.code, "inference_stream_incomplete");
    assert.equal(candidate.invalid, null);
    assert.equal(candidate.terminal, false);
    assert.deepEqual(candidate.calls, []);
    assert.equal(captured.streamComplete, false);
    assert.equal(captured.rawResponse, raw);
    const task = reconstructInteractions([captured], "synthetic-source").tasks[0];
    assert.equal(task.complete, false);
    assert.ok(task.technicalCauses.includes("capture_stream_incomplete"));
    assert.equal(task.turns[0].rawResponse, raw);
    assert.ok(task.exchanges.every(exchange => exchange.technicalCauses.includes("capture_stream_incomplete")));
  }
});

test("malformed completed argument JSON remains model invalidity in candidate and capture parsing", () => {
  for (const arguments_ of ['{"tile":', '{"tile":1,"tile":2}', "not-json"]) {
    const raw = stream([[start("synthetic-call-a", arguments_, 0)]]);
    const candidate = decodeCandidate(raw, "chat"), captured = interaction(envelope(raw));
    assert.equal(candidate.dependency, null);
    assert.equal(candidate.diagnostic, null);
    assert.equal(candidate.invalid, "invalid_tool_call");
    assert.equal(captured.streamDiagnostic, null);
    assert.equal(captured.streamComplete, true);
    const task = reconstructInteractions([captured], "synthetic-source").tasks[0];
    assert.equal(task.exchanges[0].arguments, arguments_);
    assert.ok(task.exchanges[0].technicalCauses.includes("invalid_tool_arguments"));
    assert.ok(!task.technicalCauses.includes("capture_stream_decode_error"));
    assert.ok(!task.technicalCauses.includes("capture_stream_incomplete"));
  }
});

test("legacy streamed calls require nontruncated termination, name, and argument-fragment evidence", () => {
  const completeCall = { name: "inspect_synthetic_tile", arguments: '{"tile":1}' };
  const raws = [
    legacyStream([completeCall], { finish: "length" }),
    legacyStream([completeCall], { done: false }),
    legacyStream([completeCall], { finish: null }),
    legacyStream([{ arguments: '{"tile":1}' }]),
    legacyStream([{ name: "", arguments: '{"tile":1}' }]),
    legacyStream([{ name: "inspect_synthetic_tile" }]),
  ];
  for (const raw of raws) {
    const candidate = decodeCandidate(raw, "chat"), captured = interaction(envelope(raw));
    assert.equal(candidate.dependency, "inference_stream_incomplete");
    assert.equal(candidate.diagnostic.code, "inference_stream_incomplete");
    assert.equal(candidate.invalid, null);
    assert.deepEqual(candidate.calls, []);
    assert.equal(candidate.terminal, false);
    assert.equal(captured.streamComplete, false);
    assert.equal(captured.rawResponse, raw);
    const task = reconstructInteractions([captured], "synthetic-source").tasks[0];
    assert.ok(task.technicalCauses.includes("capture_stream_incomplete"));
    assert.equal(task.turns[0].rawResponse, raw);
    assert.equal(task.complete, false);
    assert.ok(task.exchanges.every(exchange => exchange.technicalCauses.includes("capture_stream_incomplete")));
  }
});

test("completed legacy fragments preserve arguments and distinguish explicit empty JSON from missing fragments", () => {
  for (const args of ['{"tile":1}', ""]) {
    const raw = legacyStream([{ name: "inspect_synthetic_tile" }, { arguments: args.slice(0, 4) }, { arguments: args.slice(4) }]);
    const candidate = decodeCandidate(raw, "chat"), captured = interaction(envelope(raw));
    assert.equal(candidate.dependency, null);
    assert.equal(candidate.diagnostic, null);
    // Legacy candidates still lack a tool-call identity; completion classification
    // does not invent one or change the existing candidate compatibility policy.
    assert.equal(candidate.invalid, "invalid_tool_call");
    assert.equal(captured.streamComplete, true);
    assert.equal(captured.streamDiagnostic, null);
    assert.deepEqual(candidate.response.choices[0].message.function_call, { name: "inspect_synthetic_tile", arguments: args });
    const task = reconstructInteractions([captured], "synthetic-source").tasks[0];
    assert.equal(task.technicalCauses.includes("capture_stream_incomplete"), false);
    assert.equal(task.exchanges[0].technicalCauses.includes("invalid_tool_arguments"), args === "");
    if (args === "") assert.equal(task.exchanges[0].arguments, "");
    else assert.equal(task.exchanges[0].normalizedArguments, args);
  }
});

test("malformed legacy stream fragments remain decoder errors rather than coerced model arguments", () => {
  for (const malformed of [null, [], "synthetic-fragment", { name: "inspect_synthetic_tile", arguments: null }, { name: "inspect_synthetic_tile", arguments: 1 }]) {
    rejected(legacyStream([malformed]), "invalid_tool_call_fragment");
  }
});

test("a later captured result cannot make a length-truncated legacy call usable", async () => {
  const call = { name: "inspect_synthetic_tile", arguments: '{"tile":1}' };
  const raw = legacyStream([call], { finish: "length" }), first = envelope(raw);
  const last = envelope({ choices: [{ message: { role: "assistant", content: "Synthetic tile inspected." }, finish_reason: "stop" }] }, {
    request_id: "synthetic-legacy-last", parent_request_id: first.request_id, ts: "2020-01-01T00:01:00.000Z",
    request_body: { messages: [user, { role: "assistant", content: null, function_call: call }, { role: "function", name: call.name, content: "Synthetic legacy result." }] },
  });
  for (const result of [reconstructInteractions([first, last].map(interaction), "synthetic-source"), await partitioned([first, last])]) {
    const task = result.tasks[0];
    assert.equal(task.turns.at(-1).terminal, true);
    assert.equal(task.complete, false);
    assert.equal(task.exchanges[0].hasResult, true);
    assert.ok(task.exchanges[0].technicalCauses.includes("capture_stream_incomplete"));
    assert.equal(task.turns[0].rawResponse, raw);
  }
});

test("explicit IDs preserve malformed argument evidence when another indexless call starts", () => {
  const raw = stream([
    [start("synthetic-call-a", "not-json")],
    [start("synthetic-call-b", '{"tile":')],
    [fragment("2}", { id: "synthetic-call-b" })],
  ]);
  const candidate = decodeCandidate(raw, "chat"), captured = interaction(envelope(raw));
  assert.equal(candidate.dependency, null);
  assert.equal(candidate.invalid, "invalid_tool_call");
  assert.equal(canonical(candidate.calls), canonical([call("synthetic-call-b", 2)]));
  const task = reconstructInteractions([captured], "synthetic-source").tasks[0];
  assert.ok(task.exchanges[0].technicalCauses.includes("invalid_tool_arguments"));
  assert.equal(task.exchanges[1].normalizedArguments, '{"tile":2}');
});

function childOf(first, { explicit = true } = {}) {
  const assistant = { role: "assistant", content: "", tool_calls: [start("synthetic-call-a", '{"tile":1}')] };
  return envelope({ choices: [{ message: { role: "assistant", content: "Synthetic tile inspected." }, finish_reason: "stop" }] }, {
    request_id: "synthetic-request-last", ts: "2020-01-01T00:01:00.000Z",
    ...(explicit ? { parent_request_id: first.request_id } : {}),
    request_body: { messages: [user, assistant, { role: "tool", tool_call_id: "synthetic-call-a", content: "Synthetic tile result." }] },
  });
}

async function partitioned(envelopes) {
  const files = new Map(), run = { runId: "synthetic-run", scope };
  const base = path.join("synthetic-memory", "migration");
  const index = { rows: envelopes.map((value, position) => {
    const bytes = Buffer.from(JSON.stringify(value)), file = `synthetic-${position}.jsonl`;
    files.set(path.join(base, file), bytes);
    return { requestId: value.request_id, file, sha256: digest(bytes), bytes: bytes.length };
  }) };
  const storage = {
    runPath: () => base,
    read: async file => { assert.ok(files.has(file)); return files.get(file); },
    write: async (file, bytes) => { files.set(file, Buffer.from(bytes)); },
    writeJson: async (file, value) => { files.set(file, Buffer.from(JSON.stringify(value))); },
  };
  const result = await reconstructPartitioned(storage, run, index, "synthetic-source", reconstructInteractions);
  return { ...result, summaries: result.tasks,
    savedSummaries: JSON.parse(files.get(path.join(base, "tasks.json")).toString("utf8")).tasks,
    tasks: await Promise.all(result.tasks.map(task => readTask(storage, run, task))) };
}

test("partitioned summaries omit raw stream bodies while verified details preserve the evidence", async () => {
  const raws = [
    stream([[start("synthetic-call-a", '{"tile":1}', 0)]], { done: false }),
    'data: {"choices":broken}\n\ndata: [DONE]\n',
  ];
  for (const raw of raws) {
    const result = await partitioned([envelope(raw)]), detail = result.tasks[0];
    assert.equal(detail.turns[0].rawResponse, raw);
    assert.ok(Object.hasOwn(detail.turns[0], "response"));
    for (const summary of [result.summaries[0], result.savedSummaries[0]]) {
      assert.ok(summary.detail);
      assert.equal(Object.hasOwn(summary.turns[0], "rawResponse"), false);
      assert.equal(Object.hasOwn(summary.turns[0], "response"), false);
      assert.equal(Object.hasOwn(summary.turns[0], "messages"), false);
      assert.deepEqual(summary.turns[0].streamDiagnostic, detail.turns[0].streamDiagnostic);
      assert.deepEqual(summary.technicalCauses, detail.technicalCauses);
    }
  }
});

test("recovered sequential indexless calls reconstruct complete shared capture evidence", async () => {
  const raw = stream([
    [start("synthetic-call-a", '{"tile":')], [fragment("1}")],
    [start("synthetic-call-b", '{"tile":')], [fragment("2}")],
  ]);
  const first = envelope(raw), last = childOf(first, { explicit: false });
  last.request_body.messages[1].tool_calls.push(start("synthetic-call-b", '{"tile":2}'));
  last.request_body.messages.push({ role: "tool", tool_call_id: "synthetic-call-b", content: "Another synthetic tile result." });
  const values = [first, last];
  for (const result of [reconstructInteractions(values.map(interaction), "synthetic-source"), await partitioned(values)]) {
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].complete, true);
    assert.equal(result.tasks[0].exchanges.length, 2);
    assert.ok(result.tasks[0].exchanges.every(exchange => exchange.hasResult && exchange.technicalCauses.length === 0));
  }
});

test("partial captured calls stay unusable after an explicit child supplies a result", async () => {
  const raw = stream([[start("synthetic-call-a", '{"tile":1}', 0)]], { done: false });
  const first = envelope(raw), values = [first, childOf(first)];
  for (const result of [reconstructInteractions(values.map(interaction), "synthetic-source"), await partitioned(values)]) {
    assert.equal(result.tasks.length, 1);
    const task = result.tasks[0];
    assert.equal(task.turns.at(-1).terminal, true);
    assert.equal(task.complete, false);
    assert.equal(task.exchanges[0].hasResult, true);
    assert.ok(task.exchanges[0].technicalCauses.includes("capture_stream_incomplete"));
    assert.equal(task.turns[0].rawResponse, raw);
  }
});

test("a malformed response does not invalidate a tool exchange verified in request history", async () => {
  const first = envelope(stream([[start("synthetic-call-a", '{"tile":1}', 0)]]));
  const child = childOf(first);
  child.response_body = 'data: {"choices":broken}\n\ndata: [DONE]\n';
  const values = [first, child];
  for (const result of [reconstructInteractions(values.map(interaction), "synthetic-source"), await partitioned(values)]) {
    assert.equal(result.tasks.length, 1);
    const task = result.tasks[0];
    assert.equal(task.complete, false);
    assert.ok(task.technicalCauses.includes("capture_stream_decode_error"));
    assert.equal(task.exchanges.length, 1);
    assert.equal(task.exchanges[0].hasResult, true);
    assert.deepEqual(task.exchanges[0].technicalCauses, []);
  }
});

test("rejected captured streams retain diagnosis across direct and partitioned reconstruction", async () => {
  const raw = stream([[start("synthetic-call-a", "{", 0)], [fragment("}", { index: 0, id: "synthetic-call-b" })]]);
  const first = envelope(raw), values = [first, childOf(first)];
  for (const result of [reconstructInteractions(values.map(interaction), "synthetic-source"), await partitioned(values)]) {
    assert.equal(result.tasks.length, 1);
    const task = result.tasks[0];
    assert.equal(task.turns.at(-1).terminal, true);
    assert.equal(task.complete, false);
    assert.ok(task.technicalCauses.includes("capture_stream_decode_error"));
    assert.equal(task.turns[0].response, raw);
    assert.equal(task.turns[0].rawResponse, raw);
    assert.equal(task.turns[0].streamDiagnostic.code, "conflicting_tool_call_identity");
  }
});

test("untrusted streamed output cannot infer a parent from call identity or a history prefix", async () => {
  const raws = [
    stream([[start("synthetic-call-a", '{"tile":1}', 0)]], { done: false }),
    'data: {"choices":broken}\n\ndata: [DONE]\n',
  ];
  for (const raw of raws) {
    const first = envelope(raw), values = [first, childOf(first, { explicit: false })];
    for (const result of [reconstructInteractions(values.map(interaction), "synthetic-source"), await partitioned(values)]) {
      assert.equal(result.tasks.length, 2);
      assert.ok(result.tasks.every(task => task.requestIds.length === 1));
      assert.equal(result.unresolved.length, 0);
    }
  }
});
