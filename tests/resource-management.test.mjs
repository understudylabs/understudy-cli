import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";

import { createProjectsService } from "../dist/projects/service.js";
import { createWorkloadsService } from "../dist/workloads/service.js";
import { showModel } from "../dist/models/service.js";
import { createKeysService } from "../dist/keys/service.js";
import { createKeyStore, readKeyCredential } from "../dist/keys/credentials.js";
import { addProjectsCommands } from "../dist/commands/projects.js";
import { addKeysCommands } from "../dist/commands/keys.js";

// All values in this file are invented fixtures.
const org = "synthetic-org";
const project = { id: "synthetic-project", slug: "synthetic-project", name: "Synthetic Project", org_id: org };
const key = { object: "api_key", id: "synthetic-key", name: "Synthetic Key", owner: { type: "organization", id: org } };
const workload = { id: "synthetic-workload", project_id: project.id, name: "synthetic-workload", capture_enabled: true, capture_sample_rate: 1, route_deployment_id: null, is_default: false, created_at: "2026-01-01T00:00:00Z" };
function store() {
  const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return { read: async () => ({ version: 1, method: "oauth", accessToken: `synthetic.${claims}.signature` }), write: async () => {}, clear: async () => {} };
}
function options(fetchImplementation) { return { store: store(), baseUrl: "https://example.test", fetchImplementation }; }
function projects(fetchImplementation) { return createProjectsService({ ...options(fetchImplementation), authStore: store() }); }
function memoryKeys() {
  const values = new Map();
  return { values, factory: (reference) => ({ read: async () => values.get(reference) ?? null, write: async (value) => { values.set(reference, value); }, clear: async () => { values.delete(reference); } }) };
}

test("project show traverses empty cursor pages and update uses the resolved slug", async () => {
  const calls = [];
  const service = projects(async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === "PATCH") return Response.json({ ...project, name: "New name" });
    if (new URL(url).searchParams.has("cursor")) return Response.json({ projects: [project], cursor: null });
    return Response.json({ projects: [], cursor: "synthetic-cursor" });
  });
  assert.equal((await service.show(project.id)).id, project.id);
  assert.equal((await service.update({ project: project.id, name: "New name" })).name, "New name");
  const mutation = calls.at(-1);
  assert.ok(mutation.url.endsWith(`/projects/${project.slug}`));
  assert.deepEqual(JSON.parse(mutation.init.body), { name: "New name" });
});

test("project operations reject foreign ownership, duplicate pages, and wrong write echoes", async () => {
  let writes = 0;
  const foreign = projects(async (_url, init) => {
    if (init.method !== "GET") writes++;
    return Response.json({ projects: [{ ...project, org_id: "synthetic-other-org" }] });
  });
  await assert.rejects(foreign.update({ project: project.id, name: "New" }), /invalid project list/i);
  assert.equal(writes, 0);
  await assert.rejects(projects(async () => Response.json({ projects: [project], cursor: "repeat" })).list(), /invalid project list/i);
  await assert.rejects(projects(async (_url, init) => Response.json(init.method === "GET" ? { projects: [project] } : { ...project, id: "synthetic-other-project", name: "New" })).update({ project: project.id, name: "New" }), /outcome is unknown/i);
});

test("ensure-default verifies the unscoped response against the org project list", async () => {
  const rehearsal = { ...project, slug: "rehearsal", name: "Rehearsal" };
  const service = projects(async (_url, init) => Response.json(init.method === "POST" ? { id: rehearsal.id, slug: rehearsal.slug, name: rehearsal.name } : { projects: [rehearsal] }));
  assert.equal((await service.ensureDefault()).slug, "rehearsal");
  const renamed = projects(async (_url, init) => Response.json(init.method === "POST" ? rehearsal : { projects: [{ ...rehearsal, name: "Renamed rehearsal" }] }));
  assert.equal((await renamed.ensureDefault()).name, "Renamed rehearsal");
  const mismatched = projects(async (_url, init) => Response.json(init.method === "POST" ? rehearsal : { projects: [] }));
  await assert.rejects(mismatched.ensureDefault(), /outcome is unknown/i);
});

test("project deletion requires confirmation before authentication and validates returned identity", async () => {
  let calls = 0;
  const service = projects(async (_url, init) => {
    calls++;
    return Response.json(init.method === "GET" ? { projects: [project] } : { id: project.id, slug: project.slug, deleted: true });
  });
  await assert.rejects(service.delete({ project: project.id }), /--confirm/);
  assert.equal(calls, 0);
  assert.equal((await service.delete({ project: project.id, confirm: true })).deleted, true);
});

test("capture sampling validates bounds and exact update echo", async () => {
  let calls = 0;
  const service = createWorkloadsService(options(async (url, init) => {
    calls++;
    if (init.method === "PATCH") {
      assert.deepEqual(JSON.parse(init.body), { capture_sample_rate: 0.25 });
      return Response.json({ ...workload, capture_sample_rate: 0.25 });
    }
    return Response.json(String(url).endsWith("/projects") ? { projects: [project] } : { workloads: [workload] });
  }));
  await assert.rejects(service.update({ project: project.id, workload: workload.id, captureSampleRate: NaN }), /between 0 and 1/);
  assert.equal(calls, 0);
  assert.equal((await service.update({ project: project.id, workload: workload.id, captureSampleRate: 0.25 })).workload.captureSampleRate, 0.25);
  const wrongEcho = createWorkloadsService(options(async (url, init) => Response.json(init.method === "PATCH" ? workload : String(url).endsWith("/projects") ? { projects: [project] } : { workloads: [workload] })));
  await assert.rejects(wrongEcho.update({ project: project.id, workload: workload.id, captureSampleRate: 0.25 }), /outcome is unknown/);
});

test("model details mark unavailable metadata unknown and require exact model identity", async () => {
  const modelOptions = options(async () => Response.json({ models: [{ id: "synthetic-model", display_name: "Synthetic Model", private_metadata: "discard" }] }));
  const result = await showModel(modelOptions, "synthetic-model");
  assert.equal(result.model.openWeight, null);
  assert.equal(result.inferenceCapabilities, null);
  assert.equal(JSON.stringify(result).includes("private_metadata"), false);
  await assert.rejects(showModel(modelOptions, "synthetic"), /not found/);
});

test("key creation stores the secret and returns only metadata and a bound private reference", async () => {
  const privateKeys = memoryKeys();
  const oneTimeValue = "synthetic-one-time-value";
  const service = createKeysService({ ...options(async () => Response.json({ value: oneTimeValue, metadata: { ...key, obfuscated_value: "synthetic-hidden-prefix", extra: oneTimeValue } })), keyStoreFactory: privateKeys.factory });
  const result = await service.create({ name: key.name });
  assert.match(result.credentialReference, /^key:[a-f0-9]{64}$/);
  assert.equal((await readKeyCredential(result.credentialReference, privateKeys.factory)).value, oneTimeValue);
  assert.equal(JSON.stringify(result).includes(oneTimeValue), false);
  assert.equal(JSON.stringify(result).includes("synthetic-hidden-prefix"), false);
  const listed = await createKeysService({ ...options(async () => Response.json({ keys: [key] })), keyStoreFactory: privateKeys.factory }).list();
  assert.equal(listed.completeness, "unknown");
  assert.match(listed.limitation, /continuation cursor/);
});

test("key scope mismatches fail before private storage and foreign lists fail closed", async () => {
  const privateKeys = memoryKeys();
  const foreignKey = { ...key, owner: { type: "organization", id: "synthetic-other-org" } };
  const service = createKeysService({ ...options(async (_url, init) => Response.json(init.method === "POST" ? { value: "synthetic-secret", metadata: foreignKey } : { keys: [foreignKey] })), keyStoreFactory: privateKeys.factory });
  await assert.rejects(service.create({ name: key.name }), /outcome is unknown/);
  assert.equal(privateKeys.values.size, 0);
  await assert.rejects(service.list(), /invalid API key list/);
});

test("a repeated create identity never overwrites or revokes an existing private credential", async () => {
  const privateKeys = memoryKeys();
  const calls = [];
  const service = createKeysService({ ...options(async (_url, init) => {
    calls.push(init.method);
    return Response.json({ value: calls.length === 1 ? "synthetic-first-value" : "synthetic-second-value", metadata: key });
  }), keyStoreFactory: privateKeys.factory });
  const created = await service.create({ name: key.name });
  await assert.rejects(service.create({ name: key.name }), /already has a private credential/);
  assert.equal((await readKeyCredential(created.credentialReference, privateKeys.factory)).value, "synthetic-first-value");
  assert.deepEqual(calls, ["POST", "POST"]);
});

test("failed private key storage revokes only the key just created without exposing its value", async () => {
  const calls = [];
  const service = createKeysService({ ...options(async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return Response.json(init.method === "POST" ? { value: "synthetic-secret", metadata: key } : { id: key.id, revoked: true });
  }), keyStoreFactory: () => ({ read: async () => null, write: async () => { throw new Error("synthetic-secret"); }, clear: async () => {} }) });
  await assert.rejects(service.create({ name: key.name }), (error) => {
    assert.match(error.message, /newly created key was revoked/);
    assert.equal(error.message.includes("synthetic-secret"), false);
    return true;
  });
  assert.equal(calls.at(-1).method, "DELETE");
  assert.ok(calls.at(-1).url.endsWith(`/api_keys/${key.id}`));
});

test("revoke requires confirmation, exact org membership, and removes matching private storage", async () => {
  const privateKeys = memoryKeys();
  const calls = [];
  const service = createKeysService({ ...options(async (_url, init) => {
    calls.push(init.method);
    return Response.json(init.method === "POST" ? { value: "synthetic-secret", metadata: key } : init.method === "DELETE" ? { id: key.id, revoked: true } : { keys: [key] });
  }), keyStoreFactory: privateKeys.factory });
  await assert.rejects(service.revoke({ key: key.id }), /--confirm/);
  assert.deepEqual(calls, []);
  await assert.rejects(service.revoke({ key: "synthetic-other-key", confirm: true }), /not found/);
  assert.deepEqual(calls, ["GET"]);
  await service.create({ name: key.name });
  const result = await service.revoke({ key: key.id, confirm: true });
  assert.equal(result.localCredentialRemoved, true);
  assert.equal(privateKeys.values.size, 0);
});

test("JSON output cannot bypass destructive command confirmation", async () => {
  let calls = 0;
  for (const [register, args] of [[addProjectsCommands, ["projects", "delete", project.id]], [addKeysCommands, ["keys", "revoke", key.id]]]) {
    const program = new Command().option("--json").exitOverride();
    register(program, { delete: async () => { calls++; }, revoke: async () => { calls++; }, output: () => {} });
    await assert.rejects(program.parseAsync(["node", "synthetic", "--json", ...args]), /--confirm/);
  }
  assert.equal(calls, 0);
});

test("managed key files are private and a reference cannot read another identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "synthetic-managed-key-"));
  try {
    const factory = (reference) => createKeyStore(reference, directory);
    const service = createKeysService({ ...options(async () => Response.json({ value: "synthetic-secret", metadata: key })), keyStoreFactory: factory });
    const result = await service.create({ name: key.name });
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const file = path.join(directory, files[0]);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal(JSON.parse(await readFile(file, "utf8")).value, "synthetic-secret");
    const stored = await factory(result.credentialReference).read();
    await factory(result.credentialReference).write({ ...stored, organizationId: "synthetic-other-org" });
    await assert.rejects(readKeyCredential(result.credentialReference, factory), /does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
