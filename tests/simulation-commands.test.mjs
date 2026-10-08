import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { addMigrationCommands } from "../dist/commands/migrations.js";

// Wholly invented command inputs; these tests never read files or authenticate.
const harnessArgs = ["replay", "--run", "synthetic-run", "--harness", "synthetic-harness.cjs"];
const liveOptions = ["--model", "synthetic-model", "--max-calls", "3", "--max-output-tokens", "100"];

function command() {
  const calls = [], output = [];
  const service = Object.fromEntries(["migrate", "importRun", "tasks", "inspect", "replay"].map(name => [name, async (...args) => {
    calls.push([name, ...args]);
    return { status: "recorded", counts: {}, directory: "synthetic-directory" };
  }]));
  const program = new Command().option("--json").exitOverride().configureOutput({ writeErr() {} });
  addMigrationCommands(program, service, message => output.push(message));
  return { calls, output, parse: args => program.parseAsync(args, { from: "user" }) };
}

test("offline replay forwards private environment and explicit tool limit without inference settings", async () => {
  const c = command();
  await c.parse([...harnessArgs, "--offline", "--environment", "synthetic-environment.cjs", "--max-tool-calls", "7", "--id", "synthetic-replay", "--json"]);
  assert.deepEqual(c.calls, [["replay", "synthetic-run", {
    harness: "synthetic-harness.cjs", offline: true, environment: "synthetic-environment.cjs", maxToolCalls: 7, id: "synthetic-replay",
  }, undefined]]);
  assert.equal(JSON.parse(c.output[0]).status, "recorded");
});

test("offline recorded replay leaves optional environment and default tool limit to the host", async () => {
  const c = command();
  await c.parse([...harnessArgs, "--offline"]);
  assert.deepEqual(c.calls, [["replay", "synthetic-run", { harness: "synthetic-harness.cjs", offline: true }, undefined]]);
});

test("offline inference settings and targets are rejected before invoking replay", async () => {
  for (const options of [
    ["--model", "synthetic-model"], ["--max-calls", "3"], ["--max-output-tokens", "100"],
    ["--target-project", "synthetic-project"], ["--target-workload", "synthetic-workload"],
    ["--target-project", "synthetic-project", "--target-workload", "synthetic-workload"],
  ]) {
    const c = command();
    await assert.rejects(c.parse([...harnessArgs, "--offline", ...options]), /Offline replay omits/);
    assert.deepEqual(c.calls, [], options.join(" "));
  }
});

test("live replay still requires each inference setting before invoking replay", async () => {
  for (const missing of ["--model", "--max-calls", "--max-output-tokens"]) {
    const c = command(), options = liveOptions.filter((value, index) => value !== missing && liveOptions[index - 1] !== missing);
    await assert.rejects(c.parse([...harnessArgs, ...options]), /requires --model, --max-calls, and --max-output-tokens/);
    assert.deepEqual(c.calls, [], missing);
  }
});

test("live replay forwards environment and tool limit without changing inference settings", async () => {
  const c = command();
  await c.parse([...harnessArgs, ...liveOptions, "--environment", "synthetic-environment.cjs", "--max-tool-calls", "11"]);
  assert.deepEqual(c.calls, [["replay", "synthetic-run", {
    harness: "synthetic-harness.cjs", model: "synthetic-model", maxCalls: 3, maxOutputTokens: 100,
    environment: "synthetic-environment.cjs", maxToolCalls: 11,
  }, undefined]]);
});

test("malformed tool limits are rejected before invoking replay in either mode", async () => {
  for (const mode of [["--offline"], liveOptions]) {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "not-a-count", "9007199254740992"]) {
      const c = command();
      await assert.rejects(c.parse([...harnessArgs, ...mode, "--max-tool-calls", value]), /positive integer/);
      assert.deepEqual(c.calls, [], value);
    }
  }
});

test("positive tool limits are forwarded as numbers", async () => {
  for (const value of ["1", "1000", "10000"]) {
    const c = command();
    await c.parse([...harnessArgs, "--offline", "--max-tool-calls", value]);
    assert.equal(c.calls[0][2].maxToolCalls, Number(value));
  }
});

test("offline replay still requires capture run and private harness", async () => {
  for (const args of [["replay", "--offline", "--harness", "synthetic-harness.cjs"], ["replay", "--offline", "--run", "synthetic-run"]]) {
    const c = command();
    await assert.rejects(c.parse(args), /required option/);
    assert.deepEqual(c.calls, []);
  }
});

test("simulation flags stay confined to harness replay", async () => {
  for (const prefix of [["migrate", "--project", "synthetic-project", "--workload", "synthetic-workload"]]) {
    for (const options of [["--offline"], ["--environment", "synthetic-environment.cjs"], ["--max-tool-calls", "5"]]) {
      const c = command();
      await assert.rejects(c.parse([...prefix, ...options]), /unknown option/);
      assert.deepEqual(c.calls, []);
    }
  }
});
