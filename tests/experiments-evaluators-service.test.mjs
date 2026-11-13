import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluatorsService } from "../dist/evaluators/service.js";
import { createExperimentsService } from "../dist/experiments/service.js";

// Wholly invented identifiers and content.
const orgId = "synthetic-organization";
const projectId = "synthetic-project";
const workloadId = "synthetic-workload";
const experimentId = "00000000-0000-7000-8000-000000000001";
const evaluatorId = "00000000-0000-7000-8000-000000000002";
const versionId = "00000000-0000-7000-8000-000000000003";
const requestId = "00000000-0000-7000-8000-000000000004";
const now = Date.parse("2030-03-01T00:00:00.000Z");
const day = 86_400_000;
const inventedReason = "Invented reason quoting a fictional trace.";

const jwt = (claims) => [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify(claims)).toString("base64url"),
  "synthetic-signature",
].join(".");

const oauthStore = {
  read: async () => ({ version: 1, method: "oauth", accessToken: jwt({ org_id: orgId, exp: Date.now() / 1_000 + 3600 }) }),
  write: async () => undefined,
  clear: async () => undefined,
};

const orgKeyStore = {
  read: async () => ({
    version: 1, method: "organization_key", apiKey: ["synthetic", "key"].join("-"), organizationId: orgId,
    keyId: "synthetic-key", serviceUrl: "https://example.test/",
  }),
  write: async () => undefined,
  clear: async () => undefined,
};

const experiment = {
  id: experimentId,
  name: "Fictional pilot",
  status: "active",
  request_environment: "production",
  target_tag: null,
  target_values: null,
  control_model: "example/control-model",
  candidate_model: "example/candidate-model",
  candidate_percent: 20,
  created_at_ms: now - 10 * day,
  updated_at_ms: now - 9 * day,
  project_id: projectId,
  project_slug: "fictional",
  project_name: "Fictional",
  workload_id: workloadId,
  workload_name: "writer",
};

const evaluator = {
  id: evaluatorId,
  name: "Fictional quality",
  status: "active",
  score_from: "2030-02-01T00:00:00.000Z",
  project_id: projectId,
  project_name: "Fictional",
  project_slug: "fictional",
  workload_id: workloadId,
  workload_name: "writer",
  version: {
    id: versionId,
    version: 2,
    judge_model: "claude-haiku-5-5",
    rubrics: [
      { name: "answers_question", pass_when: "The reply answers the invented question.", fail_when: "It does not." },
      {
        name: "valid_json", implementation: "deterministic",
        pass_when: "The reply is JSON.", fail_when: "The reply is not JSON.",
        check: { type: "json_schema", target: { from: "final_response" }, schema: { type: "object" } },
      },
    ],
  },
};

const listStats = {
  traces_judged: 40, rated_traces: 38, passed_traces: 30,
  trace_pass_rate: { value: 0.79, low: 0.64, high: 0.89 },
  rubrics: [{ rubric: "answers_question", pass: 30, fail: 8, na: 2, pass_rate: 0.79 }],
  recent: [],
};

const stats = (rated, passed, rate) => ({
  traces_judged: rated, skips: {}, rated_traces: rated, passed_traces: passed,
  trace_pass_rate: rate, priced_traces: rated, unpriced_traces: 0, cost_per_trace_usd: 0.0021,
  rubrics: [{ rubric: "answers_question", pass: passed, fail: rated - passed, na: 0, pass_rate: rate?.value ?? null }],
});

const summary = {
  evaluator_id: evaluatorId,
  evaluator_version_id: versionId,
  version: 2,
  from: "2030-02-19T00:00:00.000Z",
  to: "2030-03-01T00:00:00.000Z",
  total: stats(100, 80, { value: 0.8, low: 0.71, high: 0.87 }),
  by_day: [],
  by_model: [],
  by_variant: [
    { ...stats(60, 45, { value: 0.75, low: 0.63, high: 0.84 }), experiment_id: experimentId, variant: "control" },
    { ...stats(40, 35, { value: 0.875, low: 0.74, high: 0.95 }), experiment_id: experimentId, variant: "candidate" },
    { ...stats(5, 4, null), experiment_id: null, variant: null },
  ],
  variant_differences: [{ experiment_id: experimentId, candidate_minus_control: { value: 0.125, low: -0.03, high: 0.26 } }],
};

function api(overrides = {}) {
  const calls = [];
  const fetchImplementation = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, query: url.searchParams, method: init.method });
    assert.equal(init.method, "GET");
    assert.match(init.headers.authorization, /^Bearer /);
    const route = Object.entries(overrides).find(([suffix]) => url.pathname.endsWith(suffix));
    if (route) return typeof route[1] === "function" ? route[1](url) : Response.json(route[1]);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ org_id: orgId });
    if (url.pathname.endsWith("/projects")) return Response.json({ projects: [{ id: projectId, org_id: orgId, slug: "fictional", name: "Fictional" }] });
    if (url.pathname.endsWith(`/projects/${projectId}/workloads`)) return Response.json({ workloads: [{ id: workloadId, project_id: projectId, name: "writer" }] });
    if (url.pathname.endsWith("/experiments")) return Response.json({ experiments: [experiment, { ...experiment, id: "synthetic-other", status: "stopped", workload_id: "other-workload", workload_name: "other" }] });
    if (url.pathname.endsWith(`/experiments/${experimentId}`)) return Response.json(experiment);
    if (url.pathname.endsWith("/evaluators")) return Response.json({ evaluators: [{ ...evaluator, stats: listStats }] });
    if (url.pathname.endsWith(`/evaluators/${evaluatorId}`)) return Response.json({ evaluator, experiments: [{ id: experimentId, name: experiment.name, status: "active", control_model: experiment.control_model, candidate_model: experiment.candidate_model }] });
    if (url.pathname.endsWith(`/evaluators/${evaluatorId}/summary`)) return Response.json(summary);
    if (url.pathname.endsWith(`/evaluators/${evaluatorId}/scores`)) {
      return Response.json({
        evaluator_version_id: versionId,
        scores: [{ request_id: requestId, trace_ended_at: "2030-02-28T12:00:00.000Z", model: "example/control-model", rubric: "answers_question", verdict: "fail", reason: inventedReason }],
        next_cursor: null,
      });
    }
    throw new Error(`Unexpected synthetic request: ${url.pathname}`);
  };
  const options = { store: oauthStore, baseUrl: "https://example.test", fetchImplementation };
  return {
    calls,
    experiments: createExperimentsService(options, () => now),
    evaluators: createEvaluatorsService(options),
    customerPaths: () => calls.filter((call) => call.path.startsWith("/customer/")).map((call) => call.path),
  };
}

test("experiment reads use the organization's customer API and filter exactly", async () => {
  const { experiments, customerPaths } = api();
  const all = await experiments.list();
  assert.equal(all.experiments.length, 2);
  assert.equal(all.possiblyTruncated, false);
  assert.deepEqual(customerPaths(), [`/customer/v1/orgs/${orgId}/experiments`]);

  const scoped = await experiments.list({ project: "fictional", workload: "writer" });
  assert.deepEqual(scoped.experiments.map((row) => row.id), [experimentId]);
  const stopped = await experiments.list({ status: "stopped" });
  assert.deepEqual(stopped.experiments.map((row) => row.id), ["synthetic-other"]);
  await assert.rejects(experiments.list({ status: "running" }), /draft, active, or stopped/);
  await assert.rejects(experiments.list({ workload: "writer" }), /Select a project/);

  const shown = await experiments.show({ experiment: experimentId });
  assert.equal(shown.candidate_percent, 20);
});

test("experiment listing reports a possibly truncated page and refuses repeated ids", async () => {
  const page = Array.from({ length: 200 }, (_, index) => ({ ...experiment, id: `synthetic-${index}` }));
  assert.equal((await api({ "/experiments": { experiments: page } }).experiments.list()).possiblyTruncated, true);
  await assert.rejects(
    api({ "/experiments": { experiments: [experiment, experiment] } }).experiments.list(),
    /repeated ids/,
  );
});

test("experiment show reports a missing experiment and refuses another one", async () => {
  await assert.rejects(
    api({ [`/experiments/${experimentId}`]: () => new Response("{}", { status: 404 }) }).experiments.show({ experiment: experimentId }),
    /Experiment not found/,
  );
  await assert.rejects(
    api({ [`/experiments/${experimentId}`]: { ...experiment, id: "synthetic-other" } }).experiments.show({ experiment: experimentId }),
    /another experiment/,
  );
  await assert.rejects(api().experiments.show({ experiment: "../evaluators" }), /Invalid experiment id/);
});

test("experiment and evaluator reads refuse organization keys before calling the customer API", async () => {
  const calls = [];
  const options = {
    store: orgKeyStore,
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      calls.push(new URL(String(input)).pathname);
      return Response.json({ org_id: orgId });
    },
  };
  await assert.rejects(createExperimentsService(options).list(), /require browser OAuth/);
  await assert.rejects(createEvaluatorsService(options).summary({ evaluator: evaluatorId }), /require browser OAuth/);
  assert.ok(calls.every((path) => !path.startsWith("/customer/")));
});

test("experiment results compare both arms over the experiment's life", async () => {
  const { experiments, calls } = api();
  const result = await experiments.results({ experiment: experimentId });
  assert.equal(result.evaluator.id, evaluatorId);
  assert.equal(result.evaluator.version, 2);
  assert.deepEqual(result.range, {
    from: new Date(experiment.created_at_ms).toISOString(),
    to: new Date(now).toISOString(),
    clampedToMaxRange: false,
  });
  const summaryCall = calls.find((call) => call.path.endsWith("/summary"));
  assert.equal(summaryCall.query.get("from"), result.range.from);
  assert.equal(summaryCall.query.get("to"), result.range.to);
  assert.equal(result.control.assigned_model, "example/control-model");
  assert.equal(result.control.rated_traces, 60);
  assert.equal(result.candidate.trace_pass_rate.value, 0.875);
  assert.equal(result.candidateMinusControl.value, 0.125);
  assert.ok(result.notes.some((note) => /version 2 only/.test(note)));
  assert.ok(result.notes.some((note) => /assigned arm/.test(note)));
});

test("experiment results explain missing measurement instead of inventing it", async () => {
  const none = await api({ "/evaluators": { evaluators: [] } }).experiments.results({ experiment: experimentId });
  assert.equal(none.evaluator, null);
  assert.equal(none.control, null);
  assert.match(none.notes[0], /cannot be measured/);

  const draft = api({ [`/experiments/${experimentId}`]: { ...experiment, status: "draft" } });
  const drafted = await draft.experiments.results({ experiment: experimentId });
  assert.match(drafted.notes[0], /draft/);
  assert.ok(draft.customerPaths().every((path) => !path.includes("/evaluators")));

  const small = await api({
    [`/evaluators/${evaluatorId}/summary`]: {
      ...summary,
      by_variant: [{ ...stats(12, 9, null), experiment_id: experimentId, variant: "control" }, { ...stats(8, 7, null), experiment_id: experimentId, variant: "candidate" }],
      variant_differences: [{ experiment_id: experimentId, candidate_minus_control: null }],
    },
  }).experiments.results({ experiment: experimentId });
  assert.equal(small.candidateMinusControl, null);
  assert.ok(small.notes.some((note) => /needs 30 rated traces/.test(note)));
});

test("experiment results bound the range and verify the summary's evaluator", async () => {
  const old = await api({ [`/experiments/${experimentId}`]: { ...experiment, created_at_ms: now - 200 * day } })
    .experiments.results({ experiment: experimentId });
  assert.equal(old.range.from, new Date(now - 90 * day).toISOString());
  assert.equal(old.range.clampedToMaxRange, true);

  await assert.rejects(
    api().experiments.results({ experiment: experimentId, from: "2029-01-01", to: "2030-01-01" }),
    /at most 90 days/,
  );
  await assert.rejects(
    api({ [`/evaluators/${evaluatorId}/summary`]: { ...summary, evaluator_id: "synthetic-other" } }).experiments.results({ experiment: experimentId }),
    /another evaluator/,
  );
});

test("evaluator list and show resolve the selected workload exactly", async () => {
  const { evaluators } = api();
  assert.equal((await evaluators.list()).evaluators.length, 1);
  assert.equal((await evaluators.list({ project: "fictional", workload: "writer" })).evaluators.length, 1);

  const byWorkload = await evaluators.show({ project: "fictional", workload: "writer" });
  assert.equal(byWorkload.evaluator.version.rubrics[1].check.type, "json_schema");
  assert.equal(byWorkload.experiments[0].id, experimentId);
  const byId = await evaluators.show({ evaluator: evaluatorId });
  assert.equal(byId.evaluator.id, evaluatorId);

  await assert.rejects(evaluators.show({ evaluator: evaluatorId, workload: "writer" }), /not both/);
  await assert.rejects(api({ "/evaluators": { evaluators: [] } }).evaluators.show({ project: "fictional", workload: "writer" }), /No evaluator is visible/);
  await assert.rejects(
    api({ "/evaluators": { evaluators: [{ ...evaluator, stats: listStats }, { ...evaluator, id: "synthetic-other", stats: listStats }] } }).evaluators.list(),
    /more than one evaluator for a workload/,
  );
});

test("evaluator summary validates and normalizes its range before reading", async () => {
  const { evaluators, calls } = api();
  await evaluators.summary({ evaluator: evaluatorId, from: "2030-02-01", to: "2030-02-15T00:00:00Z" });
  const call = calls.find((entry) => entry.path.endsWith("/summary"));
  assert.equal(call.query.get("from"), "2030-02-01T00:00:00.000Z");
  assert.equal(call.query.get("to"), "2030-02-15T00:00:00.000Z");

  const before = calls.length;
  await assert.rejects(evaluators.summary({ evaluator: evaluatorId, from: "2030-02-15", to: "2030-02-01" }), /before --to/);
  await assert.rejects(evaluators.summary({ evaluator: evaluatorId, from: "yesterday" }), /ISO date/);
  assert.equal(calls.length, before);
});

test("evaluator scores omit judge reasons unless requested", async () => {
  const { evaluators, calls } = api();
  const plain = await evaluators.scores({ evaluator: evaluatorId, verdict: "fail", rubric: "answers_question", limit: "5" });
  assert.equal(plain.reasonsIncluded, false);
  assert.equal("reason" in plain.scores[0], false);
  assert.doesNotMatch(JSON.stringify(plain), /Invented reason/);
  const query = calls.find((call) => call.path.endsWith("/scores")).query;
  assert.equal(query.get("verdict"), "fail");
  assert.equal(query.get("limit"), "5");

  const full = await evaluators.scores({ evaluator: evaluatorId, includeReasons: true });
  assert.equal(full.scores[0].reason, inventedReason);

  await assert.rejects(evaluators.scores({ evaluator: evaluatorId, limit: "50" }), /1 to 20/);
  await assert.rejects(evaluators.scores({ evaluator: evaluatorId, verdict: "maybe" }), /pass, fail, or na/);
  await assert.rejects(evaluators.scores({ evaluator: evaluatorId, rubric: "Not Snake" }), /snake_case/);
  await assert.rejects(
    api({ [`/evaluators/${evaluatorId}/scores`]: () => new Response("{}", { status: 403 }) }).evaluators.scores({ evaluator: evaluatorId }),
    /organization admins/,
  );
});
