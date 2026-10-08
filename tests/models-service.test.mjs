import assert from "node:assert/strict";
import test from "node:test";

import { listModels, modelCapabilityGap } from "../dist/models/service.js";

function tokenFor(organizationId) {
  const claims = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      org_id: organizationId,
    }),
  ).toString("base64url");
  return `synthetic.${claims}.signature`;
}

function store(accessToken) {
  return {
    read: async () => ({ version: 1, method: "oauth", accessToken }),
    write: async () => undefined,
    clear: async () => undefined,
  };
}

test("model listing uses OAuth, encodes the organization, and normalizes public fields", async () => {
  const accessToken = tokenFor("synthetic/organization");
  let request;

  const result = await listModels({
    store: store(accessToken),
    baseUrl: "https://example.test/",
    fetchImplementation: async (input, init) => {
      request = { input: String(input), init };
      return Response.json({
        models: [
          {
            id: "synthetic-open-model",
            display_name: "Synthetic Open Model",
            is_open_weight: true,
            internal_field: "must not cross the service boundary",
          },
          {
            id: "synthetic-hosted-model",
            display_name: "Synthetic Hosted Model",
            is_open_weight: false,
          },
          {
            id: "synthetic-unknown-model",
            display_name: "Synthetic Unknown Model",
          },
        ],
      });
    },
  });

  assert.equal(
    request.input,
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/models",
  );
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.authorization, `Bearer ${accessToken}`);
  assert.deepEqual(result, {
    missingCapabilities: [modelCapabilityGap],
    models: [
      {
        id: "synthetic-open-model",
        displayName: "Synthetic Open Model",
        openWeight: true,
      },
      {
        id: "synthetic-hosted-model",
        displayName: "Synthetic Hosted Model",
        openWeight: false,
      },
      {
        id: "synthetic-unknown-model",
        displayName: "Synthetic Unknown Model",
        openWeight: null,
      },
    ],
  });
  assert.equal(result.missingCapabilities[0].code, "missing_capability");
  assert.match(result.missingCapabilities[0].reason, /endpoint or tool support, context limits/);
  assert.match(result.missingCapabilities[0].reason, /pricing/);
  for (const speculativeField of ["command", "inputContract", "outputContract"]) {
    assert.equal(Object.hasOwn(result.missingCapabilities[0], speculativeField), false);
  }
});

test("model listing returns the complete catalog without a local limit", async () => {
  const models = Array.from({ length: 101 }, (_, index) => ({
    id: `synthetic-model-${index}`,
    display_name: `Synthetic Model ${index}`,
  }));
  const result = await listModels({
    store: store(tokenFor("synthetic-organization")),
    baseUrl: "https://example.test",
    fetchImplementation: async () => Response.json({ models }),
  });
  assert.deepEqual(result.models.map(model => model.id), models.map(model => model.id));
  assert.ok(result.models.every(model => model.openWeight === null));
});

test("malformed model responses fail without leaking OAuth or response data", async () => {
  const accessToken = tokenFor("synthetic-organization");
  const privateResponseValue = "private-response-value";

  await assert.rejects(
    listModels({
      store: store(accessToken),
      baseUrl: "https://example.test",
      fetchImplementation: async () =>
        Response.json({
          models: [
            {
              id: "synthetic-model",
              display_name: privateResponseValue,
              is_open_weight: "not-a-boolean",
            },
          ],
        }),
    }),
    (error) => {
      assert.match(error.message, /invalid model list/i);
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      assert.doesNotMatch(error.message, new RegExp(privateResponseValue));
      return true;
    },
  );
});

test("model listing rejects IDs outside the inference contract", async () => {
  const accessToken = tokenFor("synthetic-organization");

  await assert.rejects(
    listModels({
      store: store(accessToken),
      baseUrl: "https://example.test",
      fetchImplementation: async () =>
        Response.json({
          models: [
            {
              id: "Synthetic-Model",
              display_name: "Synthetic Model",
              is_open_weight: false,
            },
          ],
        }),
    }),
    /invalid model list/i,
  );
});
