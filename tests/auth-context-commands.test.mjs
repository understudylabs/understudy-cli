import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { addAuthenticationCommands } from "../dist/commands/auth.js";
import { addContextCommands } from "../dist/commands/context.js";
import { completeEmailLogin } from "../dist/auth/email.js";

function authHarness(inferenceReady = true, completeEmail) {
  const output = [], seen = [];
  let inputReads = 0;
  const program = new Command().option("--json").exitOverride().configureOutput({ writeErr: () => {} });
  addAuthenticationCommands(program, {
    store: { read: async () => ({ version: 1, method: "organization_key", organizationId: "synthetic-org", apiKey: ["synthetic", "key"].join("-"), keyId: "synthetic-key-id", serviceUrl: "https://gateway.example.test" }), clear: async () => {}, write: async () => {} },
    output: value => output.push(value), loginWithOAuth: async () => seen.push("browser"),
    beginEmail: async email => { seen.push({ email }); return { pending: true, expiresAt: "2030-01-01T00:00:00.000Z" }; },
    readCode: async () => { inputReads++; return "101010"; },
    completeEmail: async code => { seen.push({ code }); return completeEmail ? completeEmail(code) : { authenticated: true, method: "organization_key", organizationId: "synthetic-org", inferenceReady }; },
    whoami: async () => ({ organizationId: "synthetic-org", credentialClass: "organization_key" }),
    clear: async inference => seen.push({ clearInference: inference }),
  });
  return { program, seen, output, get inputReads() { return inputReads; }, run: args => program.parseAsync(["node", "understudy", ...args]) };
}

test("two-step email commands use stdin and do not emit the code or key", async () => {
  const begin = authHarness();
  await begin.run(["--json", "login", "--email", "person@example.test", "--send-code"]);
  assert.equal(JSON.parse(begin.output[0]).pending, true);
  assert.deepEqual(begin.seen, [{ email: "person@example.test" }]);
  const complete = authHarness();
  await complete.run(["--json", "login", "--code"]);
  assert.deepEqual(complete.seen, [{ code: "101010" }]);
  assert.equal(complete.inputReads, 1);
  assert.equal(JSON.parse(complete.output[0]).method, "organization_key");
  assert.doesNotMatch(complete.output.join(""), /101010|synthetic-key/);
});

test("email completion reports preserved inference access requiring attention", async () => {
  const human = authHarness(false);
  await human.run(["login", "--code"]);
  assert.match(human.output.join("\n"), /Existing inference access was preserved/);
  const structured = authHarness(false);
  await structured.run(["--json", "login", "--code"]);
  assert.equal(JSON.parse(structured.output[0]).inferenceReady, false);
});

test("explicit code arguments preserve leading zeros without reading stdin or emitting the code", async () => {
  for (const args of [["login", "--code", "001234"], ["login", "--code=001234", "--json"]]) {
    const h = authHarness();
    await h.run(args);
    assert.deepEqual(h.seen, [{ code: "001234" }]);
    assert.equal(h.inputReads, 0);
    assert.doesNotMatch(h.output.join(""), /001234|synthetic-key/);
    if (args.includes("--json")) assert.equal(JSON.parse(h.output[0]).authenticated, true);
    else assert.match(h.output[0], /Signed in/);
  }
});

test("invalid explicit codes fail validation without falling back to browser login or stdin", async () => {
  for (const code of ["", "12345", "1234567", "synthetic-invalid-code"]) {
    let pendingReads = 0;
    const h = authHarness(true, value => completeEmailLogin({
      pendingStore: { read: async () => { pendingReads++; return null; } },
      fetchImplementation: async () => assert.fail("Unexpected network call"),
    }, value));
    await assert.rejects(h.run(["login", "--code", code]), /six digits/);
    assert.deepEqual(h.seen, [{ code }]);
    assert.equal(h.inputReads, 0);
    assert.equal(pendingReads, 0);
    assert.deepEqual(h.output, []);
  }
});

test("conflicting login modes fail before authentication or input", async () => {
  for (const args of [["login", "--send-code"], ["login", "--code", "--email", "person@example.test"],
    ["login", "--code", "001234", "--send-code"], ["login", "--code", "", "--email", "person@example.test"]]) {
    const h = authHarness();
    await assert.rejects(h.run(args));
    assert.deepEqual(h.seen, []);
    assert.equal(h.inputReads, 0);
  }
});

test("auth status is local while whoami reports verified credential class", async () => {
  const status = authHarness();
  await status.run(["auth", "status", "--json"]);
  assert.equal(JSON.parse(status.output[0]).verification, "local");
  assert.equal(JSON.parse(status.output[0]).oauthOnlyOperations, false);
  const whoami = authHarness();
  await whoami.run(["auth", "whoami", "--json"]);
  assert.equal(JSON.parse(whoami.output[0]).verification, "remote");
  assert.equal(JSON.parse(whoami.output[0]).credentialClass, "organization_key");
});

test("auth clear makes optional local inference removal explicit", async () => {
  const h = authHarness();
  await h.run(["auth", "clear", "--inference", "--json"]);
  assert.deepEqual(h.seen, [{ clearInference: true }]);
  assert.equal(JSON.parse(h.output[0]).remoteRevocation, false);
});

test("context commands expose verified set and explicitly local show", async () => {
  const output = [], selected = [];
  const context = { organizationId: "synthetic-org", project: { id: "synthetic-project", slug: "synthetic-project", name: "Synthetic Project" } };
  const program = new Command().option("--json");
  addContextCommands(program, { output: value => output.push(value), show: async () => context,
    set: async value => { selected.push(value); return context; }, clear: async () => selected.push("clear") });
  await program.parseAsync(["node", "understudy", "context", "set", "--project", "synthetic-project", "--json"]);
  assert.equal(JSON.parse(output.pop()).verification, "remote");
  assert.deepEqual(selected[0], { project: "synthetic-project" });
  await program.parseAsync(["node", "understudy", "context", "show", "--json"]);
  assert.equal(JSON.parse(output.pop()).verification, "local");
});
