import assert from "node:assert/strict";
import test from "node:test";

import { getStatus } from "../dist/status/service.js";

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

test("status is actionable without authentication and makes no requests", async () => {
  let requests = 0;
  const result = await getStatus({
    authStore: store(null),
    inferenceStore: store(null),
    fetchImplementation: async () => {
      requests += 1;
      throw new Error("must not request");
    },
  });

  assert.equal(requests, 0);
  assert.deepEqual(result, {
    authenticated: false,
    ready: false,
    organizationId: null,
    management: "not-checked",
    access: "setup-required",
    projectCount: null,
    modelCount: null,
  });
});

test("status verifies OAuth and private application access without exposing credentials", async () => {
  const accessToken = tokenFor("synthetic-organization");
  const applicationCredential = ["synthetic", "application", "credential"].join("-");
  const requests = [];

  const result = await getStatus({
    authStore: store({ version: 1, method: "oauth", accessToken }),
    inferenceStore: store({
      version: 1,
      organizationId: "synthetic-organization",
      keyId: "synthetic-key",
      apiKey: applicationCredential,
      inferenceUrl: "https://example.test",
    }),
    baseUrl: "https://example.test",
    fetchImplementation: async (input, init) => {
      requests.push({
        input: String(input),
        authorization: init.headers.authorization,
        redirect: init.redirect,
      });
      if (String(input).endsWith("/snapshot")) {
        return Response.json({
          org_id: "synthetic-organization",
          project_count: 2,
        });
      }
      return Response.json({
        object: "list",
        data: [{ id: "synthetic-model" }],
      });
    },
  });

  assert.deepEqual(result, {
    authenticated: true,
    ready: true,
    organizationId: "synthetic-organization",
    management: "connected",
    access: "ready",
    projectCount: 2,
    modelCount: 1,
  });
  assert.deepEqual(requests, [
    {
      input: "https://example.test/admin/v1/orgs/synthetic-organization/snapshot",
      authorization: `Bearer ${accessToken}`,
      redirect: "error",
    },
    {
      input: "https://example.test/v1/models",
      authorization: `Bearer ${applicationCredential}`,
      redirect: "error",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(applicationCredential));
});

test("status does not send a credential stored for another organization", async () => {
  let inferenceRequests = 0;
  const result = await getStatus({
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
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      if (String(input).endsWith("/v1/models")) inferenceRequests += 1;
      return Response.json({
        org_id: "synthetic-current-organization",
        project_count: 1,
      });
    },
  });

  assert.equal(result.access, "organization-mismatch");
  assert.equal(result.ready, false);
  assert.equal(inferenceRequests, 0);
});

for (const method of ["oauth", "organization_key"]) {
  test(`status rejects same-organization inference access for another service with ${method}`, async () => {
    const org = "synthetic-organization", service = "https://active.example.test";
    const requests = [];
    const identity = method === "oauth"
      ? { version: 1, method, accessToken: tokenFor(org) }
      : { version: 1, method, organizationId: org, keyId: "synthetic-identity-key", apiKey: ["synthetic", "identity", "credential"].join("-"), serviceUrl: service };
    const result = await getStatus({
      authStore: store(identity),
      inferenceStore: store({ version: 1, organizationId: org, keyId: "synthetic-inference-key", apiKey: ["synthetic", "inference", "credential"].join("-"), inferenceUrl: "https://other.example.test" }),
      baseUrl: service,
      fetchImplementation: async input => {
        const url = new URL(input);
        requests.push(url);
        assert.equal(url.origin, service);
        assert.ok(url.pathname.endsWith("/snapshot"));
        return Response.json({ org_id: org, project_count: 1 });
      },
    });
    assert.equal(result.ready, false);
    assert.equal(result.access, "service-mismatch");
    assert.equal(result.modelCount, null);
    assert.equal(requests.length, method === "oauth" ? 1 : 2);
  });
}
