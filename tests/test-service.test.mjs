import assert from "node:assert/strict";
import test from "node:test";

import { runTest } from "../dist/test/service.js";

function tokenFor(organizationId) {
  const claims = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600, org_id: organizationId }),
  ).toString("base64url");
  return `synthetic.${claims}.signature`;
}

function store(value) {
  return {
    read: async () => value,
    write: async () => undefined,
    clear: async () => undefined,
  };
}

const input = {
  api: "openai",
  project: "synthetic-project",
  workload: "synthetic-workload",
  model: "synthetic-model",
};

test("test requires setup before sending inference traffic", async () => {
  let requests = 0;
  await assert.rejects(
    runTest({
      ...input,
      authStore: store({
        version: 1,
        method: "oauth",
        accessToken: tokenFor("synthetic-organization"),
      }),
      inferenceStore: store(null),
      fetchImplementation: async () => {
        requests += 1;
        throw new Error("must not request");
      },
    }),
    /not set up/i,
  );
  assert.equal(requests, 0);
});

test("test refuses access stored for another organization", async () => {
  let requests = 0;
  await assert.rejects(
    runTest({
      ...input,
      authStore: store({
        version: 1,
        method: "oauth",
        accessToken: tokenFor("synthetic-current-organization"),
      }),
      inferenceStore: store({
        version: 1,
        organizationId: "synthetic-other-organization",
        keyId: "synthetic-key",
        apiKey: ["synthetic", "application", "credential"].join("-"),
        inferenceUrl: "https://example.test",
      }),
      fetchImplementation: async () => {
        requests += 1;
        throw new Error("must not request");
      },
    }),
    /another organization/i,
  );
  assert.equal(requests, 0);
});

for (const method of ["oauth", "organization_key"]) {
  test(`test refuses same-organization credentials for another service with ${method}`, async () => {
    const org = "synthetic-organization", service = "https://active.example.test";
    const requests = [];
    const identity = method === "oauth"
      ? { version: 1, method, accessToken: tokenFor(org) }
      : { version: 1, method, organizationId: org, keyId: "synthetic-identity-key", apiKey: ["synthetic", "identity", "credential"].join("-"), serviceUrl: service };
    await assert.rejects(runTest({ ...input,
      authStore: store(identity),
      inferenceStore: store({ version: 1, organizationId: org, keyId: "synthetic-inference-key", apiKey: ["synthetic", "inference", "credential"].join("-"), inferenceUrl: "https://other.example.test" }),
      baseUrl: service,
      fetchImplementation: async value => {
        const url = new URL(value);
        requests.push(url);
        assert.equal(url.origin, service);
        assert.ok(url.pathname.endsWith("/snapshot"));
        return Response.json({ org_id: org });
      },
    }), /another service/);
    assert.equal(requests.length, method === "oauth" ? 0 : 1);
  });
}

test("test uses matching service access after harmless URL normalization", async () => {
  const org = "synthetic-organization", requests = [];
  const result = await runTest({ ...input,
    authStore: store({ version: 1, method: "oauth", accessToken: tokenFor(org) }),
    inferenceStore: store({ version: 1, organizationId: org, keyId: "synthetic-key", apiKey: ["synthetic", "inference", "credential"].join("-"), inferenceUrl: "https://ACTIVE.example.test:443/" }),
    baseUrl: "https://active.example.test",
    fetchImplementation: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ choices: [{ message: { content: "OK" } }] }, { headers: {
        "x-understudy-request-id": "synthetic-request", "x-understudy-effective-model": input.model,
        "x-understudy-mode": "managed", "x-understudy-route": "primary", "x-understudy-environment": "test",
      } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).origin, "https://active.example.test");
});
