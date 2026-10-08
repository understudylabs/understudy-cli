import assert from "node:assert/strict";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { beginEmailLogin, completeEmailLogin, createPendingEmailStore } from "../dist/auth/email.js";
import { createCredentialStore } from "../dist/auth/credentials.js";
import { getValidAccessToken } from "../dist/auth/service.js";
import { resolveManagementSession } from "../dist/management/session.js";
import { setupInference } from "../dist/inference/service.js";
import { readApplicationContext } from "../dist/context/service.js";
import { getStatus } from "../dist/status/service.js";

const origin = "https://gateway.example.test";
const now = 2_000_000_000_000;
const organizationId = "synthetic-organization";
const apiKey = ["synthetic", "organization", "key"].join("-");
const keyId = "synthetic-key-reference";
function memory(value = null) {
  return { value, reads: 0, async read() { this.reads++; return this.value; }, async write(next) { this.value = next; }, async clear() { this.value = null; } };
}
function harness(overrides = {}) {
  const store = memory();
  const pendingStore = memory();
  const inferenceStore = { ...memory(), async withSetupLock(operation) { return operation(); } };
  const calls = [];
  const options = { store, pendingStore, inferenceStore, baseUrl: origin, now: () => now,
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "error");
      const pathname = new URL(url).pathname;
      if (pathname === "/.well-known/oauth-authorization-server") return Response.json({ agent_auth: {
        register_uri: `${origin}/agent/auth`, claim_uri: `${origin}/agent/auth/claim`,
      } });
      if (pathname === "/agent/auth") return Response.json({ claim_token: "synthetic-pending-claim", claim_url: "/agent/auth/claim/complete" });
      if (pathname === "/agent/auth/claim/complete") return Response.json({ status: "claimed", credential_type: "api_key", credential: apiKey, org_id: organizationId, api_key_id: keyId, gateway_url: origin });
      if (pathname.endsWith("/snapshot")) return Response.json({ org_id: organizationId });
      throw new Error("Unexpected synthetic request");
    }, ...overrides };
  return { options, store, pendingStore, inferenceStore, calls };
}

test("email sign-in persists resumable state and yields explicit org-key authentication", async () => {
  const h = harness();
  const start = await beginEmailLogin(h.options, "person@example.test");
  assert.deepEqual(start, { pending: true, expiresAt: new Date(now + 600_000).toISOString() });
  assert.equal(h.store.value, null);
  assert.equal(h.pendingStore.value.claimToken, "synthetic-pending-claim");
  assert.equal("email" in h.pendingStore.value, false);
  const complete = await completeEmailLogin(h.options, "101010");
  assert.deepEqual(complete, { authenticated: true, method: "organization_key", organizationId, inferenceReady: true });
  assert.equal(h.store.value.apiKey, apiKey);
  assert.equal(h.inferenceStore.value.apiKey, apiKey);
  assert.equal(h.pendingStore.value, null);
  assert.doesNotMatch(JSON.stringify([start, complete]), /synthetic-organization-key|synthetic-pending-claim|101010/);
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { type: "identity_assertion", assertion_type: "verified_email", assertion: "person@example.test", requested_credential_type: "api_key" });
});

test("pending sign-in survives a failed code and rejects unrequested replacement", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  await assert.rejects(beginEmailLogin(h.options, "other@example.test"), /pending/);
  const saved = h.pendingStore.value;
  await assert.rejects(completeEmailLogin({ ...h.options, fetchImplementation: async () => new Response("synthetic-sensitive-response", { status: 400 }) }, "101010"), (error) => {
    assert.match(error.message, /HTTP 400/);
    assert.doesNotMatch(error.message, /synthetic-sensitive-response/);
    return true;
  });
  assert.deepEqual(h.pendingStore.value, saved);
});

test("expired and malformed codes cannot make a claim request", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  const callsBefore = h.calls.length;
  await assert.rejects(completeEmailLogin(h.options, "not-a-code"), /six digits/);
  await assert.rejects(completeEmailLogin({ ...h.options, now: () => now + 600_001 }, "101010"), /expired/);
  assert.equal(h.calls.length, callsBefore);
  assert.equal(h.pendingStore.value, null);
});

test("rejected email verification preserves the claim and reports a safe support reference", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  const saved = h.pendingStore.value;
  const requestId = "00000000-0000-7000-8000-000000000001";
  for (const status of [401, 403]) {
    await assert.rejects(completeEmailLogin({ ...h.options, fetchImplementation: async () =>
      new Response("synthetic-sensitive-response", { status, headers: { "x-understudy-request-id": requestId } }) }, "101010"), error => {
      assert.match(error.message, /browser sign-in.*understudy login/);
      assert.ok(error.message.includes(requestId));
      assert.doesNotMatch(error.message, /synthetic-sensitive-response|101010|synthetic-pending-claim/);
      return true;
    });
    assert.deepEqual(h.pendingStore.value, saved);
    assert.equal(h.store.value, null);
  }
  await assert.rejects(completeEmailLogin({ ...h.options, fetchImplementation: async () =>
    new Response(null, { status: 401, headers: { "x-understudy-request-id": "synthetic-sensitive-header" } }) }, "101010"), error => {
    assert.doesNotMatch(error.message, /synthetic-sensitive-header|Request ID/);
    return true;
  });
});

test("initial sign-in failures do not claim that a code was rejected", async () => {
  for (const endpoint of ["/.well-known/oauth-authorization-server", "/agent/auth"]) {
    for (const status of [401, 403]) {
      const h = harness();
      const fetchImplementation = h.options.fetchImplementation;
      await assert.rejects(beginEmailLogin({ ...h.options, fetchImplementation: async (url, init) =>
        new URL(url).pathname === endpoint ? new Response("synthetic-sensitive-response", { status })
          : fetchImplementation(url, init) }, "person@example.test"), error => {
        assert.ok(error.message.includes(`HTTP ${status}`));
        assert.match(error.message, /auth status/);
        assert.doesNotMatch(error.message, /latest code|rejected|browser sign-in|synthetic-sensitive-response/);
        return true;
      });
      assert.equal(h.pendingStore.value, null);
      assert.equal(h.store.value, null);
    }
  }
});

const userInfoUrl = new URL("/agent/auth", origin);
userInfoUrl.username = "synthetic-user";
userInfoUrl.password = ["synthetic", "value"].join("-");
for (const url of ["https://other.example.test/agent/auth", `${origin}/agent/auth?unexpected=synthetic`, "http://gateway.example.test/agent/auth", userInfoUrl.href]) {
  test("discovery rejects an untrusted registration endpoint without following it", async () => {
    let calls = 0;
    const h = harness({ fetchImplementation: async () => { calls++; return Response.json({ agent_auth: { register_uri: url } }); } });
    await assert.rejects(beginEmailLogin(h.options, "person@example.test"), /untrusted/);
    assert.equal(calls, 1);
    assert.equal(h.pendingStore.value, null);
  });
}

test("completion rechecks stored endpoint origin and never sends a claim elsewhere", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  h.pendingStore.value.completeUrl = "https://other.example.test/complete";
  const callsBefore = h.calls.length;
  await assert.rejects(completeEmailLogin(h.options, "101010"), /untrusted/);
  assert.equal(h.calls.length, callsBefore);
});

test("mismatched issued service is rejected without storing the new credential", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  await assert.rejects(completeEmailLogin({ ...h.options, fetchImplementation: async () => Response.json({ status: "claimed", credential_type: "api_key", credential: apiKey, org_id: organizationId, api_key_id: keyId, gateway_url: "https://other.example.test" }) }, "101010"), /unexpected service/);
  assert.equal(h.store.value, null);
});

test("issued credentials remain recoverable after a verification outage", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  const original = h.options.fetchImplementation;
  await assert.rejects(completeEmailLogin({ ...h.options, fetchImplementation: async (url, init) => new URL(url).pathname.endsWith("/snapshot") ? new Response(null, { status: 503 }) : original(url, init) }, "101010"), /503/);
  assert.equal(h.store.value.apiKey, apiKey);
  assert.equal(h.pendingStore.value, null);
});

for (const [existingOrg, existingService, inferenceReady] of [
  [organizationId, origin, true],
  ["synthetic-other-org", origin, false],
  [organizationId, "https://other.example.test", false],
]) {
  test("email sign-in preserves preexisting inference access and reports its matching scope", async () => {
    const h = harness();
    const existing = { version: 1, organizationId: existingOrg, inferenceUrl: existingService,
      keyId: "synthetic-existing-key", apiKey: ["synthetic", "existing", "credential"].join("-") };
    h.inferenceStore.value = existing;
    let locked = false;
    h.inferenceStore.withSetupLock = async operation => { locked = true; try { return await operation(); } finally { locked = false; } };
    h.inferenceStore.read = async () => { assert.equal(locked, true); return existing; };
    h.inferenceStore.write = async () => { throw new Error("Existing inference access must not be replaced"); };
    await beginEmailLogin(h.options, "person@example.test");
    const result = await completeEmailLogin(h.options, "101010");
    assert.equal(result.inferenceReady, inferenceReady);
    assert.equal(h.inferenceStore.value, existing);
    assert.equal(h.store.value.organizationId, organizationId);
  });
}

for (const revoked of [true, false]) {
  for (const pendingCleared of [true, false]) {
    test("failed sign-in persistence cleans up a consumed credential and sanitizes failure details", async () => {
      const h = harness();
      await beginEmailLogin(h.options, "person@example.test");
      h.store.write = async () => { throw new Error("synthetic-private-storage-detail"); };
      if (!pendingCleared) h.pendingStore.clear = async () => { throw new Error("synthetic-private-clear-detail"); };
      const original = h.options.fetchImplementation;
      let deletes = 0;
      h.options.fetchImplementation = async (url, init) => {
        if (init.method !== "DELETE") return original(url, init);
        deletes++;
        assert.equal(new URL(url).pathname, `/admin/v1/orgs/${organizationId}/api_keys/${keyId}`);
        assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
        return revoked ? Response.json({ id: keyId, revoked: true }) : new Response("synthetic-private-server-detail", { status: 503 });
      };
      await assert.rejects(completeEmailLogin(h.options, "101010"), error => {
        assert.equal(error.name, "CliError");
        assert.match(error.message, /issued but could not be stored/);
        assert.match(error.message, revoked ? /It was revoked/ : /could not be revoked/);
        assert.match(error.message, pendingCleared ? /spent pending claim was cleared/ : /Do not retry this code/);
        assert.doesNotMatch(error.message, /synthetic-private|synthetic-organization-key|synthetic-pending-claim|101010/);
        return true;
      });
      assert.equal(deletes, 1);
      assert.equal(h.pendingStore.value === null, pendingCleared);
      assert.equal(h.inferenceStore.value, null);
      assert.equal(h.store.value, null);
    });
  }
}

test("private auth and pending stores round-trip separate credential classes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "understudy-synthetic-email-"));
  try {
    const store = createCredentialStore({ directory });
    const pending = createPendingEmailStore({ directory });
    const value = { version: 1, method: "organization_key", apiKey, organizationId, keyId, serviceUrl: origin };
    await store.write(value);
    await pending.write({ version: 1, serviceUrl: origin, completeUrl: `${origin}/agent/auth/claim/complete`, claimToken: "synthetic-claim", expiresAt: now });
    assert.deepEqual(await store.read(), value);
    if (process.platform !== "win32") {
      assert.equal((await lstat(path.join(directory, "email-login-pending.json"))).mode & 0o777, 0o600);
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("organization keys are verified and never treated as OAuth tokens", async () => {
  const store = memory({ version: 1, method: "organization_key", apiKey, organizationId, keyId, serviceUrl: origin });
  let calls = 0;
  const session = await resolveManagementSession({ store, baseUrl: origin, fetchImplementation: async (_url, init) => {
    calls++;
    assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
    return Response.json({ org_id: organizationId });
  } });
  assert.equal(session.credentialClass, "organization_key");
  assert.equal(store.reads, 1);
  assert.equal(calls, 1);
  await assert.rejects(getValidAccessToken({ store, fetchImplementation: async () => { throw new Error("must not refresh a key"); } }), /requires browser OAuth/);
  await assert.rejects(resolveManagementSession({ store, baseUrl: origin, fetchImplementation: async () => Response.json({ org_id: "synthetic-other-org" }) }), /different organization/);
});

test("setup recovers stored email access and replacement preserves the active identity", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  await completeEmailLogin(h.options, "101010");
  await h.inferenceStore.clear();
  const callsBefore = h.calls.length;
  const setup = { authStore: h.store, inferenceStore: h.inferenceStore, baseUrl: origin, fetchImplementation: h.options.fetchImplementation };
  assert.deepEqual(await setupInference(setup), { status: "created" });
  assert.equal(h.calls.length, callsBefore + 1);
  assert.equal(h.inferenceStore.value.keyId, keyId);

  const calls = [];
  assert.deepEqual(await setupInference({ ...setup, replace: true, fetchImplementation: async (url, init) => {
    calls.push(init.method);
    if (new URL(url).pathname.endsWith("/snapshot")) return Response.json({ org_id: organizationId });
    assert.equal(init.method, "POST");
    return Response.json({ value: ["synthetic", "replacement", "credential"].join("-"), metadata: {
      object: "api_key", id: "synthetic-new-key", name: "Understudy CLI", owner: { type: "organization", id: organizationId },
    } });
  } }), { status: "replaced" });
  assert.deepEqual(calls, ["GET", "POST"]);
  assert.equal(h.store.value.keyId, keyId);
  assert.equal(h.inferenceStore.value.keyId, "synthetic-new-key");
});

test("status verifies an email identity and its inference readiness", async () => {
  const h = harness();
  await beginEmailLogin(h.options, "person@example.test");
  await completeEmailLogin(h.options, "101010");
  const status = await getStatus({ authStore: h.store, inferenceStore: h.inferenceStore, baseUrl: origin,
    fetchImplementation: async (url) => new URL(url).pathname.endsWith("/snapshot")
      ? Response.json({ org_id: organizationId, project_count: 2 })
      : Response.json({ data: [{ id: "synthetic-model" }] }),
  });
  assert.equal(status.ready, true);
  assert.equal(status.organizationId, organizationId);
  assert.equal(status.modelCount, 1);
});


test("email claim default project is verified and saved as private directory context", async () => {
  const contextStore = memory();
  const h = harness({ contextStore });
  const project = { id: "synthetic-default-project", slug: "synthetic-default", name: "Synthetic Default" };
  const original = h.options.fetchImplementation;
  h.options.fetchImplementation = async (url, init) => {
    const response = await original(url, init).catch(() => null);
    if (new URL(url).pathname.endsWith("/complete")) return Response.json({ ...await response.json(), default_project: project });
    if (new URL(url).pathname.endsWith("/projects")) return Response.json({ projects: [{ ...project, org_id: organizationId }] });
    return response;
  };
  await beginEmailLogin(h.options, "person@example.test");
  const result = await completeEmailLogin(h.options, "101010");
  assert.deepEqual(result.project, project);
  assert.deepEqual(await readApplicationContext({ contextStore }), { organizationId, project });
});

test("an unverified default project never changes context and preserves issued credentials", async () => {
  const contextStore = memory();
  const h = harness({ contextStore });
  const original = h.options.fetchImplementation;
  h.options.fetchImplementation = async (url, init) => {
    if (new URL(url).pathname.endsWith("/projects")) return Response.json({ projects: [] });
    const response = await original(url, init);
    if (new URL(url).pathname.endsWith("/complete")) return Response.json({ ...await response.json(), default_project: { slug: "synthetic-absent" } });
    return response;
  };
  await beginEmailLogin(h.options, "person@example.test");
  await assert.rejects(completeEmailLogin(h.options, "101010"), /Signed in, but the default project/);
  assert.equal(contextStore.value, null);
  assert.equal(h.store.value.apiKey, apiKey);
  assert.equal(h.pendingStore.value, null);
});
