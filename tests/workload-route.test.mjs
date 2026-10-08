import assert from "node:assert/strict";
import test from "node:test";
import { createWorkloadsService } from "../dist/workloads/service.js";
import { applicationContextKey } from "../dist/context/storage.js";

const org = "synthetic-organization";
const project = { id: "synthetic-project", slug: "synthetic-project", name: "Synthetic Project", org_id: org };
const workload = { id: "synthetic-workload", project_id: project.id, name: "synthetic-workload", capture_enabled: false,
  route_model_id: null, route_deployment_id: null, route_traffic_pct: 0, is_default: false, created_at: "2030-01-01" };
const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Date.now() / 1000 + 3600 })).toString("base64url");
const store = { read: async () => ({ version: 1, method: "oauth", accessToken: `synthetic.${claims}.signature` }) };
async function harness(overrides = {}) {
  const calls = [];
  const contextStore = { read: async () => ({ version: 1, applications: { [await applicationContextKey()]: {
    organizationId: org, project: { id: project.id, slug: project.slug, name: project.name }, workload: { id: "synthetic-deleted", name: "synthetic-deleted" },
  } } }) };
  const options = { store, contextStore, baseUrl: "https://example.test", fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      return Response.json({ workload: { ...workload, route_model_id: body.model_id, route_traffic_pct: body.model_id === null ? 0 : body.route_traffic_pct,
        capture_enabled: body.capture_enabled ?? body.model_id !== null }, model: body.model_id === null ? null : { id: body.model_id } });
    }
    return Response.json(new URL(url).pathname.endsWith("/projects") ? { projects: [project] } : { workloads: [workload] });
  }, ...overrides };
  return { service: createWorkloadsService(options), options, calls };
}

test("saved project is revalidated for workloads without loading stale workload defaults", async () => {
  const h = await harness();
  assert.equal((await h.service.list()).project.id, project.id);
  assert.equal((await h.service.show({ workload: workload.name })).workload.id, workload.id);
  assert.equal(h.calls.length, 4);
});

test("route defaults to ten percent with explicit capture control and supports clearing", async () => {
  const h = await harness();
  const result = await h.service.route({ workload: workload.name, modelId: "synthetic-model", capture: false });
  assert.equal(result.workload.routeTrafficPercent, 10);
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body), { model_id: "synthetic-model", route_traffic_pct: 10, capture_enabled: false });
  assert.match(h.calls.at(-1).url, /\/workloads\/synthetic-workload\/route$/);
  assert.equal((await h.service.route({ workload: workload.id, clear: true })).workload.routeKind, "none");
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body), { model_id: null });
});

test("invalid routes cannot authenticate or mutate", async () => {
  const h = await harness({ store: { read: async () => { throw new Error("Unexpected auth"); } } });
  for (const input of [{}, { clear: true, modelId: "synthetic-model" }, { clear: true, trafficPercent: 10 },
    { modelId: "bad model" }, { modelId: "synthetic-model", trafficPercent: 1.5 }, { modelId: "synthetic-model", trafficPercent: 101 }]) {
    await assert.rejects(h.service.route({ workload: workload.id, ...input }), /model-id|model id|percentage/);
  }
  assert.equal(h.calls.length, 0);
});

test("wrong route write echoes are unknown outcomes and never retried", async () => {
  const h = await harness();
  let writes = 0;
  const original = h.options.fetchImplementation;
  const service = createWorkloadsService({ ...h.options, fetchImplementation: async (url, init) => {
    if (init.method === "PUT") { writes++; return Response.json({ workload, model: { id: "synthetic-model" } }); }
    return original(url, init);
  } });
  await assert.rejects(service.route({ workload: workload.id, modelId: "synthetic-model" }), /outcome is unknown/);
  assert.equal(writes, 1);
});

test("foreign project ownership prevents any route mutation", async () => {
  let calls = 0;
  const h = await harness({ fetchImplementation: async () => { calls++; return Response.json({ projects: [{ ...project, org_id: "synthetic-other-org" }] }); } });
  await assert.rejects(h.service.route({ workload: workload.id, modelId: "synthetic-model" }), /invalid project list/);
  assert.equal(calls, 1);
});
