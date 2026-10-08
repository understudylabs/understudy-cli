import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createInferenceCredentialStore } from "../dist/inference/credentials.js";
import { setupInference } from "../dist/inference/service.js";

function syntheticJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return [header, payload, "synthetic-signature"].join(".");
}

function createAuthStore(organizationId = "synthetic-organization") {
  return {
    read: async () => ({
      version: 1,
      method: "oauth",
      accessToken: syntheticJwt({
        exp: Date.now() / 1_000 + 3_600,
        org_id: organizationId,
      }),
    }),
    write: async () => undefined,
    clear: async () => undefined,
  };
}

function withoutContention(operation) {
  return operation();
}

test("inference setup creates and privately stores one application credential", async () => {
  const writes = [];
  const value = ["synthetic", "application", "credential"].join("-");
  const inferenceStore = {
    read: async () => null,
    write: async (credential) => writes.push(credential),
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  const result = await setupInference({
    authStore: createAuthStore(),
    inferenceStore,
    baseUrl: "https://example.test",
    fetchImplementation: async (_input, init) => {
      assert.equal(init.method, "POST");
      return Response.json(
        {
          value,
          metadata: {
            object: "api_key",
            id: "synthetic-key",
            name: "Understudy CLI",
            owner: { type: "organization", id: "synthetic-organization" },
          },
        },
        { status: 201 },
      );
    },
  });

  assert.deepEqual(result, { status: "created" });
  assert.deepEqual(writes, [
    {
      version: 1,
      organizationId: "synthetic-organization",
      keyId: "synthetic-key",
      apiKey: value,
      inferenceUrl: "https://example.test",
    },
  ]);
});

test("inference setup reuses the current organization's stored credential", async () => {
  let writes = 0;
  const inferenceStore = {
    read: async () => ({
      version: 1,
      organizationId: "synthetic-organization",
      keyId: "synthetic-key",
      apiKey: ["synthetic", "stored", "credential"].join("-"),
      inferenceUrl: "https://example.test",
    }),
    write: async () => {
      writes += 1;
    },
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  const result = await setupInference({
    authStore: createAuthStore(),
    inferenceStore,
    fetchImplementation: async () => {
      throw new Error("network should not be called");
    },
  });

  assert.deepEqual(result, { status: "existing" });
  assert.equal(writes, 0);
});

test("inference setup can replace rejected access and revoke the old key", async () => {
  const requests = [];
  const writes = [];
  const newValue = ["synthetic", "replacement", "credential"].join("-");
  const inferenceStore = {
    read: async () => ({
      version: 1,
      organizationId: "synthetic-organization",
      keyId: "synthetic-old-key",
      apiKey: ["synthetic", "old", "credential"].join("-"),
      inferenceUrl: "https://example.test",
    }),
    write: async (credential) => writes.push(credential),
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  const result = await setupInference({
    authStore: createAuthStore(),
    inferenceStore,
    baseUrl: "https://example.test",
    replace: true,
    fetchImplementation: async (input, init) => {
      requests.push({ input: String(input), method: init.method });
      return init.method === "POST"
        ? Response.json(
            {
              value: newValue,
              metadata: {
                object: "api_key",
                id: "synthetic-new-key",
                name: "Understudy CLI",
                owner: {
                  type: "organization",
                  id: "synthetic-organization",
                },
              },
            },
            { status: 201 },
          )
        : Response.json({ id: "synthetic-old-key", revoked: true });
    },
  });

  assert.deepEqual(result, { status: "replaced" });
  assert.deepEqual(writes, [
    {
      version: 1,
      organizationId: "synthetic-organization",
      keyId: "synthetic-new-key",
      apiKey: newValue,
      inferenceUrl: "https://example.test",
    },
  ]);
  assert.deepEqual(requests, [
    {
      input:
        "https://example.test/admin/v1/orgs/synthetic-organization/api_keys",
      method: "POST",
    },
    {
      input:
        "https://example.test/admin/v1/orgs/synthetic-organization/api_keys/synthetic-old-key",
      method: "DELETE",
    },
  ]);
});

test("inference replacement recovers locally without sending OAuth to a different service", async () => {
  const requests = [];
  const writes = [];
  let stored = {
    version: 1,
    organizationId: "synthetic-organization",
    keyId: "synthetic-old-key",
    apiKey: ["synthetic", "old", "credential"].join("-"),
    inferenceUrl: "https://old.example.test",
  };
  const inferenceStore = {
    read: async () => stored,
    write: async (credential) => {
      stored = credential;
      writes.push(credential);
    },
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  await assert.rejects(
    setupInference({
      authStore: createAuthStore(),
      inferenceStore,
      baseUrl: "https://new.example.test",
      replace: true,
      fetchImplementation: async (input, init) => {
        requests.push({ input: String(input), method: init.method });
        return Response.json(
          {
            value: ["synthetic", "replacement", "credential"].join("-"),
            metadata: {
              object: "api_key",
              id: "synthetic-old-key",
              name: "Understudy CLI",
              owner: {
                type: "organization",
                id: "synthetic-organization",
              },
            },
          },
          { status: 201 },
        );
      },
    }),
    (error) => {
      assert.match(error.message, /access was replaced/i);
      assert.match(error.message, /different Understudy service/i);
      assert.match(error.message, /dashboard/i);
      return true;
    },
  );

  assert.deepEqual(requests, [
    {
      input:
        "https://new.example.test/admin/v1/orgs/synthetic-organization/api_keys",
      method: "POST",
    },
  ]);
  assert.equal(writes.length, 1);
  assert.equal(stored.keyId, "synthetic-old-key");
  assert.equal(stored.inferenceUrl, "https://new.example.test");

  const retry = await setupInference({
    authStore: createAuthStore(),
    inferenceStore,
    baseUrl: "https://new.example.test",
    fetchImplementation: async () => {
      throw new Error("must not request");
    },
  });
  assert.deepEqual(retry, { status: "existing" });
});

test("inference replacement rejects a reused credential id", async () => {
  let writes = 0;
  let requests = 0;
  const inferenceStore = {
    read: async () => ({
      version: 1,
      organizationId: "synthetic-organization",
      keyId: "synthetic-key",
      apiKey: ["synthetic", "old", "credential"].join("-"),
      inferenceUrl: "https://example.test",
    }),
    write: async () => {
      writes += 1;
    },
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  await assert.rejects(
    setupInference({
      authStore: createAuthStore(),
      inferenceStore,
      baseUrl: "https://example.test",
      replace: true,
      fetchImplementation: async () => {
        requests += 1;
        return Response.json(
          {
            value: ["synthetic", "replacement", "credential"].join("-"),
            metadata: {
              object: "api_key",
              id: "synthetic-key",
              name: "Understudy CLI",
              owner: {
                type: "organization",
                id: "synthetic-organization",
              },
            },
          },
          { status: 201 },
        );
      },
    }),
    (error) => {
      assert.match(error.message, /invalid replacement response/i);
      assert.match(error.message, /outcome is unknown/i);
      assert.match(error.message, /dashboard/i);
      return true;
    },
  );

  assert.equal(requests, 1);
  assert.equal(writes, 0);
});

test("inference replacement reports failed old-key cleanup after storing new access", async () => {
  const writes = [];
  const newValue = ["synthetic", "replacement", "credential"].join("-");
  const inferenceStore = {
    read: async () => ({
      version: 1,
      organizationId: "synthetic-organization",
      keyId: "synthetic-old-key",
      apiKey: ["synthetic", "old", "credential"].join("-"),
      inferenceUrl: "https://example.test",
    }),
    write: async (credential) => writes.push(credential),
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  await assert.rejects(
    setupInference({
      authStore: createAuthStore(),
      inferenceStore,
      baseUrl: "https://example.test",
      replace: true,
      fetchImplementation: async (_input, init) =>
        init.method === "POST"
          ? Response.json(
              {
                value: newValue,
                metadata: {
                  object: "api_key",
                  id: "synthetic-new-key",
                  name: "Understudy CLI",
                  owner: {
                    type: "organization",
                    id: "synthetic-organization",
                  },
                },
              },
              { status: 201 },
            )
          : Response.json({}, { status: 500 }),
    }),
    (error) => {
      assert.match(error.message, /access was replaced/i);
      assert.match(error.message, /dashboard/i);
      assert.doesNotMatch(error.message, new RegExp(newValue));
      return true;
    },
  );

  assert.equal(writes.length, 1);
  assert.equal(writes[0].keyId, "synthetic-new-key");
});

test("inference setup revokes a new key when private storage fails", async () => {
  const methods = [];
  const value = ["synthetic", "temporary", "credential"].join("-");
  const privateMessage = "private storage detail";
  const inferenceStore = {
    read: async () => null,
    write: async () => {
      throw new Error(privateMessage);
    },
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  await assert.rejects(
    setupInference({
      authStore: createAuthStore(),
      inferenceStore,
      baseUrl: "https://example.test",
      fetchImplementation: async (_input, init) => {
        methods.push(init.method);
        return init.method === "POST"
          ? Response.json(
              {
                value,
                metadata: {
                  object: "api_key",
                  id: "synthetic-key",
                  name: "Understudy CLI",
                  owner: {
                    type: "organization",
                    id: "synthetic-organization",
                  },
                },
              },
              { status: 201 },
            )
          : Response.json({ id: "synthetic-key", revoked: true });
      },
    }),
    (error) => {
      assert.match(error.message, /was revoked/i);
      assert.doesNotMatch(error.message, new RegExp(privateMessage));
      assert.doesNotMatch(error.message, new RegExp(value));
      return true;
    },
  );
  assert.deepEqual(methods, ["POST", "DELETE"]);
});

test("inference setup directs failed cleanup to the dashboard without secrets", async () => {
  const value = ["synthetic", "orphaned", "credential"].join("-");
  const inferenceStore = {
    read: async () => null,
    write: async () => {
      throw new Error("storage failed");
    },
    clear: async () => undefined,
    withSetupLock: withoutContention,
  };

  await assert.rejects(
    setupInference({
      authStore: createAuthStore(),
      inferenceStore,
      baseUrl: "https://example.test",
      fetchImplementation: async (_input, init) =>
        init.method === "POST"
          ? Response.json(
              {
                value,
                metadata: {
                  object: "api_key",
                  id: "synthetic-key",
                  name: "Understudy CLI",
                  owner: {
                    type: "organization",
                    id: "synthetic-organization",
                  },
                },
              },
              { status: 201 },
            )
          : Response.json({}, { status: 500 }),
    }),
    (error) => {
      assert.match(error.message, /dashboard/i);
      assert.doesNotMatch(error.message, new RegExp(value));
      return true;
    },
  );
});

test("overlapping inference setup calls create one application credential", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "understudy-inference-race-"));
  const inferenceStore = createInferenceCredentialStore({
    directory: path.join(parent, ".understudy"),
  });
  let releasePost;
  let signalPostStarted;
  let firstSetup;
  let postCount = 0;
  const postStarted = new Promise((resolve) => {
    signalPostStarted = resolve;
  });
  const postRelease = new Promise((resolve) => {
    releasePost = resolve;
  });
  const fetchImplementation = async (_input, init) => {
    assert.equal(init.method, "POST");
    postCount += 1;
    signalPostStarted();
    await postRelease;
    return Response.json(
      {
        value: "synthetic-race-credential",
        metadata: {
          object: "api_key",
          id: "synthetic-race-key",
          name: "Understudy CLI",
          owner: { type: "organization", id: "synthetic-organization" },
        },
      },
      { status: 201 },
    );
  };

  try {
    firstSetup = setupInference({
      authStore: createAuthStore(),
      inferenceStore,
      baseUrl: "https://example.test",
      fetchImplementation,
    });
    await postStarted;

    await assert.rejects(
      setupInference({
        authStore: createAuthStore(),
        inferenceStore,
        baseUrl: "https://example.test",
        fetchImplementation,
      }),
      /already running/i,
    );
    assert.equal(postCount, 1);

    releasePost();
    assert.deepEqual(await firstSetup, { status: "created" });
  } finally {
    releasePost();
    await firstSetup?.catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});
