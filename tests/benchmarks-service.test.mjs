import assert from "node:assert/strict";
import test from "node:test";

import { createBenchmarksService } from "../dist/benchmarks/service.js";

const orgId = "synthetic-organization";
const projectId = "synthetic-project";
const workloadId = "synthetic-workload";
const promptText = "Invented prompt line for a fictional task.";

const jwt = (claims) => [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify(claims)).toString("base64url"),
  "synthetic-signature",
].join(".");

const store = {
  read: async () => ({
    version: 1,
    method: "oauth",
    accessToken: jwt({ org_id: orgId, exp: Date.now() / 1_000 + 3600 }),
  }),
  write: async () => undefined,
  clear: async () => undefined,
};

const publication = {
  id: "synthetic-publication",
  org_id: orgId,
  project_id: projectId,
  workload_id: workloadId,
  name: "Fictional comparison",
  artifact_sha256: "a".repeat(64),
  model_count: 2,
  task_count: 3,
  best_score: 0.8,
  best_pass_rate: 0.7,
  published_at: "2030-01-01T00:00:00.000Z",
};

const benchmark = {
  id: "synthetic-benchmark",
  name: publication.name,
  project_id: projectId,
  workload_id: workloadId,
  created_at: publication.published_at,
  models: [
    { model: "example/model-a", tasks: [{ task_id: "invented-case", score: 0.8 }] },
  ],
  report: {
    recommendation: { headline: "Try model A", summary: "Review its fictional results." },
    arms: [
      { arm_id: "a", model: "example/model-a", display_name: "A", prompt: "Tuned prompt", role: "recommended", score: 0.8 },
      { arm_id: "b", model: "example/model-b", display_name: "B", prompt: "Current prompt", role: "current", score: 0.5 },
    ],
    prompt_change: {
      diff: [{ op: "insert", before: [], after: [promptText] }],
    },
    caveats: ["Small fictional sample."],
  },
};

function fixture(fetchImplementation) {
  return createBenchmarksService({ store, baseUrl: "https://example.test", fetchImplementation });
}

function responseFor(input, detail = { benchmark, publication }) {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/projects")) return Response.json({ projects: [{ id: projectId, org_id: orgId, slug: "fictional", name: "Fictional" }] });
  if (url.pathname.endsWith("/workloads")) return Response.json({ workloads: [{ id: workloadId, project_id: projectId, name: "writer" }] });
  if (url.pathname.endsWith("/benchmark")) return Response.json(detail);
  throw new Error(`Unexpected synthetic request: ${url.pathname}`);
}

test("benchmark detail summarizes safely and preserves the full report only on request", async () => {
  const urls = [];
  const service = fixture(async (input, init) => {
    urls.push(String(input));
    assert.equal(init.method, "GET");
    assert.match(init.headers.authorization, /^Bearer /);
    return responseFor(input);
  });
  const selection = { project: "fictional", workload: "writer" };
  const summary = await service.show(selection);
  assert.equal(summary.recommendation.headline, "Try model A");
  assert.equal(summary.hasPromptDiff, true);
  assert.equal(summary.manifestBytes, Buffer.byteLength(JSON.stringify(benchmark), "utf8"));
  assert.equal(summary.benchmark, undefined);
  assert.doesNotMatch(JSON.stringify(summary), /Invented prompt line|Tuned prompt/);

  const full = await service.show({ ...selection, includeReport: true });
  assert.equal(full.benchmark.report.prompt_change.diff[0].after[0], promptText);
  assert.deepEqual(full.benchmark.models[0].tasks, benchmark.models[0].tasks);
  assert.ok(urls.every((url) => url.startsWith("https://example.test/admin/v1/orgs/synthetic-organization/")));
});

test("benchmark detail exposes an explicit empty state", async () => {
  const result = await fixture(async (input) => responseFor(input, { benchmark: null, publication: null }))
    .show({ project: projectId, workload: workloadId, includeReport: true });
  assert.equal(result.publication, null);
  assert.equal(result.recommendation, null);
  assert.equal(result.benchmark, null);
  assert.equal(result.manifestBytes, null);
});

test("benchmark detail rejects another workload's response", async () => {
  await assert.rejects(
    fixture(async (input) => responseFor(input, {
      publication: { ...publication, workload_id: "other-workload" }, benchmark,
    })).show({ project: projectId, workload: workloadId }),
    /outside the selected workload/,
  );
});

test("benchmark listing validates publication scope", async () => {
  const listed = await fixture(async (input) => {
    assert.equal(new URL(String(input)).pathname, `/admin/v1/orgs/${orgId}/benchmarks`);
    return Response.json({ workloads: [
      { project_id: projectId, project_name: "Fictional", project_slug: "fictional", workload_id: workloadId, workload_name: "writer", benchmark: publication },
    ] });
  }).list();
  assert.equal(listed.workloads[0].benchmark.name, publication.name);

  await assert.rejects(fixture(async () => Response.json({ workloads: [
    { project_id: projectId, project_name: "Fictional", project_slug: "fictional", workload_id: workloadId, workload_name: "writer", benchmark: { ...publication, org_id: "other-organization" } },
  ] })).list(), /invalid benchmark listing/);
});
