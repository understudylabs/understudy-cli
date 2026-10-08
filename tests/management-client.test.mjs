import assert from "node:assert/strict";
import test from "node:test";

import {
  createApplicationCredential,
  revokeApplicationCredential,
} from "../dist/management/client.js";

const accessToken = ["synthetic", "oauth", "token"].join("-");

test("application credentials are created with the OAuth session", async () => {
  let request;
  const value = ["synthetic", "application", "credential"].join("-");

  const credential = await createApplicationCredential({
    accessToken,
    organizationId: "synthetic-organization",
    baseUrl: "https://example.test/",
    fetchImplementation: async (input, init) => {
      request = { input, init };
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

  assert.deepEqual(credential, { keyId: "synthetic-key", value });
  assert.equal(
    request.input,
    "https://example.test/admin/v1/orgs/synthetic-organization/api_keys",
  );
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.authorization, `Bearer ${accessToken}`);
  assert.deepEqual(JSON.parse(request.init.body), { name: "Understudy CLI" });
});

test("application credential creation rejects a foreign owner", async () => {
  const value = ["synthetic", "foreign", "credential"].join("-");

  await assert.rejects(
    createApplicationCredential({
      accessToken,
      organizationId: "synthetic-organization",
      baseUrl: "https://example.test",
      fetchImplementation: async () =>
        Response.json(
          {
            value,
            metadata: {
              object: "api_key",
              id: "synthetic-key",
              name: "Understudy CLI",
              owner: { type: "organization", id: "different-organization" },
            },
          },
          { status: 201 },
        ),
    }),
    (error) => {
      assert.match(error.message, /invalid setup response/i);
      assert.match(error.message, /outcome is unknown/i);
      assert.doesNotMatch(error.message, new RegExp(value));
      return true;
    },
  );
});

test("application credential creation verifies the requested key identity", async () => {
  const value = ["synthetic", "unexpected", "credential"].join("-");
  for (const metadata of [
    {
      object: "unexpected_object",
      id: "synthetic-key",
      name: "Understudy CLI",
      owner: { type: "organization", id: "synthetic-organization" },
    },
    {
      object: "api_key",
      id: "synthetic-key",
      name: "Different name",
      owner: { type: "organization", id: "synthetic-organization" },
    },
  ]) {
    await assert.rejects(
      createApplicationCredential({
        accessToken,
        organizationId: "synthetic-organization",
        baseUrl: "https://example.test",
        fetchImplementation: async () =>
          Response.json({ value, metadata }, { status: 201 }),
      }),
      (error) => {
        assert.match(error.message, /invalid setup response/i);
        assert.match(error.message, /outcome is unknown/i);
        assert.doesNotMatch(error.message, new RegExp(value));
        return true;
      },
    );
  }
});

test("a created application credential can be revoked with OAuth", async () => {
  let request;

  await revokeApplicationCredential({
    accessToken,
    organizationId: "synthetic/organization",
    keyId: "synthetic/key",
    baseUrl: "https://example.test",
    fetchImplementation: async (input, init) => {
      request = { input, init };
      return Response.json({ id: "synthetic/key", revoked: true });
    },
  });

  assert.equal(
    request.input,
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/api_keys/synthetic%2Fkey",
  );
  assert.equal(request.init.method, "DELETE");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.authorization, `Bearer ${accessToken}`);
});

test("a 5xx create response reports an ambiguous outcome without secrets", async () => {
  const privateMessage = "response data must stay private";

  await assert.rejects(
    createApplicationCredential({
      accessToken,
      organizationId: "synthetic-organization",
      baseUrl: "https://example.test",
      fetchImplementation: async () =>
        Response.json({ message: privateMessage }, { status: 500 }),
    }),
    (error) => {
      assert.match(error.message, /outcome is unknown/i);
      assert.match(error.message, /dashboard before retrying/i);
      assert.doesNotMatch(error.message, new RegExp(privateMessage));
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      return true;
    },
  );
});

test("a lost create response reports an ambiguous outcome", async () => {
  const privateMessage = "transport details must stay private";

  await assert.rejects(
    createApplicationCredential({
      accessToken,
      organizationId: "synthetic-organization",
      baseUrl: "https://example.test",
      fetchImplementation: async () => {
        throw new Error(privateMessage);
      },
    }),
    (error) => {
      assert.match(error.message, /outcome is unknown/i);
      assert.match(error.message, /dashboard before retrying/i);
      assert.doesNotMatch(error.message, new RegExp(privateMessage));
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      return true;
    },
  );
});

test("a malformed create response reports an ambiguous outcome", async () => {
  const privateMessage = "malformed response data must stay private";

  await assert.rejects(
    createApplicationCredential({
      accessToken,
      organizationId: "synthetic-organization",
      baseUrl: "https://example.test",
      fetchImplementation: async () =>
        Response.json({ value: privateMessage, metadata: {} }, { status: 201 }),
    }),
    (error) => {
      assert.match(error.message, /outcome is unknown/i);
      assert.match(error.message, /dashboard before retrying/i);
      assert.doesNotMatch(error.message, new RegExp(privateMessage));
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      return true;
    },
  );
});

test("credential cleanup rejects a mismatched credential id", async () => {
  await assert.rejects(
    revokeApplicationCredential({
      accessToken,
      organizationId: "synthetic-organization",
      keyId: "expected-key",
      baseUrl: "https://example.test",
      fetchImplementation: async () =>
        Response.json({ id: "different-key", revoked: true }),
    }),
    (error) => {
      assert.match(error.message, /invalid cleanup response/i);
      assert.match(error.message, /dashboard before retrying/i);
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      return true;
    },
  );
});
