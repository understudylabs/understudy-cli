import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addBenchmarksCommands } from "../dist/commands/benchmarks.js";

const report = {
  project: { id: "synthetic-project", slug: "fictional", name: "Fictional" },
  workload: { id: "synthetic-workload", name: "writer" },
  publication: {
    name: "Fictional comparison", published_at: "2030-01-01T00:00:00Z",
    model_count: 2, task_count: 3,
  },
  recommendation: { headline: "Try model A", summary: "Fictional evidence." },
  arms: [{ arm_id: "a", model: "example/model-a", display_name: "A", role: "recommended", score: 0.8 }],
  hasPromptDiff: true,
  reportAvailable: true,
  manifestBytes: 2048,
};

function setup() {
  const calls = [];
  const output = [];
  const program = new Command().option("--json").exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  addBenchmarksCommands(program, {
    list: async () => ({ workloads: [{ project_slug: "fictional", workload_name: "writer", benchmark: report.publication }] }),
    show: async (input) => {
      calls.push(input);
      return input.includeReport ? { ...report, benchmark: { report: { prompt_change: { diff: ["Invented prompt line"] } } } } : report;
    },
  }, (message) => output.push(message));
  return { program, calls, output };
}

test("benchmarks show prints a summary and forwards saved-context selection", async () => {
  const { program, calls, output } = setup();
  await program.parseAsync(["node", "understudy", "benchmarks", "show"]);
  assert.deepEqual(calls, [{}]);
  assert.match(output[0], /Recommend  Try model A/);
  assert.match(output[0], /--include-report --json/);
  assert.match(output[0], /2048 bytes/);
  assert.doesNotMatch(output[0], /Invented prompt line/);
});

test("benchmarks show gives an agent the full JSON report only when requested", async () => {
  const { program, calls, output } = setup();
  await program.parseAsync(["node", "understudy", "--json", "benchmarks", "show", "--project", "fictional", "--workload", "writer", "--include-report"]);
  assert.deepEqual(calls, [{ includeReport: true, project: "fictional", workload: "writer" }]);
  assert.equal(JSON.parse(output[0]).benchmark.report.prompt_change.diff[0], "Invented prompt line");
});

test("benchmarks list prints available publications", async () => {
  const { program, output } = setup();
  await program.parseAsync(["node", "understudy", "benchmarks", "list"]);
  assert.match(output[0], /fictional\/writer  Fictional comparison/);
});
