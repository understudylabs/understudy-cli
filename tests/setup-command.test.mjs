import assert from "node:assert/strict";
import test from "node:test";

import { createCli } from "../dist/cli.js";

const authDependencies = {
  store: {
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
  },
  output: () => undefined,
  loginWithOAuth: async () => undefined,
};

async function runSetup(status, args = []) {
  const output = [];
  let setups = 0;
  let replace;
  const setupDependencies = {
    setup: async (shouldReplace) => {
      setups += 1;
      replace = shouldReplace;
      return { status };
    },
    output: (message) => output.push(message),
  };

  await createCli(authDependencies, setupDependencies).parseAsync([
    "node",
    "understudy",
    "setup",
    ...args,
  ]);
  return { output, replace, setups };
}

test("setup reports a newly stored application credential", async () => {
  const result = await runSetup("created");

  assert.equal(result.setups, 1);
  assert.equal(result.replace, false);
  assert.match(result.output[0], /^Private CLI inference access is ready\./);
  assert.match(result.output[0], /ask your agent to use setup-understudy/);
});

test("setup reuses existing access without creating another key", async () => {
  const result = await runSetup("existing");

  assert.equal(result.setups, 1);
  assert.equal(result.replace, false);
  assert.match(result.output[0], /^Private CLI inference access is already ready\./);
});

test("setup can explicitly replace stored inference access", async () => {
  const result = await runSetup("replaced", ["--replace"]);

  assert.equal(result.setups, 1);
  assert.equal(result.replace, true);
  assert.match(result.output[0], /^Private CLI inference access replaced\./);
});

test("setup supports structured output", async () => {
  const output = [];
  const setupDependencies = {
    setup: async () => ({ status: "existing" }),
    output: (message) => output.push(message),
  };

  await createCli(authDependencies, setupDependencies).parseAsync([
    "node",
    "understudy",
    "--json",
    "setup",
  ]);

  assert.deepEqual(JSON.parse(output[0]), {
    ready: true,
    status: "existing",
  });
});
