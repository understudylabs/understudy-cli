import assert from "node:assert/strict";
import test from "node:test";
import { resolveManagementScope, setApplicationContext, clearApplicationContext, readApplicationContext } from "../dist/context/service.js";
import { applicationContextKey } from "../dist/context/storage.js";

const org = "synthetic-organization";
const projects = [{ id: "synthetic-project-one", slug: "synthetic-one", name: "Synthetic One", org_id: org }, { id: "synthetic-project-two", slug: "synthetic-two", name: "Synthetic Two", org_id: org }];
const workload = { id: "synthetic-workload", name: "synthetic-work", project_id: projects[0].id };
function memory(value = null) { return { value, reads: 0, async read() { this.reads++; return this.value; }, async write(next) { this.value = next; }, async clear() { this.value = null; } }; }
function jwt() { return ["synthetic", Buffer.from(JSON.stringify({ org_id: org, exp: Date.now() / 1000 + 600 })).toString("base64url"), "signature"].join("."); }
async function harness(saved = null) {
  const key = await applicationContextKey();
  const contextStore = memory(saved ? { version: 1, applications: { [key]: saved } } : null);
  const calls = [];
  const options = { store: memory({ version: 1, method: "oauth", accessToken: jwt() }), contextStore,
    fetchImplementation: async (url) => {
      calls.push(url);
      if (new URL(url).pathname.endsWith("/projects")) return Response.json({ projects });
      if (new URL(url).pathname.endsWith("/workloads")) return Response.json({ workloads: [workload] });
      throw new Error("Unexpected synthetic URL");
    } };
  return { options, contextStore, calls };
}
const saved = { organizationId: org, project: { id: projects[0].id, slug: projects[0].slug, name: projects[0].name }, workload: { id: workload.id, name: workload.name } };

test("saved defaults are revalidated in the authenticated hierarchy", async () => {
  const h = await harness(saved);
  const scope = await resolveManagementScope(h.options);
  assert.equal(scope.project.id, projects[0].id);
  assert.equal(scope.workload.id, workload.id);
  assert.equal(h.calls.length, 2);
  assert.equal(scope.session.organizationId, org);
});

test("an explicit project discards a saved workload from a different project", async () => {
  const h = await harness(saved);
  const scope = await resolveManagementScope(h.options, { project: projects[1].slug });
  assert.equal(scope.project.id, projects[1].id);
  assert.equal(scope.workload, undefined);
  assert.equal(h.calls.length, 1);
});

test("organization-wide reads can ignore defaults without reading private context", async () => {
  const h = await harness(saved);
  const scope = await resolveManagementScope(h.options, { ignoreDefaults: true });
  assert.equal(scope.project, undefined);
  assert.equal(h.contextStore.reads, 0);
  assert.equal(h.calls.length, 0);
});

test("project-wide reads keep the saved project without resolving a stale saved workload", async () => {
  const h = await harness({ ...saved, workload: { id: "synthetic-deleted-workload", name: "Synthetic Deleted" } });
  const scope = await resolveManagementScope(h.options, { ignoreWorkloadDefault: true });
  assert.equal(scope.project.id, projects[0].id);
  assert.equal(scope.workload, undefined);
  assert.equal(h.calls.length, 1);
  await assert.rejects(resolveManagementScope(h.options), /workload was not found/);
  const explicit = await resolveManagementScope(h.options, { ignoreWorkloadDefault: true, workload: workload.id });
  assert.equal(explicit.workload.id, workload.id);
});

test("context and org selectors cannot acquire another organization's authority", async () => {
  const h = await harness({ ...saved, organizationId: "synthetic-other-org" });
  await assert.rejects(resolveManagementScope(h.options), /another organization/);
  await assert.rejects(resolveManagementScope(h.options, { org: "synthetic-other-org", ignoreDefaults: true }), /does not match/);
  assert.equal(h.calls.length, 0);
});

test("exact project-name collisions and out-of-scope workloads fail closed", async () => {
  const h = await harness();
  await assert.rejects(resolveManagementScope({ ...h.options, fetchImplementation: async () => Response.json({ projects: projects.map(project => ({ ...project, name: "Synthetic Duplicate" })) }) }, { project: "Synthetic Duplicate" }), /ambiguous/);
  await assert.rejects(resolveManagementScope(h.options, { project: projects[1].id, workload: workload.id }), /outside the selected project/);
});

test("workload pagination follows unique cursors and rejects cursor loops", async () => {
  const h = await harness();
  let page = 0;
  const options = { ...h.options, fetchImplementation: async (url) => {
    if (new URL(url).pathname.endsWith("/projects")) return Response.json({ projects });
    page++;
    return Response.json(page === 1 ? { workloads: [], cursor: "synthetic-next" } : { workloads: [workload], cursor: null });
  } };
  assert.equal((await resolveManagementScope(options, { project: projects[0].id, workload: workload.name })).workload.id, workload.id);
  assert.equal(page, 2);
  await assert.rejects(resolveManagementScope({ ...h.options, fetchImplementation: async (url) => new URL(url).pathname.endsWith("/projects") ? Response.json({ projects }) : Response.json({ workloads: [], cursor: "synthetic-next" }) }, { project: projects[0].id, workload: workload.name }), /repeated a workload cursor/);
});

for (const field of ["id", "name"]) {
  test(`workload scope rejects an unrelated repeated ${field} across roster pages`, async () => {
    const h = await harness();
    const unrelated = { id: "synthetic-unrelated-workload", name: "synthetic-unrelated", project_id: projects[0].id };
    let page = 0;
    await assert.rejects(resolveManagementScope({ ...h.options, fetchImplementation: async url => {
      if (new URL(url).pathname.endsWith("/projects")) return Response.json({ projects });
      page++;
      return Response.json(page === 1
        ? { workloads: [workload, unrelated], cursor: "synthetic-next" }
        : { workloads: [{ ...unrelated, id: "synthetic-another-workload", name: "synthetic-another", [field]: unrelated[field] }], cursor: null });
    } }, { project: projects[0].id, workload: workload.id }), /repeated ids or names/);
    assert.equal(page, 2);
  });
}

test("set validates selections and clear is application-local", async () => {
  const h = await harness();
  await assert.rejects(setApplicationContext(h.options, {}), /Provide --project/);
  const result = await setApplicationContext(h.options, { project: projects[0].slug, workload: workload.name });
  assert.deepEqual(result, saved);
  assert.deepEqual(await readApplicationContext(h.options), saved);
  h.contextStore.value.applications["0".repeat(64)] = saved;
  await clearApplicationContext(h.options);
  assert.equal(await readApplicationContext(h.options), null);
  assert.deepEqual(h.contextStore.value.applications["0".repeat(64)], saved);
});

test("an explicit context set can replace stale context from another identity", async () => {
  const h = await harness({ ...saved, organizationId: "synthetic-other-org" });
  const result = await setApplicationContext(h.options, { project: projects[1].id });
  assert.equal(result.organizationId, org);
  assert.equal(result.project.id, projects[1].id);
  assert.equal(result.workload, undefined);
});
