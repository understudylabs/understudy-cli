import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { execWithKey } from "../dist/keys/exec.js";
import { keyCredentialReference } from "../dist/keys/credentials.js";
import { addKeysCommands } from "../dist/commands/keys.js";

const org = "synthetic-organization";
const serviceUrl = "https://example.test";
const value = ["synthetic", "execution", "credential"].join("-");
const stored = { version: 1, organizationId: org, keyId: "synthetic-key", serviceUrl, value };
const reference = keyCredentialReference(serviceUrl, org, stored.keyId);
const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Date.now() / 1000 + 3600 })).toString("base64url");
function options(overrides = {}) {
  return { store: { read: async () => ({ version: 1, method: "oauth", accessToken: `synthetic.${claims}.signature` }) },
    baseUrl: serviceUrl, keyStoreFactory: () => ({ read: async () => stored }), environment: { SYNTHETIC_PARENT: "preserved" }, ...overrides };
}

test("private key exec binds org and service and injects only the child environment", async () => {
  const environment = { SYNTHETIC_PARENT: "preserved" };
  let launches = 0;
  const code = await execWithKey(options({ environment, launch: async (command, args, env) => {
    launches++;
    assert.equal(command, "synthetic-program");
    assert.deepEqual(args, ["--synthetic-flag"]);
    assert.equal(args.includes(value), false);
    assert.equal(env.UNDERSTUDY_API_KEY, value);
    assert.equal(env.UNDERSTUDY_GATEWAY_URL, serviceUrl);
    assert.equal(env.UNDERSTUDY_ORG_ID, org);
    assert.equal(env.SYNTHETIC_PARENT, "preserved");
    return 7;
  } }), { reference, command: "synthetic-program", args: ["--synthetic-flag"] });
  assert.equal(code, 7);
  assert.equal(launches, 1);
  assert.deepEqual(environment, { SYNTHETIC_PARENT: "preserved" });
});

for (const patch of [{ organizationId: "synthetic-other-org" }, { serviceUrl: "https://other.example.test" }]) {
  test("a saved key for another identity or service cannot launch a child", async () => {
    const other = { ...stored, ...patch };
    const otherReference = keyCredentialReference(other.serviceUrl, other.organizationId, other.keyId);
    let launches = 0;
    await assert.rejects(execWithKey(options({ keyStoreFactory: () => ({ read: async () => other }), launch: async () => { launches++; return 0; } }),
      { reference: otherReference, command: "synthetic-program" }), /active organization and service/);
    assert.equal(launches, 0);
  });
}

test("launch failures never expose child arguments or credential values", async () => {
  await assert.rejects(execWithKey(options({ launch: async () => { throw new Error(value); } }), { reference, command: "synthetic-program" }), error => {
    assert.doesNotMatch(error.message, /synthetic-execution-credential/);
    assert.match(error.message, /could not be started/);
    return true;
  });
});

test("keys exec passes child flags after -- and preserves exit status without CLI output", async () => {
  const calls = [];
  let exitCode;
  const program = new Command().option("--json").exitOverride();
  addKeysCommands(program, { exec: async input => { calls.push(input); return 9; }, setExitCode: code => { exitCode = code; },
    output: () => { throw new Error("No parent output expected"); } });
  await program.parseAsync(["node", "understudy", "keys", "exec", reference, "--", "synthetic-program", "--json", "--help"]);
  assert.deepEqual(calls, [{ reference, command: "synthetic-program", args: ["--json", "--help"] }]);
  assert.equal(exitCode, 9);
});

test("keys exec refuses parent JSON mode before launching", async () => {
  const program = new Command().option("--json").exitOverride();
  addKeysCommands(program, { exec: async () => { throw new Error("Must not launch"); }, output: () => {} });
  await assert.rejects(program.parseAsync(["node", "understudy", "--json", "keys", "exec", reference, "--", "synthetic-program"]), /does not support --json/);
});
