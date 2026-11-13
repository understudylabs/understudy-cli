import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addEvaluatorsCommands } from "../dist/commands/evaluators.js";
import { addExperimentsCommands } from "../dist/commands/experiments.js";

// Wholly invented values.
const experiment = {
  id: "synthetic-experiment",
  name: "Fictional pilot",
  status: "active",
  request_environment: "production",
  target_tag: "cohort",
  target_values: ["trial", "beta"],
  control_model: "example/control-model",
  candidate_model: "example/candidate-model",
  candidate_percent: 20,
  created_at_ms: Date.parse("2030-02-01T00:00:00Z"),
  updated_at_ms: Date.parse("2030-02-02T00:00:00Z"),
  project_id: "synthetic-project",
  project_slug: "fictional",
  project_name: "Fictional",
  workload_id: "synthetic-workload",
  workload_name: "writer",
};

const arm = (variant, model, rated, rate) => ({
  variant, assigned_model: model, traces_judged: rated, rated_traces: rated, passed_traces: Math.round(rated * (rate?.value ?? 0)),
  trace_pass_rate: rate, priced_traces: rated, unpriced_traces: 0, cost_per_trace_usd: 0.0021, skips: {},
});

const results = {
  experiment,
  evaluator: { id: "synthetic-evaluator", name: "Fictional quality", status: "active", version: 2, versionId: "synthetic-version" },
  range: { from: "2030-02-01T00:00:00.000Z", to: "2030-03-01T00:00:00.000Z", clampedToMaxRange: false },
  control: arm("control", experiment.control_model, 60, { value: 0.75, low: 0.63, high: 0.84 }),
  candidate: arm("candidate", experiment.candidate_model, 12, null),
  candidateMinusControl: null,
  minimumRatedTraces: 30,
  notes: ["Results use evaluator version 2 only; activating another version restarts the comparison."],
};

const evaluator = {
  id: "synthetic-evaluator",
  name: "Fictional quality",
  status: "active",
  score_from: "2030-02-01T00:00:00.000Z",
  project_id: "synthetic-project",
  project_name: "Fictional",
  project_slug: "fictional",
  workload_id: "synthetic-workload",
  workload_name: "writer",
  version: {
    id: "synthetic-version", version: 2, judge_model: null,
    rubrics: [{
      name: "valid_json", implementation: "deterministic", pass_when: "The reply is JSON.", fail_when: "The reply is not JSON.",
      check: { type: "json_schema", target: { from: "final_response" }, schema: { type: "object" } },
    }],
  },
};

function setup() {
  const calls = [];
  const output = [];
  const program = new Command().option("--json").exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  const record = (name, value) => async (input) => { calls.push([name, input]); return value; };
  addExperimentsCommands(program, {
    list: record("experiments.list", { experiments: [experiment], possiblyTruncated: true }),
    show: record("experiments.show", experiment),
    results: record("experiments.results", results),
  }, (message) => output.push(message));
  addEvaluatorsCommands(program, {
    list: record("evaluators.list", { evaluators: [] }),
    show: record("evaluators.show", { evaluator, experiments: [] }),
    summary: record("evaluators.summary", {}),
    scores: record("evaluators.scores", {
      evaluatorId: evaluator.id, evaluatorVersionId: "synthetic-version", reasonsIncluded: false,
      scores: [{ request_id: "synthetic-request", trace_ended_at: "2030-02-28T12:00:00.000Z", model: "example/control-model", rubric: "valid_json", verdict: "fail" }],
      nextCursor: "synthetic-cursor",
    }),
  }, (message) => output.push(message));
  const run = (...args) => program.parseAsync(["node", "understudy", ...args]);
  return { calls, output, run };
}

test("experiments list forwards filters and flags a possibly truncated page", async () => {
  const { calls, output, run } = setup();
  await run("experiments", "list", "--project", "fictional", "--workload", "writer", "--status", "active");
  assert.deepEqual(calls, [["experiments.list", { project: "fictional", workload: "writer", status: "active" }]]);
  assert.match(output[0], /example\/control-model -> example\/candidate-model 20%/);
  assert.match(output[0], /older experiments may be missing/);
});

test("experiments show summarizes the audience without printing tag values", async () => {
  const { output, run } = setup();
  await run("experiments", "show", "synthetic-experiment");
  assert.match(output[0], /sessions tagged cohort with one of 2 value\(s\)/);
  assert.doesNotMatch(output[0], /trial/);
});

test("experiments results shows both arms and an explicit insufficient-data state", async () => {
  const { calls, output, run } = setup();
  await run("experiments", "results", "synthetic-experiment", "--from", "2030-02-01");
  assert.deepEqual(calls, [["experiments.results", { experiment: "synthetic-experiment", from: "2030-02-01" }]]);
  assert.match(output[0], /control +example\/control-model  rated 60  pass 75\.0% \[63\.0%, 84\.0%\]/);
  assert.match(output[0], /candidate +example\/candidate-model  rated 12  pass rate needs 30 rated traces/);
  assert.match(output[0], /Difference  not enough rated traces in both arms/);
  assert.match(output[0], /Note: Results use evaluator version 2 only/);
});

test("experiment and evaluator JSON output returns the service result", async () => {
  const { output, run } = setup();
  await run("--json", "experiments", "results", "synthetic-experiment");
  assert.equal(JSON.parse(output[0]).control.assigned_model, "example/control-model");
  await run("--json", "evaluators", "show", "synthetic-evaluator");
  assert.equal(JSON.parse(output[1]).evaluator.version.rubrics[0].check.type, "json_schema");
});

test("evaluators show selects by id or by saved/explicit workload", async () => {
  const { calls, output, run } = setup();
  await run("evaluators", "show");
  await run("evaluators", "show", "--project", "fictional", "--workload", "writer");
  await run("evaluators", "show", "synthetic-evaluator");
  assert.deepEqual(calls.map(([, input]) => input), [
    {},
    { project: "fictional", workload: "writer" },
    { evaluator: "synthetic-evaluator" },
  ]);
  assert.match(output[0], /Judge       none \(code checks only\)/);
  assert.match(output[0], /valid_json \[code check: json_schema\]/);
});

test("evaluators scores forwards filters and keeps reasons opt-in", async () => {
  const { calls, output, run } = setup();
  await run("evaluators", "scores", "synthetic-evaluator", "--verdict", "fail", "--limit", "5");
  assert.deepEqual(calls[0], ["evaluators.scores", { evaluator: "synthetic-evaluator", verdict: "fail", limit: "5" }]);
  assert.match(output[0], /synthetic-request  example\/control-model  valid_json  fail/);
  assert.match(output[0], /--cursor synthetic-cursor/);
  assert.doesNotMatch(output[0], /reason:/);
  await run("evaluators", "scores", "synthetic-evaluator", "--include-reasons");
  assert.equal(calls[1][1].includeReasons, true);
});
