import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addStatusCommand } from "../dist/commands/status.js";

function programFor(result, output, exitCodes) {
  const program = new Command().option("--json");
  addStatusCommand(program, {
    status: async () => result,
    output: (message) => output.push(message),
    setExitCode: (code) => exitCodes.push(code),
  });
  return program;
}

const ready = {
  authenticated: true,
  ready: true,
  organizationId: "synthetic-organization",
  management: "connected",
  access: "ready",
  projectCount: 2,
  modelCount: 3,
};

test("status prints a compact readiness summary", async () => {
  const output = [];
  const exitCodes = [];
  await programFor(ready, output, exitCodes).parseAsync([
    "node",
    "understudy",
    "status",
  ]);

  assert.match(output[0], /Login\s+signed in/);
  assert.match(output[0], /Access\s+ready/);
  assert.match(output[0], /Projects\s+2/);
  assert.deepEqual(exitCodes, []);
});

test("status emits JSON and fails readiness checks when setup is required", async () => {
  const output = [];
  const exitCodes = [];
  const result = {
    ...ready,
    ready: false,
    access: "setup-required",
    modelCount: null,
  };
  await programFor(result, output, exitCodes).parseAsync([
    "node",
    "understudy",
    "--json",
    "status",
  ]);

  assert.deepEqual(JSON.parse(output[0]), result);
  assert.deepEqual(exitCodes, [1]);
});

test("status explains a service mismatch and fails readiness", async () => {
  const output = [], exitCodes = [];
  await programFor({ ...ready, ready: false, access: "service-mismatch", modelCount: null }, output, exitCodes)
    .parseAsync(["node", "understudy", "status"]);
  assert.match(output[0], /Access\s+service mismatch/);
  assert.match(output[0], /another service.*setup --replace/);
  assert.deepEqual(exitCodes, [1]);
});
