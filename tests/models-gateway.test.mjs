import assert from "node:assert/strict";
import test from "node:test";

import { listModels, showModel } from "../dist/models/service.js";

const organizationId = "synthetic-organization";
const inferenceCredential = {
  version: 1,
  organizationId,
  keyId: "synthetic-key",
  apiKey: ["synthetic", "inference", "credential"].join("-"),
  inferenceUrl: "https://example.test",
};
const accessToken = `synthetic.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1_000) + 3_600,
  org_id: organizationId,
})).toString("base64url")}.signature`;
const catalog = { data: [
  { id: "synthetic-chat", display_name: "Synthetic Chat", is_open_weight: true, wire_shapes: ["openai-chat"], private_supplier: "discard" },
  { id: "synthetic-both", display_name: "Synthetic Both", is_open_weight: false, wire_shapes: ["openai-chat", "anthropic-messages"] },
  { id: "synthetic-legacy" },
  { id: "synthetic-null", wire_shapes: null },
  { id: "synthetic-empty", wire_shapes: [] },
] };

function readonlyStore(value) {
  return {
    read: async () => value,
    write: async () => assert.fail("Catalog reads must not write credentials"),
    clear: async () => assert.fail("Catalog reads must not clear credentials"),
  };
}

function options(overrides = {}) {
  return {
    store: readonlyStore({ version: 1, method: "oauth", accessToken }),
    inferenceStore: readonlyStore(inferenceCredential),
    baseUrl: "https://example.test/",
    gateway: true,
    fetchImplementation: async () => Response.json(catalog),
    ...overrides,
  };
}

test("gateway catalog uses one authenticated read and preserves public protocol metadata only", async () => {
  const calls = [];
  const result = await listModels(options({ fetchImplementation: async (url, init) => {
    calls.push({ url, init });
    return Response.json(catalog);
  } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/v1/models");
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${inferenceCredential.apiKey}`);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(result.source, "gateway_catalog");
  assert.deepEqual(result.models, [
    { id: "synthetic-chat", displayName: "Synthetic Chat", openWeight: true, wireShapes: ["openai-chat"] },
    { id: "synthetic-both", displayName: "Synthetic Both", openWeight: false, wireShapes: ["openai-chat", "anthropic-messages"] },
    { id: "synthetic-legacy", displayName: "synthetic-legacy", openWeight: null, wireShapes: null },
    { id: "synthetic-null", displayName: "synthetic-null", openWeight: null, wireShapes: null },
    { id: "synthetic-empty", displayName: "synthetic-empty", openWeight: null, wireShapes: [] },
  ]);
  assert.match(result.missingCapabilities[0].reason, /does not publish tool support/);
  assert.match(result.missingCapabilities[0].reason, /current serving health/);
  assert.doesNotMatch(JSON.stringify(result), /private_supplier|discard|synthetic-inference-credential/);
});

test("gateway model detail selects an exact catalog identity without inventing capabilities", async () => {
  const result = await showModel(options(), "synthetic-chat");
  assert.equal(result.source, "gateway_catalog");
  assert.deepEqual(result.model.wireShapes, ["openai-chat"]);
  assert.equal(result.inferenceCapabilities, null);
  await assert.rejects(showModel(options(), "synthetic"), /not found/);
  let calls = 0;
  await assert.rejects(showModel(options({ fetchImplementation: async () => { calls++; } }), "Synthetic Invalid"), /exact model id/);
  assert.equal(calls, 0);
});

test("gateway catalog requires an existing credential and exact organization before network access", async () => {
  for (const [credential, expected] of [
    [null, /not set up/],
    [{ ...inferenceCredential, organizationId: "synthetic-other-organization" }, /another organization/],
  ]) {
    let calls = 0;
    await assert.rejects(listModels(options({
      inferenceStore: readonlyStore(credential),
      fetchImplementation: async () => { calls++; assert.fail("No gateway call expected"); },
    })), expected);
    assert.equal(calls, 0);
  }
});

test("gateway catalog rejects service mismatches before disclosing the inference key", async () => {
  for (const inferenceUrl of [
    "https://other.example.test", "https://example.test/prefix", "http://example.test",
    "https://example.test?query=1", "https://example.test#fragment", "https://user@example.test",
  ]) {
    let calls = 0;
    await assert.rejects(listModels(options({
      inferenceStore: readonlyStore({ ...inferenceCredential, inferenceUrl }),
      fetchImplementation: async () => { calls++; assert.fail("No gateway call expected"); },
    })), /another service/);
    assert.equal(calls, 0);
  }
  const result = await listModels(options({
    inferenceStore: readonlyStore({ ...inferenceCredential, inferenceUrl: "https://EXAMPLE.test:443/" }),
  }));
  assert.equal(result.models.length, catalog.data.length);
});

test("organization-key auth verifies management identity before reading the gateway catalog", async () => {
  const authStore = readonlyStore({
    version: 1, method: "organization_key", organizationId, keyId: "synthetic-management-key",
    apiKey: ["synthetic", "management", "credential"].join("-"), serviceUrl: "https://example.test",
  });
  for (const mismatched of [false, true]) {
    const calls = [];
    const promise = listModels(options({
      store: authStore,
      inferenceStore: readonlyStore({ ...inferenceCredential, ...(mismatched ? { inferenceUrl: "https://other.example.test" } : {}) }),
      fetchImplementation: async (url, init) => {
        calls.push({ url: String(url), key: init.headers.authorization });
        if (String(url).endsWith("/snapshot")) return Response.json({ org_id: organizationId });
        return Response.json(catalog);
      },
    }));
    if (mismatched) await assert.rejects(promise, /another service/);
    else assert.equal((await promise).source, "gateway_catalog");
    assert.deepEqual(calls, [
      { url: `https://example.test/admin/v1/orgs/${organizationId}/snapshot`, key: "Bearer synthetic-management-credential" },
      ...(mismatched ? [] : [{ url: "https://example.test/v1/models", key: `Bearer ${inferenceCredential.apiKey}` }]),
    ]);
  }
});

test("default management catalog never reads the inference credential", async () => {
  const result = await listModels(options({ gateway: false,
    inferenceStore: { read: async () => assert.fail("Default catalog must not need setup") },
    fetchImplementation: async (url, init) => {
      assert.equal(String(url), `https://example.test/admin/v1/orgs/${organizationId}/models`);
      assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
      return Response.json({ models: [{ id: "synthetic-model", display_name: "Synthetic Model" }] });
    },
  }));
  assert.equal(result.source, undefined);
  assert.equal(result.models[0].wireShapes, undefined);
});

test("malformed gateway fields and duplicate identities fail without exposing response values", async () => {
  const invalidRows = [
    [{ id: "synthetic-model", wire_shapes: "openai-chat" }],
    [{ id: "synthetic-model", wire_shapes: ["private-unsupported-shape"] }],
    [{ id: "synthetic-model", wire_shapes: ["openai-chat", "openai-chat"] }],
    [{ id: "synthetic-model", is_open_weight: "true" }],
    [{ id: "Synthetic-Model" }],
    [{ id: "synthetic-model" }, { id: "synthetic-model" }],
  ];
  for (const data of invalidRows) {
    await assert.rejects(listModels(options({ fetchImplementation: async () => Response.json({ data }) })), error => {
      assert.match(error.message, /invalid gateway model list/);
      assert.doesNotMatch(error.message, /private-unsupported-shape|synthetic-inference-credential/);
      return true;
    });
  }
});

test("gateway transport and invalid JSON failures preserve private credentials and response bodies", async () => {
  for (const response of [
    () => new Response("private-body", { status: 403 }),
    () => new Response("private-body", { status: 503 }),
    () => new Response("private-body", { status: 200 }),
    () => { throw new Error(inferenceCredential.apiKey); },
  ]) {
    await assert.rejects(listModels(options({ fetchImplementation: async () => response() })), error => {
      assert.doesNotMatch(error.message, /private-body|synthetic-inference-credential/);
      return true;
    });
  }
});
