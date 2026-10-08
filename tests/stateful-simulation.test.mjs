// Every scope, capture, note, handler, and result in this file is independently invented.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import { addMigrationCommands } from "../dist/commands/migrations.js";
import { createMigrationService } from "../dist/migrations/service.js";
import { runHarness } from "../dist/migrations/harness.js";
import { MigrationStorage, digest } from "../dist/migrations/storage.js";
import { canonical } from "../dist/migrations/interactions.js";

const scope = {
  organization: { id: "synthetic-organization" },
  project: { id: "synthetic-project", slug: "synthetic-project", name: "Synthetic project" },
  workload: { id: "synthetic-workload", name: "Synthetic workload", captureEnabled: true },
};
const objectSchema = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const writeSchema = {
  ...objectSchema({ key: { type: "string", minLength: 1 }, text: { type: "string" } }),
  properties: { key: { type: "string", minLength: 1 }, text: { type: "string" }, fail: { type: "boolean" } },
};
const readSchema = objectSchema({ key: { type: "string" } });
const stateSchema = objectSchema({ notes: { type: "object", additionalProperties: { type: "string" } }, writes: { type: "integer", minimum: 0 } });
function environmentSource({ version = "synthetic-environment-v1", initialState = { notes: {}, writes: 0 }, writeHandler, tools, tests } = {}) {
  const handler = writeHandler ?? function ({ arguments: args, state }) {
    if (args.fail) {
      state.notes[args.key] = "Uncommitted mutation from the failed handler.";
      state.writes++;
      return { failure: "write_denied", result: { reason: "Synthetic storage denied this write." } };
    }
    state.notes[args.key] = args.text;
    state.writes++;
    return { result: { stored: true }, state };
  };
  return `module.exports = {
    schemaVersion: 1,
    version: ${JSON.stringify(version)},
    stateSchema: ${JSON.stringify(stateSchema)},
    initialState: ${JSON.stringify(initialState)},
    context: { timestamp: "2000-01-01T00:00:00.000Z", generatedId: "synthetic-note" },
    tools: ${tools ?? `{
      write_note: {
        version: "synthetic-write-v1",
        inputSchema: ${JSON.stringify(writeSchema)},
        outputSchema: ${JSON.stringify(objectSchema({ stored: { type: "boolean" } }))},
        failures: { write_denied: ${JSON.stringify(objectSchema({ reason: { type: "string" } }))} },
        handler: ${handler.toString()}
      },
      read_note: {
        version: "synthetic-read-v1",
        inputSchema: ${JSON.stringify(readSchema)},
        outputSchema: ${JSON.stringify(objectSchema({ text: { type: ["string", "null"] }, writes: { type: "integer" } }))},
        handler({ arguments: args, state }) { return { result: { text: state.notes[args.key] ?? null, writes: state.writes }, state }; }
      }
    }`},
    tests: ${JSON.stringify(tests ?? [{ id: "synthetic-write-read-contract", steps: [
      { tool: "write_note", arguments: { key: "contract", text: "The invented blue kite belongs on the shelf." }, expect: { result: { stored: true }, state: { notes: { contract: "The invented blue kite belongs on the shelf." }, writes: 1 } } },
      { tool: "read_note", arguments: { key: "contract" }, expect: { result: { text: "The invented blue kite belongs on the shelf.", writes: 1 } } },
    ] }])}
  };\n`;
}

async function setup(t, harness, source = environmentSource(), { recordedInstruction = false } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "synthetic-stateful-tools-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const storage = new MigrationStorage(home), access = [];
  const forbidden = name => async () => { access.push(name); throw new Error(`Unexpected ${name} during offline simulation`); };
  const options = { cwd: home, store: { read: forbidden("credential read"), write: forbidden("credential write"), clear: forbidden("credential clear") }, credential: forbidden("inference credential"), fetchImplementation: forbidden("network") };
  const service = createMigrationService(options);
  const directory = path.join(storage.root, "synthetic-input");
  const tools = [{ name: "write_note", input_schema: writeSchema }, { name: "read_note", input_schema: readSchema }];
  const capture = {
    request_id: "synthetic-captured-request", workos_org_id: scope.organization.id, project_id: scope.project.id,
    workload_id: scope.workload.id, trace_id: "synthetic-captured-trace", ts: "2000-01-01T00:00:00.000Z", endpoint: "/v1/messages",
    request_body: { model: "synthetic-recorded-model", messages: [{ role: "user", content: "Store a note saying the blue kite belongs on the shelf, then read it." }], tools, max_tokens: 100 },
    response_body: { role: "assistant", content: [{ type: "text", text: "Synthetic capture only declares the task and its tools." }], stop_reason: "end_turn" },
  };
  const captures = [capture];
  if (recordedInstruction) {
    tools.push({ name: "read_instruction", input_schema: objectSchema({ slot: { type: "integer" } }) });
    const action = { role: "assistant", content: [{ type: "tool_use", id: "synthetic-recorded-call", name: "read_instruction", input: { slot: 1 } }] };
    capture.response_body = { ...action, stop_reason: "tool_use" };
    captures.push({
      ...capture, request_id: "synthetic-captured-continuation", parent_request_id: capture.request_id, ts: "2000-01-01T00:01:00.000Z",
      request_body: { ...capture.request_body, messages: [...capture.request_body.messages, action, { role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-recorded-call", content: "The invented blue kite belongs on the shelf." }] }] },
      response_body: { role: "assistant", content: [{ type: "text", text: "The invented instruction was read." }], stop_reason: "end_turn" },
    });
  }
  const index = path.join(directory, "index.jsonl"), scopeFile = path.join(directory, "scope.json"), rows = [];
  for (const [position, capture] of captures.entries()) {
    const bytes = JSON.stringify(capture), file = `capture-${position}.jsonl`;
    await storage.write(path.join(directory, file), bytes);
    rows.push({ file, request_id: capture.request_id, size: Buffer.byteLength(bytes), content_sha256: digest(bytes) });
  }
  await storage.write(index, rows.map(row => JSON.stringify(row)).join("\n"));
  await storage.writeJson(scopeFile, scope);
  const run = await service.importRun({ scope: scopeFile, index, runId: "synthetic-stateful-run" });
  await service.prepareCaptures(run.runId);
  const input = { id: "synthetic-simulation", harness: path.join(directory, "harness.cjs"), environment: path.join(directory, "environment.cjs"), offline: true };
  const writeHarness = async fn => storage.write(input.harness, `module.exports = ${fn.toString()};\n`);
  await writeHarness(harness);
  await storage.write(input.environment, source);
  t.after(() => assert.deepEqual(access, [], "offline simulation must never read credentials or reach transport"));
  return { home, storage, service, run, options, input, writeHarness, journal: result => storage.json(result.artifact) };
}

async function writeReadHarness(api) {
  const taskId = api.taskIds[0], turnId = "turn-1", caseId = "synthetic-case", attemptId = "synthetic-attempt";
  const write = await api.simulateTool({ id: "write", taskId, turnId, caseId, attemptId, call: { id: "candidate-write", name: "write_note", arguments: { key: "kite", text: "Put the blue kite on the shelf." } } });
  const read = await api.simulateTool({ id: "read", taskId, turnId, caseId, attemptId, call: { id: "candidate-read", name: "read_note", arguments: { key: "kite" } } });
  return { write, read };
}

function simulationEntries(journal) { return journal.entries.filter(entry => entry.kind === "simulation"); }
function assertIntegrity(journal) {
  for (const entry of journal.entries) {
    assert.equal(entry.inputDigest, digest(canonical(entry.input)), `input integrity for ${entry.id}`);
    if (entry.state === "recorded") assert.equal(entry.outputDigest, digest(canonical(entry.output)), `output integrity for ${entry.id}`);
    if (entry.kind === "simulation" && entry.output?.receipt) {
      const receipt = entry.output.receipt;
      assert.equal(receipt.stateBeforeDigest, digest(canonical(receipt.stateBefore)), `prior state integrity for ${entry.id}`);
      assert.equal(receipt.stateAfterDigest, digest(canonical(receipt.stateAfter)), `next state integrity for ${entry.id}`);
      assert.equal(typeof receipt.contractVersion, "string");
      assert.match(receipt.environmentDigest, /^[a-f0-9]{64}$/);
      if (entry.output.provenance === "simulated") assert.equal(typeof receipt.handlerVersion, "string");
    }
  }
}

test("the real offline replay command stores two novel phrasings and evaluates the artifact separately", async t => {
  const c = await setup(t, async function (api) {
    const results = [];
    const notes = ["Put the blue kite on the shelf.", "The shelf is where the blue kite belongs.", "Leave the orange ball in the garden."];
    for (const [number, text] of notes.entries()) {
      const common = { taskId: api.taskIds[0], turnId: "turn-1", caseId: `case-${number}`, attemptId: "attempt-one" };
      const write = await api.simulateTool({ ...common, id: `write-${number}`, call: { id: `call-write-${number}`, name: "write_note", arguments: { key: "kite", text } } });
      const read = await api.simulateTool({ ...common, id: `read-${number}`, call: { id: `call-read-${number}`, name: "read_note", arguments: { key: "kite" } } });
      // This evaluator belongs to the private harness. Successful storage alone is insufficient.
      const answerCorrect = read.result.text.includes("blue kite") && read.result.text.includes("shelf");
      results.push({ write, read, answerCorrect });
    }
    return results;
  });
  const output = [];
  const cli = new Command().option("--json").exitOverride().configureOutput({ writeErr: () => {} });
  addMigrationCommands(cli, c.service, value => output.push(value));
  await cli.parseAsync(["replay", "--offline", "--run", c.run.runId, "--id", c.input.id, "--harness", c.input.harness, "--environment", c.input.environment, "--json"], { from: "user" });
  const result = JSON.parse(output.join("\n")), journal = await c.journal(result);
  assert.equal(result.status, "recorded");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.environmentValidation.valid, true);
  assert.ok(result.environmentValidation.coverage.every(tool => tool.status === "verified"));
  assert.ok(result.environmentValidation.tests.every(contract => contract.passed && contract.reproducible));
  assert.deepEqual(await c.storage.json(result.environmentArtifact), result.environmentValidation);
  assert.deepEqual(result.harnessResult.map(row => row.answerCorrect), [true, true, false]);
  for (const row of result.harnessResult) {
    assert.equal(row.write.isError, false);
    assert.equal(row.write.provenance, "simulated");
    assert.equal(row.write.productionAction, false);
    assert.equal(row.read.result.writes, 1);
  }
  assert.equal(simulationEntries(journal).length, 6);
  assertIntegrity(journal);
  const again = await c.service.replay(c.run.runId, c.input);
  assert.deepEqual(again.harnessResult, result.harnessResult);
  assert.equal(simulationEntries(await c.journal(again)).length, 6);
});

test("invalid arguments and declared write failures leave state unchanged and are recoverable", async t => {
  const c = await setup(t, async function (api) {
    const common = { taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", attemptId: "attempt" };
    const rejected = await api.simulateTool({ ...common, id: "invalid", call: { id: "invalid-call", name: "write_note", arguments: { key: "kite", text: 7 } } });
    const failed = await api.simulateTool({ ...common, id: "failure", call: { id: "failure-call", name: "write_note", arguments: { key: "kite", text: "A blue kite sits on the shelf.", fail: true } } });
    const read = await api.simulateTool({ ...common, id: "read", call: { id: "read-call", name: "read_note", arguments: { key: "kite" } } });
    const recovered = await api.simulateTool({ ...common, id: "recovered", call: { id: "recovered-call", name: "write_note", arguments: { key: "kite", text: "The blue kite is on the shelf." } } });
    return { rejected, failed, read, recovered };
  });
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  assert.equal(result.status, "recorded");
  assert.equal(result.harnessResult.rejected.isError, true);
  assert.equal(result.harnessResult.rejected.result.error.code, "invalid_tool_arguments");
  assert.equal(result.harnessResult.failed.isError, true);
  assert.deepEqual(result.harnessResult.failed.result, { reason: "Synthetic storage denied this write." });
  assert.deepEqual(result.harnessResult.read.result, { text: null, writes: 0 });
  assert.equal(result.harnessResult.recovered.isError, false);
  for (const entry of simulationEntries(journal).slice(0, 2)) assert.deepEqual(entry.output.receipt.stateBefore, entry.output.receipt.stateAfter);
  assertIntegrity(journal);
});

test("parallel invocation order is deterministic and state is isolated by case and attempt", async t => {
  const c = await setup(t, async function (api) {
    const common = { taskId: api.taskIds[0], turnId: "turn-1", caseId: "first", attemptId: "first" };
    const ordered = await Promise.all([
      api.simulateTool({ ...common, id: "write-first", call: { id: "one", name: "write_note", arguments: { key: "kite", text: "First invented note." } } }),
      api.simulateTool({ ...common, id: "write-second", call: { id: "two", name: "write_note", arguments: { key: "kite", text: "Second invented note." } } }),
      api.simulateTool({ ...common, id: "read-first", call: { id: "three", name: "read_note", arguments: { key: "kite" } } }),
    ]);
    const otherCase = await api.simulateTool({ ...common, caseId: "second", id: "read-other-case", call: { id: "four", name: "read_note", arguments: { key: "kite" } } });
    const otherAttempt = await api.simulateTool({ ...common, attemptId: "second", id: "read-other-attempt", call: { id: "five", name: "read_note", arguments: { key: "kite" } } });
    return { ordered, otherCase, otherAttempt };
  });
  const result = await c.service.replay(c.run.runId, c.input);
  assert.equal(result.status, "recorded");
  assert.deepEqual(result.harnessResult.ordered[2].result, { text: "Second invented note.", writes: 2 });
  assert.deepEqual(result.harnessResult.otherCase.result, { text: null, writes: 0 });
  assert.deepEqual(result.harnessResult.otherAttempt.result, { text: null, writes: 0 });
  assert.deepEqual(simulationEntries(await c.journal(result)).map(entry => entry.id), ["write-first", "write-second", "read-first", "read-other-case", "read-other-attempt"]);
});

test("mutable simulation inputs are snapped at invocation and returned receipts cannot alter stored evidence", async t => {
  const c = await setup(t, async function (api) {
    const common = { taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", attemptId: "attempt" };
    const input = { ...common, id: "write", context: { clock: { tick: 1 } }, call: { id: "write-call", name: "write_note", arguments: { key: "kite", text: "Original invented note." } } };
    const pending = api.simulateTool(input);
    input.call.arguments.text = "Mutation before queued execution.";
    input.context.clock.tick = 2;
    const written = await pending;
    input.call.arguments.text = "Mutation after completion.";
    written.receipt.stateAfter.notes.kite = "Mutation of returned state.";
    written.result.stored = false;
    const read = await api.simulateTool({ ...common, id: "read", call: { id: "read-call", name: "read_note", arguments: { key: "kite" } } });
    return read;
  });
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result), entry = simulationEntries(journal)[0];
  assert.equal(result.status, "recorded");
  assert.deepEqual(result.harnessResult.result, { text: "Original invented note.", writes: 1 });
  assert.equal(entry.input.call.arguments.text, "Original invented note.");
  assert.equal(entry.input.context.clock.tick, 1);
  assert.equal(entry.output.result.stored, true);
  assert.equal(entry.output.receipt.stateAfter.notes.kite, "Original invented note.");
  assertIntegrity(journal);
  const again = await c.service.replay(c.run.runId, c.input);
  assert.deepEqual(again.harnessResult, result.harnessResult);
  assertIntegrity(await c.journal(again));
});

test("duplicate simulation operation ids stop without applying a second effect", async t => {
  const c = await setup(t, async function (api) {
    const operation = { taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", attemptId: "attempt", id: "same-id", call: { id: "same-call", name: "write_note", arguments: { key: "kite", text: "One invented write." } } };
    await api.simulateTool(operation);
    await api.simulateTool(operation);
  });
  const result = await c.service.replay(c.run.runId, c.input), entries = simulationEntries(await c.journal(result));
  assert.equal(result.status, "stopped");
  assert.match(result.stop.message, /unique|duplicate/i);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].output.receipt.stateAfter.writes, 1);
});

test("tampered simulation inputs or outputs are rejected without rewriting the journal", async t => {
  for (const field of ["input", "output"]) {
    const c = await setup(t, writeReadHarness), result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
    const entry = simulationEntries(journal)[0];
    if (field === "input") entry.input.call.arguments.text = "Tampered invented note.";
    else entry.output.receipt.stateAfter.notes.kite = "Tampered invented note.";
    await c.storage.writeJson(result.artifact, journal);
    const before = await c.storage.read(result.artifact);
    await assert.rejects(c.service.replay(c.run.runId, c.input), /journal.*changed|integrity/i);
    assert.deepEqual(await c.storage.read(result.artifact), before);
  }
});

test("handler versions, initial state, and environment source changes require a new replay id", async t => {
  for (const changed of [
    environmentSource().replace('version: "synthetic-write-v1"', 'version: "synthetic-write-v2"'),
    environmentSource({ initialState: { notes: {}, writes: 4 }, tests: [] }),
    `${environmentSource()}\n// A reviewed environment revision changes identity.\n`,
  ]) {
    const c = await setup(t, writeReadHarness), result = await c.service.replay(c.run.runId, c.input), before = await c.storage.read(result.artifact);
    await c.storage.write(c.input.environment, changed);
    await assert.rejects(c.service.replay(c.run.runId, c.input), /match|changed|new replay id/i);
    assert.deepEqual(await c.storage.read(result.artifact), before);
  }
});

test("changed original operation inputs cannot reuse a recorded effect even if an input digest is recomputed", async t => {
  const c = await setup(t, writeReadHarness), result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  const entry = simulationEntries(journal)[0];
  entry.input.call.arguments.text = "A different invented candidate input.";
  entry.inputDigest = digest(canonical(entry.input));
  await c.storage.writeJson(result.artifact, journal);
  const before = await c.storage.read(result.artifact);
  const resumed = await c.service.replay(c.run.runId, c.input).catch(error => error);
  if (resumed instanceof Error) assert.match(resumed.message, /changed|match|integrity/i);
  else {
    assert.equal(resumed.status, "stopped");
    assert.match(resumed.stop.message, /changed|match|integrity/i);
    assert.equal(simulationEntries(await c.journal(resumed)).length, 2);
  }
  // A rejected resume may add a stop explanation; it must retain the damaged operation as evidence.
  const after = await c.storage.json(result.artifact);
  assert.deepEqual(after.entries, JSON.parse(before).entries);
});

test("a crash before or after transition persistence resumes one committed write exactly once", async t => {
  for (const boundary of ["before", "after"]) {
    const c = await setup(t, writeReadHarness), originalWrite = c.storage.writeJson.bind(c.storage);
    let failed = false;
    c.storage.writeJson = async (file, value) => {
      const firstWrite = path.basename(file) === "journal.json" && value?.entries?.some(entry => entry.kind === "simulation" && entry.id === "write" && entry.state === "recorded");
      if (!failed && firstWrite) {
        failed = true;
        if (boundary === "after") await originalWrite(file, value);
        throw new Error(`Synthetic crash ${boundary} atomic transition persistence`);
      }
      return originalWrite(file, value);
    };
    let interrupted;
    try { interrupted = await runHarness(c.storage, c.run, c.input, c.options); } catch (error) { interrupted = error; }
    assert.equal(failed, true);
    if (!(interrupted instanceof Error)) {
      assert.equal(interrupted.status, "stopped");
      assert.equal(interrupted.harnessResult, null, "no successful write may be exposed across a failed persistence boundary");
    }
    c.storage.writeJson = originalWrite;
    const interruptedJournal = await c.storage.json(path.join(c.storage.runPath(c.run.runId), "replays", c.input.id, "journal.json"));
    assert.equal(simulationEntries(interruptedJournal).length, boundary === "before" ? 0 : 1);
    assertIntegrity(interruptedJournal);
    const resumed = await c.service.replay(c.run.runId, c.input), journal = await c.journal(resumed);
    assert.equal(resumed.status, "recorded");
    assert.equal(resumed.harnessResult.write.result.stored, true);
    assert.deepEqual(resumed.harnessResult.read.result, { text: "Put the blue kite on the shelf.", writes: 1 });
    assert.deepEqual(simulationEntries(journal).map(entry => entry.id), ["write", "read"]);
    assertIntegrity(journal);
    assert.deepEqual((await c.service.replay(c.run.runId, c.input)).harnessResult, resumed.harnessResult);
  }
});

test("a missing recording stops as an environment gap and never returns a model repair instruction", async t => {
  const c = await setup(t, async function (api) {
    const out = await api.mockTool({ id: "unrecorded-write", taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", call: { id: "novel-write", name: "write_note", arguments: { key: "kite", text: "A valid novel note." } } });
    return { modelVisible: out };
  });
  delete c.input.environment;
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  assert.equal(result.status, "stopped");
  assert.equal(result.stop.code, "recorded_result_unavailable");
  assert.equal(result.harnessResult, null);
  assert.equal(journal.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(journal.entries[0].output), /correct the call|correct.*arguments/i);
});

test("a missing simulation handler stops as an environment gap rather than returning success", async t => {
  const c = await setup(t, async function (api) {
    return api.simulateTool({ id: "missing", taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", attemptId: "attempt", call: { id: "missing-call", name: "missing_synthetic_tool", arguments: { key: "kite" } } });
  });
  const result = await c.service.replay(c.run.runId, c.input);
  assert.equal(result.status, "stopped");
  assert.match(result.stop.code, /environment|handler/);
  assert.equal(result.harnessResult, null);
  const journal = await c.journal(result);
  assert.doesNotMatch(JSON.stringify(journal.entries), /correct the call|correct.*arguments/i);
});

test("offline preflight distinguishes assumed and unsupported environment coverage without running the harness", async t => {
  const sources = [
    { source: environmentSource({ tests: [] }), status: "assumed" },
    { source: environmentSource().replace("handler({ arguments: args, state })", "missingHandler({ arguments: args, state })"), status: "unsupported" },
    { source: environmentSource().replace(`inputSchema: ${JSON.stringify(writeSchema)}`, 'inputSchema: { $ref: "https://example.test/unsupported-schema" }'), status: "unsupported" },
    { source: environmentSource().replace('version: "synthetic-write-v1"', 'version: ""'), status: "unsupported" },
    { source: environmentSource({ tests: [{ id: "incorrect-contract", steps: [{ tool: "read_note", arguments: { key: "absent" }, expect: { result: { text: "Incorrect invented expectation.", writes: 0 } } }] }] }), status: "unsupported" },
  ];
  for (const fixture of sources) {
    const c = await setup(t, async function () { throw new Error("The harness must not run before environment validation."); }, fixture.source);
    const result = await c.service.replay(c.run.runId, c.input);
    assert.equal(result.status, "stopped");
    assert.equal(result.stop.code, "tool_environment_invalid");
    assert.equal(result.modelCalls, 0);
    assert.equal(result.harnessResult, null);
    assert.equal(result.environmentValidation.valid, false);
    assert.ok(result.environmentValidation.coverage.some(tool => tool.status === fixture.status));
    assert.deepEqual(await c.storage.json(result.environmentArtifact), result.environmentValidation);
  }
});

test("offline preflight rejects invalid initial state and ambient nondeterminism", async t => {
  const sources = [
    environmentSource({ initialState: { notes: [], writes: 0 }, tests: [] }),
    environmentSource({ writeHandler: function ({ arguments: args, state }) {
      state.notes[args.key] = `${args.text} ${Math.random()}`;
      state.writes++;
      return { result: { stored: true }, state };
    } }),
  ];
  for (const source of sources) {
    const c = await setup(t, writeReadHarness, source), result = await c.service.replay(c.run.runId, c.input);
    assert.equal(result.stop.code, "tool_environment_invalid");
    assert.equal(result.environmentValidation.valid, false);
    assert.ok(result.environmentValidation.problems.length > 0 || result.environmentValidation.tests.some(contract => !contract.passed));
    assert.equal(result.modelCalls, 0);
    assert.equal(result.harnessResult, null);
  }
});

test("handler mutations do not change original candidate arguments in the simulation journal", async t => {
  const c = await setup(t, writeReadHarness, environmentSource({ writeHandler: function ({ arguments: args, state }) {
    state.notes[args.key] = args.text;
    state.writes++;
    args.text = "Mutation inside the independently invented handler.";
    return { result: { stored: true }, state };
  } }));
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  assert.equal(result.status, "recorded");
  assert.equal(result.harnessResult.read.result.text, "Put the blue kite on the shelf.");
  assert.equal(simulationEntries(journal)[0].input.call.arguments.text, "Put the blue kite on the shelf.");
  assertIntegrity(journal);
});

test("runtime invalid outputs and undeclared failures are environment gaps with no committed state change", async t => {
  const handlers = [
    function ({ arguments: args, state }) {
      state.notes[args.key] = args.text; state.writes++;
      return { result: { stored: args.key === "contract" ? true : "invalid-output" }, state };
    },
    function ({ arguments: args, state }) {
      state.notes[args.key] = args.text; state.writes++;
      return args.key === "contract" ? { result: { stored: true }, state } : { failure: "undeclared_failure", result: { reason: "Invented unsupported failure." } };
    },
    function ({ arguments: args, state }) {
      state.notes[args.key] = args.text; state.writes++;
      return args.key === "contract" ? { result: { stored: true }, state } : { result: { stored: true }, state, silentlyDropped: undefined };
    },
  ];
  for (const writeHandler of handlers) {
    const c = await setup(t, writeReadHarness, environmentSource({ writeHandler }));
    const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
    assert.equal(result.environmentValidation.valid, true, "the targeted runtime branch is explicitly outside the tested contract cases");
    assert.equal(result.status, "stopped");
    assert.equal(result.harnessResult, null);
    assert.equal(simulationEntries(journal).length, 1);
    const output = simulationEntries(journal)[0].output;
    assert.equal(output.provenance, "environment_gap");
    assert.equal(Object.hasOwn(output, "result"), false, "an environment gap must not be offered to the model as a tool error");
    if (output.receipt) assert.deepEqual(output.receipt.stateAfter, output.receipt.stateBefore);
    assertIntegrity(journal);
  }
});

test("explicit clock and generated identity inputs reproduce the same simulated state on resume", async t => {
  const timestamp = "2000-01-01T00:00:00.000Z";
  const c = await setup(t, async function (api) {
    const common = { taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", attemptId: "attempt" };
    await api.simulateTool({ ...common, id: "write", context: { timestamp: "2000-01-02T00:00:00.000Z", generatedId: "explicit-note" }, call: { id: "write-call", name: "write_note", arguments: { key: "kite", text: "The invented blue kite is on the shelf." } } });
    return api.simulateTool({ ...common, id: "read", call: { id: "read-call", name: "read_note", arguments: { key: "kite" } } });
  }, environmentSource({
    writeHandler: function ({ arguments: args, state, context, operation }) {
      state.notes[args.key] = `${args.text}|${context.timestamp}|${context.generatedId}|${operation.id}`;
      state.writes++;
      return { result: { stored: true }, state };
    },
    tests: [{ id: "explicit-inputs", steps: [
      { tool: "write_note", arguments: { key: "contract", text: "Invented contract note." }, context: { timestamp, generatedId: "contract-note" }, operation: { id: "contract-write" }, expect: { result: { stored: true } } },
      { tool: "read_note", arguments: { key: "contract" }, expect: { result: { text: `Invented contract note.|${timestamp}|contract-note|contract-write`, writes: 1 } } },
    ] }],
  }));
  const result = await c.service.replay(c.run.runId, c.input);
  assert.equal(result.status, "recorded");
  assert.deepEqual(result.harnessResult.result, { text: "The invented blue kite is on the shelf.|2000-01-02T00:00:00.000Z|explicit-note|write", writes: 1 });
  assert.deepEqual((await c.service.replay(c.run.runId, c.input)).harnessResult, result.harnessResult);
  assertIntegrity(await c.journal(result));
});

test("reordered transitions and changed execution limits cannot reinterpret a saved simulation", async t => {
  const c = await setup(t, writeReadHarness), result = await c.service.replay(c.run.runId, c.input), original = await c.storage.read(result.artifact);
  await assert.rejects(c.service.replay(c.run.runId, { ...c.input, maxToolCalls: 7 }), /match|changed|new replay id/i);
  assert.deepEqual(await c.storage.read(result.artifact), original);
  const journal = JSON.parse(original);
  journal.entries.reverse();
  await c.storage.writeJson(result.artifact, journal);
  const resumed = await c.service.replay(c.run.runId, c.input).catch(error => error);
  if (resumed instanceof Error) assert.match(resumed.message, /state|order|changed|match|integrity/i);
  else {
    assert.equal(resumed.status, "stopped");
    assert.match(resumed.stop.message, /state|order|changed|match|integrity/i);
  }
  assert.deepEqual((await c.storage.json(result.artifact)).entries, journal.entries);
});

test("a caught environment gap cannot become a completed task or allow later queued effects", async t => {
  const c = await setup(t, async function (api) {
    const common = { taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", attemptId: "attempt" };
    await Promise.allSettled([
      api.simulateTool({ ...common, id: "missing", call: { id: "missing-call", name: "missing_synthetic_tool", arguments: {} } }),
      api.simulateTool({ ...common, id: "queued-write", call: { id: "queued-call", name: "write_note", arguments: { key: "kite", text: "A write after the environment gap." } } }),
    ]);
    try { await api.simulateTool({ ...common, id: "later-read", call: { id: "read-call", name: "read_note", arguments: { key: "kite" } } }); } catch {}
    return { incorrectlyClaimedComplete: true };
  });
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  assert.equal(result.status, "stopped");
  assert.match(result.stop.code, /environment|handler/);
  assert.deepEqual(simulationEntries(journal).map(entry => entry.id), ["missing"]);
  assert.equal(simulationEntries(journal)[0].output.provenance, "environment_gap");
});

test("offline replay cannot enter model transport even when the private harness requests inference", async t => {
  const c = await setup(t, async function (api) {
    return api.request({ id: "offline-request", taskId: api.taskIds[0], protocol: "messages", body: { messages: [{ role: "user", content: "Synthetic offline request must not be sent." }] } });
  });
  const result = await c.service.replay(c.run.runId, c.input);
  assert.equal(result.status, "stopped");
  assert.match(result.stop.code, /offline/);
  assert.equal(result.modelCalls, 0);
  assert.equal((await c.journal(result)).entries.filter(entry => entry.kind === "model").length, 0);
});

test("a newly verified source revision cannot reuse an earlier simulation journal", async t => {
  const c = await setup(t, writeReadHarness), result = await c.service.replay(c.run.runId, c.input), before = await c.storage.read(result.artifact);
  const base = c.storage.runPath(c.run.runId), indexFile = path.join(base, "captures.json"), index = await c.storage.json(indexFile);
  const capture = await c.storage.json(path.join(base, index.rows[0].file));
  capture.request_body.messages[0].content = "An independently revised synthetic task asks for a yellow kite on the shelf.";
  const bytes = JSON.stringify(capture), sha256 = digest(bytes), file = `captures/${sha256}.jsonl`;
  await c.storage.write(path.join(base, file), bytes);
  index.rows[0] = { ...index.rows[0], file, sha256, bytes: Buffer.byteLength(bytes) };
  await c.storage.writeJson(indexFile, index);
  await c.service.prepareCaptures(c.run.runId);
  await assert.rejects(c.service.replay(c.run.runId, c.input), /match|changed|new replay id/i);
  assert.deepEqual(await c.storage.read(result.artifact), before);
});

test("a mixed environment preserves exact recorded returns alongside new simulated write and read receipts", async t => {
  const source = environmentSource().replace("schemaVersion: 1,", 'schemaVersion: 1, recordedTools: ["read_instruction"],');
  const c = await setup(t, async function (api) {
    const common = { taskId: api.taskIds[0], turnId: "turn-1", caseId: "mixed-case" };
    const recorded = await api.mockTool({ ...common, id: "recorded", call: { id: "candidate-recorded", name: "read_instruction", arguments: { slot: 1 } } });
    const write = await api.simulateTool({ ...common, attemptId: "attempt-one", id: "write", call: { id: "candidate-write", name: "write_note", arguments: { key: "kite", text: "Place the blue kite on its shelf." } } });
    const read = await api.simulateTool({ ...common, attemptId: "attempt-one", id: "read", call: { id: "candidate-read", name: "read_note", arguments: { key: "kite" } } });
    return { recorded, write, read };
  }, source, { recordedInstruction: true });
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  assert.equal(result.status, "recorded");
  assert.equal(result.environmentValidation.valid, true);
  assert.deepEqual(result.environmentValidation.coverage.filter(tool => tool.name === "read_instruction").map(tool => [tool.mode, tool.status]), [["recorded", "assumed"]]);
  assert.equal(result.harnessResult.recorded.provenance, "recorded");
  assert.equal(typeof result.harnessResult.recorded.fixtureKey, "string");
  assert.equal(result.harnessResult.recorded.result, "The invented blue kite belongs on the shelf.");
  assert.equal(result.harnessResult.write.provenance, "simulated");
  assert.equal(result.harnessResult.read.provenance, "simulated");
  assert.deepEqual(result.harnessResult.read.result, { text: "Place the blue kite on its shelf.", writes: 1 });
  assert.deepEqual(journal.entries.map(entry => entry.kind), ["tool", "simulation", "simulation"]);
  assertIntegrity(journal);
  assert.deepEqual((await c.service.replay(c.run.runId, c.input)).harnessResult, result.harnessResult);
});

test("the tool-operation budget includes committed effects and remains enforced across resume", async t => {
  const c = await setup(t, writeReadHarness);
  c.input.maxToolCalls = 1;
  const result = await c.service.replay(c.run.runId, c.input), firstJournal = await c.journal(result);
  assert.equal(result.status, "stopped");
  assert.equal(result.stop.code, "tool_budget_exhausted");
  assert.equal(result.harnessResult, null);
  assert.equal(simulationEntries(firstJournal).length, 1);
  assert.equal(simulationEntries(firstJournal)[0].output.receipt.stateAfter.writes, 1);
  const resumed = await c.service.replay(c.run.runId, c.input), resumedJournal = await c.journal(resumed);
  assert.equal(resumed.stop.code, "tool_budget_exhausted");
  assert.deepEqual(resumedJournal.entries, firstJournal.entries);
  assertIntegrity(resumedJournal);
});

test("a committed null state remains distinct from the initial state through read and unchanged resume", async t => {
  const initial = { notes: {}, writes: 0 };
  const source = environmentSource({ writeHandler: function ({ arguments: args, state }) {
    if (args.key !== "contract") return { result: { stored: true }, state: null };
    state.notes[args.key] = args.text; state.writes++;
    return { result: { stored: true }, state };
  } })
    .replace(`stateSchema: ${JSON.stringify(stateSchema)}`, `stateSchema: ${JSON.stringify({ anyOf: [stateSchema, { type: "null" }] })}`)
    .replace("handler({ arguments: args, state }) { return", "handler({ arguments: args, state }) { if (state === null) return { result: { text: null, writes: 0 }, state: null }; return");
  const c = await setup(t, writeReadHarness, source), result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result), entries = simulationEntries(journal);
  assert.equal(result.status, "recorded");
  assert.deepEqual(entries[0].output.receipt.stateBefore, initial);
  assert.equal(entries[0].output.receipt.stateAfter, null);
  assert.equal(entries[1].output.receipt.stateBefore, null);
  assert.equal(entries[1].output.receipt.stateAfter, null);
  assert.deepEqual(result.harnessResult.read.result, { text: null, writes: 0 });
  const resumed = await c.service.replay(c.run.runId, c.input);
  assert.equal(resumed.status, "recorded");
  assert.deepEqual(resumed.harnessResult, result.harnessResult);
  assert.deepEqual((await c.journal(resumed)).entries, journal.entries);
  assertIntegrity(await c.journal(resumed));
});

test("an invalid environment attempt pins its preflight identity and report before any successful replay exists", async t => {
  const invalidSource = environmentSource({ tests: [] });
  const c = await setup(t, writeReadHarness, invalidSource);
  const first = await c.service.replay(c.run.runId, c.input);
  assert.equal(first.stop.code, "tool_environment_invalid");
  const preflight = path.join(c.storage.runPath(c.run.runId), "replays", c.input.id, "preflight.json");
  const originalPreflight = await c.storage.read(preflight), originalReport = await c.storage.read(first.environmentArtifact);
  const unchanged = await c.service.replay(c.run.runId, c.input);
  assert.deepEqual(unchanged.environmentValidation, first.environmentValidation);
  assert.deepEqual(await c.storage.read(preflight), originalPreflight);
  assert.deepEqual(await c.storage.read(first.environmentArtifact), originalReport);
  const originalHarness = await c.storage.read(c.input.harness);
  for (const change of ["environment", "harness", "limits"]) {
    if (change === "environment") await c.storage.write(c.input.environment, environmentSource());
    if (change === "harness") await c.storage.write(c.input.harness, Buffer.concat([originalHarness, Buffer.from("\n// Synthetic harness revision.\n")]));
    const input = change === "limits" ? { ...c.input, maxToolCalls: 5 } : c.input;
    await assert.rejects(c.service.replay(c.run.runId, input), /match|changed|new replay id/i);
    assert.deepEqual(await c.storage.read(preflight), originalPreflight);
    assert.deepEqual(await c.storage.read(first.environmentArtifact), originalReport);
    await c.storage.write(c.input.environment, invalidSource);
    await c.storage.write(c.input.harness, originalHarness);
  }
  await assert.rejects(c.storage.read(first.artifact), { code: "ENOENT" });
});

test("tampered preflight reports are rejected without silently recreating their original contents", async t => {
  const c = await setup(t, writeReadHarness, environmentSource({ tests: [] }));
  const first = await c.service.replay(c.run.runId, c.input);
  const preflight = path.join(c.storage.runPath(c.run.runId), "replays", c.input.id, "preflight.json");
  const originalPreflight = await c.storage.read(preflight);
  const damaged = await c.storage.json(first.environmentArtifact);
  damaged.scope = "Synthetic report tampering must remain visible.";
  await c.storage.writeJson(first.environmentArtifact, damaged);
  const before = await c.storage.read(first.environmentArtifact);
  await assert.rejects(c.service.replay(c.run.runId, c.input), /preflight|report|changed|integrity/i);
  assert.deepEqual(await c.storage.read(preflight), originalPreflight);
  assert.deepEqual(await c.storage.read(first.environmentArtifact), before);
});

test("an interrupted preflight report write retains its binding and resumes only unchanged inputs", async t => {
  for (const boundary of ["before", "after"]) {
    const invalidSource = environmentSource({ tests: [] });
    const c = await setup(t, writeReadHarness, invalidSource), originalWrite = c.storage.writeJson.bind(c.storage);
    const directory = path.join(c.storage.runPath(c.run.runId), "replays", c.input.id);
    const preflight = path.join(directory, "preflight.json"), report = path.join(directory, "environment-validation.json");
    let failed = false;
    c.storage.writeJson = async (file, value) => {
      if (!failed && path.basename(file) === "environment-validation.json") {
        failed = true;
        if (boundary === "after") await originalWrite(file, value);
        throw new Error(`Synthetic interruption ${boundary} preflight report persistence.`);
      }
      return originalWrite(file, value);
    };
    await assert.rejects(runHarness(c.storage, c.run, c.input, c.options));
    assert.equal(failed, true);
    c.storage.writeJson = originalWrite;
    const binding = await c.storage.read(preflight);
    const savedReport = boundary === "after" ? await c.storage.read(report) : null;
    if (boundary === "before") await assert.rejects(c.storage.read(report), { code: "ENOENT" });
    await c.storage.write(c.input.environment, environmentSource());
    await assert.rejects(c.service.replay(c.run.runId, c.input), /match|changed|new replay id/i);
    assert.deepEqual(await c.storage.read(preflight), binding);
    if (savedReport) assert.deepEqual(await c.storage.read(report), savedReport);
    else await assert.rejects(c.storage.read(report), { code: "ENOENT" });
    await c.storage.write(c.input.environment, invalidSource);
    const resumed = await c.service.replay(c.run.runId, c.input);
    assert.equal(resumed.stop.code, "tool_environment_invalid");
    assert.equal(resumed.modelCalls, 0);
    assert.equal(resumed.environmentValidation.valid, false);
    assert.deepEqual(await c.storage.read(preflight), binding);
    assert.deepEqual(await c.storage.json(report), resumed.environmentValidation);
    if (savedReport) assert.deepEqual(await c.storage.read(report), savedReport);
  }
});

test("a reviewed simulated tool cannot consume an available exact recording through mockTool", async t => {
  const instruction = "The invented blue kite belongs on the shelf.";
  const source = environmentSource()
    .replace("tools: {", `tools: { read_instruction: { version: "synthetic-instruction-v1", inputSchema: ${JSON.stringify(objectSchema({ slot: { type: "integer" } }))}, outputSchema: { type: "string" }, handler({ state }) { return { result: ${JSON.stringify(instruction)}, state }; } },`)
    .replace("tests: [", `tests: [${JSON.stringify({ id: "instruction-contract", steps: [{ tool: "read_instruction", arguments: { slot: 1 }, expect: { result: instruction } }] })},`);
  const c = await setup(t, async function (api) {
    return api.mockTool({ id: "wrong-mode", taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", call: { id: "candidate", name: "read_instruction", arguments: { slot: 1 } } });
  }, source, { recordedInstruction: true });
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  assert.equal(result.environmentValidation.valid, true);
  assert.equal(result.environmentValidation.coverage.find(tool => tool.name === "read_instruction").mode, "simulated");
  assert.equal(result.status, "stopped");
  assert.equal(result.stop.code, "tool_environment_mode_mismatch");
  assert.equal(result.harnessResult, null);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].output.provenance, "environment_gap");
  assert.equal(Object.hasOwn(journal.entries[0].output, "result"), false);
  assert.equal(Object.hasOwn(journal.entries[0].output, "fixtureKey"), false);
  const resumed = await c.service.replay(c.run.runId, c.input);
  assert.equal(resumed.stop.code, "tool_environment_mode_mismatch");
  assert.deepEqual((await c.journal(resumed)).entries, journal.entries);
  // Explicitly invent the incompatible saved receipt that the former mode bypass
  // could create. Valid entry digests must not make that prior result reusable.
  const historical = structuredClone(journal), entry = historical.entries[0];
  entry.output = { id: "candidate", provenance: "recorded", isError: false, result: instruction, fixtureKey: canonical(["case", entry.input.taskId, "turn-1", "read_instruction", canonical({ slot: 1 }), 0]) };
  entry.outputDigest = digest(canonical(entry.output));
  historical.harnessResult = entry.output;
  delete historical.stop;
  await c.storage.writeJson(result.artifact, historical);
  const historicalBytes = await c.storage.read(result.artifact);
  await assert.rejects(c.service.replay(c.run.runId, c.input), /mode|environment|changed/i);
  assert.deepEqual(await c.storage.read(result.artifact), historicalBytes);
});

test("a tool reserved for recorded replay cannot be invoked through simulateTool", async t => {
  const source = environmentSource().replace("schemaVersion: 1,", 'schemaVersion: 1, recordedTools: ["read_instruction"],');
  const c = await setup(t, async function (api) {
    return api.simulateTool({ id: "wrong-mode", taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", attemptId: "attempt", call: { id: "candidate", name: "read_instruction", arguments: { slot: 1 } } });
  }, source, { recordedInstruction: true });
  const result = await c.service.replay(c.run.runId, c.input), journal = await c.journal(result);
  assert.equal(result.environmentValidation.valid, true);
  assert.equal(result.environmentValidation.coverage.find(tool => tool.name === "read_instruction").mode, "recorded");
  assert.equal(result.status, "stopped");
  assert.equal(result.stop.code, "tool_environment_mode_mismatch");
  assert.equal(result.harnessResult, null);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].output.provenance, "environment_gap");
  assert.equal(Object.hasOwn(journal.entries[0].output, "result"), false);
});

test("strict recorded replay still returns exact fixtures when no tool environment is supplied", async t => {
  const c = await setup(t, async function (api) {
    return api.mockTool({ id: "recorded", taskId: api.taskIds[0], turnId: "turn-1", caseId: "case", call: { id: "candidate", name: "read_instruction", arguments: { slot: 1 } } });
  }, environmentSource(), { recordedInstruction: true });
  delete c.input.environment;
  const result = await c.service.replay(c.run.runId, c.input);
  assert.equal(result.status, "recorded");
  assert.equal(result.environmentValidation, null);
  assert.equal(result.harnessResult.provenance, "recorded");
  assert.equal(result.harnessResult.result, "The invented blue kite belongs on the shelf.");
  assert.equal(result.modelCalls, 0);
  assert.deepEqual((await c.service.replay(c.run.runId, c.input)).harnessResult, result.harnessResult);
});

test("a historical report without a preflight binding is preserved and requires a new replay id", async t => {
  const c = await setup(t, writeReadHarness, environmentSource({ tests: [] }));
  const first = await c.service.replay(c.run.runId, c.input);
  const preflight = path.join(c.storage.runPath(c.run.runId), "replays", c.input.id, "preflight.json");
  const reportBytes = await c.storage.read(first.environmentArtifact);
  await rm(preflight);
  await assert.rejects(c.service.replay(c.run.runId, c.input), /preflight|binding|new replay id|changed/i);
  assert.deepEqual(await c.storage.read(first.environmentArtifact), reportBytes);
  await assert.rejects(c.storage.read(preflight), { code: "ENOENT" });
});

test("environment inventory discovery does not cache captured payloads for later harness task reads", async t => {
  const c = await setup(t, async function (api) { return api.task(api.taskIds[0]); });
  const index = await c.storage.json(path.join(c.storage.runPath(c.run.runId), "captures.json"));
  const captureFile = path.join(c.storage.runPath(c.run.runId), index.rows[0].file);
  const originalRead = c.storage.read.bind(c.storage), originalWrite = c.storage.writeJson.bind(c.storage);
  let captureReads = 0, readsAtPreflight = 0, changed = false;
  c.storage.read = async (...args) => {
    if (args[0] === captureFile) captureReads++;
    return originalRead(...args);
  };
  c.storage.writeJson = async (file, value) => {
    await originalWrite(file, value);
    if (!changed && path.basename(file) === "preflight.json") {
      // Inventory and validation have completed. A later API task read must own
      // a fresh verified payload, rather than reuse the inventory's cached copy.
      changed = true;
      readsAtPreflight = captureReads;
      const capture = JSON.parse(await originalRead(captureFile));
      capture.request_body.messages[0].content = "Synthetic capture changed after environment inventory.";
      await c.storage.write(captureFile, JSON.stringify(capture));
    }
  };
  const result = await runHarness(c.storage, c.run, c.input, c.options);
  assert.equal(changed, true);
  assert.ok(captureReads > readsAtPreflight, "the selected task must reread its capture after inventory discovery");
  assert.equal(result.environmentValidation.valid, true);
  assert.equal(result.status, "stopped");
  assert.match(result.stop.message, /captured request.*changed|capture.*integrity/i);
  assert.equal(result.harnessResult, null);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual((await c.journal(result)).entries, []);
});
