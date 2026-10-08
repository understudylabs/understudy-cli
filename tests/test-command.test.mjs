import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addTestCommand } from "../dist/commands/test.js";

function createProgram(output, calls) {
  const program = new Command().option("--json");
  addTestCommand(program, {
    test: async (options) => {
      calls.push(options);
      return {
        ok: true,
        requestEnvironment: "test",
        api: options.api,
        requestId: "synthetic-request",
        project: options.project,
        workload: options.workload,
        requestedModel: options.model,
        effectiveModel: options.model,
        mode: "managed",
        route: "primary",
        latencyMs: 25,
      };
    },
    output: (message) => output.push(message),
  });
  return program;
}

const argumentsList = [
  "test",
  "--api",
  "openai",
  "--model",
  "synthetic-model",
  "--project",
  "synthetic-project",
  "--workload",
  "synthetic-workload",
];

test("test command prints concise evidence", async () => {
  const output = [];
  const calls = [];
  await createProgram(output, calls).parseAsync([
    "node",
    "understudy",
    ...argumentsList,
  ]);

  assert.deepEqual(calls, [
    {
      api: "openai",
      model: "synthetic-model",
      project: "synthetic-project",
      workload: "synthetic-workload",
    },
  ]);
  assert.match(output[0], /test passed/i);
  assert.match(output[0], /synthetic-request/);
  assert.match(output[0], /API\s+openai/);
  assert.match(output[0], /Environment\s+test/);
});

test("test command supports structured output", async () => {
  const output = [];
  await createProgram(output, []).parseAsync([
    "node",
    "understudy",
    "--json",
    ...argumentsList,
  ]);

  const result = JSON.parse(output[0]);
  assert.equal(result.ok, true);
  assert.equal(result.requestEnvironment, "test");
  assert.equal(result.api, "openai");
  assert.equal(result.requestId, "synthetic-request");
  assert.equal(result.route, "primary");
});

test("test command rejects selectors before sending traffic", async () => {
  const calls = [];
  await assert.rejects(
    createProgram([], calls).parseAsync([
      "node",
      "understudy",
      "test",
      "--api",
      "openai",
      "--model",
      "synthetic model",
      "--project",
      "synthetic-project",
      "--workload",
      "synthetic-workload",
    ]),
    /invalid model/i,
  );
  assert.deepEqual(calls, []);
});

test("test command rejects an unknown inference API before sending traffic", async () => {
  const calls = [];
  await assert.rejects(
    createProgram([], calls).parseAsync([
      "node",
      "understudy",
      "test",
      "--api",
      "responses",
      "--model",
      "synthetic-model",
      "--project",
      "synthetic-project",
      "--workload",
      "synthetic-workload",
    ]),
    /invalid API/i,
  );
  assert.deepEqual(calls, []);
});
