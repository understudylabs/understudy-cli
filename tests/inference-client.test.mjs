import assert from "node:assert/strict";
import test from "node:test";

import {
  countInferenceModels,
  testInference,
} from "../dist/inference/client.js";

const applicationCredential = ["synthetic", "application", "credential"].join("-");
const credential = {
  version: 1,
  organizationId: "synthetic-organization",
  keyId: "synthetic-key",
  apiKey: applicationCredential,
  inferenceUrl: "https://example.test",
};

test("rejected inference access points to credential replacement", async () => {
  await assert.rejects(
    countInferenceModels(
      credential,
      async () => new Response(null, { status: 401 }),
    ),
    /understudy setup --replace/i,
  );

  await assert.rejects(
    countInferenceModels(
      credential,
      async () => new Response(null, { status: 503 }),
    ),
    (error) => {
      assert.match(error.message, /try again shortly/i);
      assert.doesNotMatch(error.message, /--replace/i);
      return true;
    },
  );
});

test("inference test sends one OpenAI request and returns routing evidence", async () => {
  let request;
  let requests = 0;
  const times = [1_000, 1_025];
  const result = await testInference({
    credential,
    api: "openai",
    project: "synthetic-project",
    workload: "synthetic-workload",
    model: "synthetic-model",
    now: () => times.shift(),
    fetchImplementation: async (input, init) => {
      requests += 1;
      request = { input: String(input), init };
      return Response.json(
        {
          choices: [{ message: { role: "assistant", content: "OK" } }],
        },
        {
          headers: {
            "x-understudy-request-id": "synthetic-request",
            "x-understudy-mode": "managed",
            "x-understudy-route": "primary",
            "x-understudy-environment": "test",
            "x-understudy-effective-model": "synthetic-model",
          },
        },
      );
    },
  });

  assert.equal(requests, 1);
  assert.equal(request.input, "https://example.test/v1/chat/completions");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.authorization, `Bearer ${applicationCredential}`);
  assert.equal(request.init.headers["x-api-key"], undefined);
  assert.equal(request.init.headers["anthropic-version"], undefined);
  assert.equal(request.init.headers["x-understudy-project"], "synthetic-project");
  assert.equal(request.init.headers["x-understudy-workload"], "synthetic-workload");
  assert.equal(request.init.headers["x-understudy-environment"], "test");
  assert.deepEqual(JSON.parse(request.init.body), {
    model: "synthetic-model",
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    max_tokens: 8,
    stream: false,
  });
  assert.deepEqual(result, {
    ok: true,
    requestEnvironment: "test",
    api: "openai",
    requestId: "synthetic-request",
    project: "synthetic-project",
    workload: "synthetic-workload",
    requestedModel: "synthetic-model",
    effectiveModel: "synthetic-model",
    mode: "managed",
    route: "primary",
    latencyMs: 25,
  });
});

test("inference test sends one Anthropic request and validates its response", async () => {
  let request;
  let requests = 0;
  const result = await testInference({
    credential,
    api: "anthropic",
    project: "synthetic-project",
    workload: "synthetic-workload",
    model: "claude-synthetic",
    now: () => 1_000,
    fetchImplementation: async (input, init) => {
      requests += 1;
      request = { input: String(input), init };
      return Response.json(
        {
          id: "msg_synthetic",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
        },
        {
          headers: {
            "x-understudy-request-id": "synthetic-request",
            "x-understudy-mode": "managed",
            "x-understudy-route": "primary",
            "x-understudy-environment": "test",
            "x-understudy-effective-model": "claude-synthetic",
          },
        },
      );
    },
  });

  assert.equal(requests, 1);
  assert.equal(request.input, "https://example.test/v1/messages");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.authorization, undefined);
  assert.equal(request.init.headers["x-api-key"], applicationCredential);
  assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.init.headers["x-understudy-project"], "synthetic-project");
  assert.equal(request.init.headers["x-understudy-workload"], "synthetic-workload");
  assert.equal(request.init.headers["x-understudy-environment"], "test");
  assert.deepEqual(JSON.parse(request.init.body), {
    model: "claude-synthetic",
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    max_tokens: 8,
    stream: false,
  });
  assert.deepEqual(result, {
    ok: true,
    requestEnvironment: "test",
    api: "anthropic",
    requestId: "synthetic-request",
    project: "synthetic-project",
    workload: "synthetic-workload",
    requestedModel: "claude-synthetic",
    effectiveModel: "claude-synthetic",
    mode: "managed",
    route: "primary",
    latencyMs: 0,
  });
});

test("OpenAI test requests use model-compatible token parameters", async () => {
  const cases = [
    {
      model: "gpt-5.4",
      expected: { max_completion_tokens: 64 },
    },
    {
      model: "o3",
      expected: { max_completion_tokens: 64 },
    },
    {
      model: "chat-latest",
      expected: { max_completion_tokens: 64 },
    },
    {
      model: "nemotron-3-ultra",
      expected: { max_tokens: 16 },
    },
    {
      model: "openai/gpt-5.4",
      expected: { max_completion_tokens: 64 },
    },
    {
      model: "openai:o3",
      expected: { max_completion_tokens: 64 },
    },
    {
      model: "gateway/chat-latest",
      expected: { max_completion_tokens: 64 },
    },
    {
      model: "concentrate/nemotron-3-ultra",
      expected: { max_tokens: 16 },
    },
  ];

  for (const { model, expected } of cases) {
    let body;
    await testInference({
      credential,
      api: "openai",
      project: "synthetic-project",
      workload: "synthetic-workload",
      model,
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(init.body);
        return Response.json(
          { choices: [{ message: { content: "OK" } }] },
          {
            headers: {
              "x-understudy-request-id": "synthetic-request",
              "x-understudy-mode": "managed",
              "x-understudy-route": "primary",
              "x-understudy-environment": "test",
              "x-understudy-effective-model": model,
            },
          },
        );
      },
    });

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(body).filter(([key]) => key.includes("tokens")),
      ),
      expected,
    );
  }
});

test("inference test never exposes a failed response body or credential", async () => {
  const privateBody = "private response content";
  await assert.rejects(
    testInference({
      credential,
      api: "openai",
      project: "synthetic-project",
      workload: "synthetic-workload",
      model: "synthetic-model",
      fetchImplementation: async () =>
        Response.json(
          { message: privateBody },
          {
            status: 503,
            headers: { "x-understudy-request-id": "synthetic-request", "x-understudy-environment": "test" },
          },
        ),
    }),
    (error) => {
      assert.match(error.message, /503/);
      assert.match(error.message, /synthetic-request/);
      assert.doesNotMatch(error.message, /--replace/i);
      assert.doesNotMatch(error.message, new RegExp(privateBody));
      assert.doesNotMatch(error.message, new RegExp(applicationCredential));
      return true;
    },
  );
});

test("rejected inference tests point to credential replacement", async () => {
  await assert.rejects(
    testInference({
      credential,
      api: "openai",
      project: "synthetic-project",
      workload: "synthetic-workload",
      model: "synthetic-model",
      fetchImplementation: async () =>
        new Response(null, {
          status: 403,
          headers: { "x-understudy-request-id": "synthetic-request", "x-understudy-environment": "test" },
        }),
    }),
    (error) => {
      assert.match(error.message, /403/);
      assert.match(error.message, /synthetic-request/);
      assert.match(error.message, /understudy setup --replace/i);
      return true;
    },
  );
});

test("inference test omits unsafe diagnostic request IDs", async () => {
  const unsafeRequestId = "synthetic\u001b[31m-request";
  await assert.rejects(
    testInference({
      credential,
      api: "openai",
      project: "synthetic-project",
      workload: "synthetic-workload",
      model: "synthetic-model",
      fetchImplementation: async () =>
        Response.json(
          { message: "synthetic failure" },
          {
            status: 503,
            headers: { "x-understudy-request-id": unsafeRequestId, "x-understudy-environment": "test" },
          },
        ),
    }),
    (error) => {
      assert.match(error.message, /503/);
      assert.doesNotMatch(error.message, /request synthetic/);
      assert.doesNotMatch(error.message, /\u001b/);
      return true;
    },
  );
});

test("inference test rejects incomplete success evidence", async () => {
  await assert.rejects(
    testInference({
      credential,
      api: "openai",
      project: "synthetic-project",
      workload: "synthetic-workload",
      model: "synthetic-model",
      fetchImplementation: async () =>
        Response.json({ choices: [{ message: { content: "OK" } }] }, { headers: { "x-understudy-environment": "test" } }),
    }),
    /incomplete test response/i,
  );
});

test("inference tests reject absent or different environment echoes without retrying", async () => {
  for (const api of ["openai", "anthropic"]) {
    for (const environment of [null, "production", "beta", "TEST", "test, test"]) {
      for (const status of [200, 503]) {
        let requests = 0;
        await assert.rejects(testInference({
          credential, api, project: "synthetic-project", workload: "synthetic-workload", model: "synthetic-model",
          fetchImplementation: async (_url, init) => {
            requests += 1;
            assert.equal(init.headers["x-understudy-environment"], "test");
            const headers = {
              "x-understudy-request-id": "synthetic-request",
              "x-understudy-effective-model": "synthetic-model",
              "x-understudy-mode": "managed", "x-understudy-route": "primary",
              ...(environment === null ? {} : { "x-understudy-environment": environment }),
            };
            return Response.json(api === "openai"
              ? { choices: [{ message: { content: "OK" } }] }
              : { content: [{ type: "text", text: "OK" }] }, { status, headers });
          },
        }), /did not confirm the test environment/);
        assert.equal(requests, 1);
      }
    }
  }
});
