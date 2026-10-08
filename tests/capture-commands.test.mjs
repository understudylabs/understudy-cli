import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { addRequestsCommands } from "../dist/commands/requests.js";
import { addCapturesCommands } from "../dist/commands/captures.js";
import { addMigrationCommands } from "../dist/commands/migrations.js";

// Independent synthetic command inputs; no files, credentials, or requests.
function commands() {
  const calls = [], output = [];
  const fake = names => Object.fromEntries(names.map(name => [name, async (...args) => { calls.push([name, ...args]); return { synthetic: "result" }; }]));
  const requests = fake(["list", "show", "trace", "traces", "failureContext"]);
  const captures = fake(["list", "get", "export", "downloadTrace"]);
  const migrations = fake(["verify", "reconstruct", "profile", "tasks", "inspect"]);
  const program = new Command().option("--json").exitOverride().configureOutput({ writeErr() {} });
  addRequestsCommands(program, requests, value => output.push(value));
  addCapturesCommands(program, captures, value => output.push(value));
  addMigrationCommands(program, migrations, value => output.push(value));
  return { program, calls, output, parse: args => program.parseAsync(args, { from: "user" }) };
}

test("request selection forwards the complete supported filter vocabulary", async () => {
  const c = commands();
  await c.parse(["requests", "list", "--org", "synthetic-org", "--project", "synthetic-project", "--workload", "synthetic-workload", "--environment", "test", "--window", "1h", "--outcome", "error", "--status-code", "429", "--error-reason", "rate_limited", "--provider", "managed", "--requested-model", "synthetic-request", "--served-model", "synthetic-served", "--route", "synthetic-route", "--capture-state", "expected", "--include-rejection-details", "--limit", "50", "--all", "--json"]);
  assert.deepEqual(c.calls, [["list", { org: "synthetic-org", project: "synthetic-project", workload: "synthetic-workload", environment: "test", window: "1h", outcome: "error", statusCode: "429", errorReason: "rate_limited", provider: "managed", requestedModel: "synthetic-request", servedModel: "synthetic-served", route: "synthetic-route", captureState: "expected", includeRejectionDetails: true, limit: "50", all: true }]]);
  assert.deepEqual(JSON.parse(c.output[0]), { synthetic: "result" });
});

test("trace commands are removed without aliases or service dispatch", async () => {
  const removed = [["requests", "trace", "synthetic-trace"],
    ...["list", "show", "download", "export", "import", "verify", "reconstruct", "profile", "inspect"].map(name => ["traces", name])];
  for (const args of removed) {
    const c = commands();
    await assert.rejects(c.parse(args), /unknown command/);
    assert.deepEqual(c.calls, [], args.join(" "));
  }
  const { program } = commands();
  assert.equal(program.commands.some(command => command.name() === "traces" || command.aliases().includes("traces")), false);
  assert.deepEqual(program.commands.find(command => command.name() === "requests").commands.map(command => command.name()), ["list", "show"]);
});

test("single request reads keep scope and do not expose trace pagination", async () => {
  const c = commands();
  await c.parse(["requests", "show", "synthetic-request", "--org", "synthetic-org", "--project", "synthetic-project", "--workload", "synthetic-workload", "--environment", "test", "--include-rejection-details"]);
  assert.deepEqual(c.calls, [["show", "synthetic-request", { org: "synthetic-org", project: "synthetic-project", workload: "synthetic-workload", environment: "test", includeRejectionDetails: true }]]);
  assert.match(c.output[0], /\n/); assert.equal(c.output[0].includes("?"), false);
  for (const args of [["--all"], ["--limit", "10"], ["--cursor", "synthetic-cursor"]]) {
    const invalid = commands(); await assert.rejects(invalid.parse(["requests", "show", "synthetic-request", ...args]), /unknown option/);
    assert.deepEqual(invalid.calls, []);
  }
});

test("failure aggregates have no duplicate requests command", async () => {
  const c = commands();
  await assert.rejects(c.parse(["requests", "failure-context"]), /unknown command/);
  assert.deepEqual(c.calls, []);
});

test("stored captures reject feed filters and exports reject misleading pagination", async () => {
  for (const args of [["captures", "list", "--window", "1h"], ["captures", "export", "--cursor", "synthetic-cursor"], ["captures", "export", "--trace-ids-file", "synthetic-ids.txt"]]) {
    const c = commands(); await assert.rejects(c.parse(args), /unknown option/); assert.deepEqual(c.calls, []);
  }
  const c = commands(); await c.parse(["captures", "export", "--project", "synthetic-project", "--window", "7d", "--download-id", "synthetic-download"]);
  assert.deepEqual(c.calls, [["export", { project: "synthetic-project", window: "7d", downloadId: "synthetic-download", resume: true }]]);
});

test("capture list and get retain their scope and explicit payload contracts", async () => {
  const listed = commands();
  await listed.parse(["captures", "list", "--project", "synthetic-project", "--workload", "synthetic-workload", "--environment", "test", "--all"]);
  assert.deepEqual(listed.calls, [["list", { project: "synthetic-project", workload: "synthetic-workload", environment: "test", all: true }]]);
  const fetched = commands();
  await fetched.parse(["captures", "get", "synthetic-request", "--project", "synthetic-project", "--include-payload", "--yes", "--out", ".understudy/synthetic-capture.json"]);
  assert.deepEqual(fetched.calls, [["get", "synthetic-request", { project: "synthetic-project", includePayload: true, yes: true, out: ".understudy/synthetic-capture.json" }]]);
});

test("capture export dispatches indexed dates and rolling windows through the same service", async () => {
  for (const [option, value, field] of [["--date", "2020-01-01", "date"], ["--last", "1d", "last"]]) {
    const c = commands();
    await c.parse(["captures", "export", "--org", "synthetic-org", "--project", "synthetic-project", "--workload", "synthetic-workload", option, value, "--include-payload", "--yes", "--download-id", "synthetic-indexed", "--json"]);
    assert.deepEqual(c.calls, [["export", { org: "synthetic-org", project: "synthetic-project", workload: "synthetic-workload", [field]: value, includePayload: true, yes: true, downloadId: "synthetic-indexed", resume: true }]]);
    assert.deepEqual(JSON.parse(c.output[0]), { synthetic: "result" });
  }
});

test("explicit request exports still use the request selection contract", async () => {
  for (const [args, selection] of [[["synthetic-request"], { requestId: "synthetic-request" }], [["--request-ids-file", ".understudy/synthetic-ids.txt"], { requestIdsFile: ".understudy/synthetic-ids.txt" }]]) {
    const c = commands();
    await c.parse(["captures", "export", ...args, "--project", "synthetic-project", "--download-id", "synthetic-download"]);
    assert.deepEqual(c.calls, [["export", { ...selection, project: "synthetic-project", downloadId: "synthetic-download", resume: true }]]);
  }
});
