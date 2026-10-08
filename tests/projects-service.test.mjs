import assert from "node:assert/strict";
import test from "node:test";

import { createProjectsService } from "../dist/projects/service.js";

function tokenFor(organizationId) {
  const claims = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      org_id: organizationId,
    }),
  ).toString("base64url");
  return `synthetic.${claims}.signature`;
}

function store(value, onRead = () => undefined) {
  return {
    read: async () => {
      onRead();
      return value;
    },
    write: async () => undefined,
    clear: async () => undefined,
  };
}

test("the projects service uses the current OAuth organization", async () => {
  const accessToken = tokenFor("synthetic-organization");
  let request;
  const service = createProjectsService({
    authStore: store({ version: 1, method: "oauth", accessToken }),
    baseUrl: "https://example.test",
    fetchImplementation: async (input, init) => {
      request = { input: String(input), init };
      return Response.json({ projects: [], cursor: null });
    },
  });

  assert.deepEqual(await service.list(), []);
  assert.equal(
    request.input,
    "https://example.test/admin/v1/orgs/synthetic-organization/projects",
  );
  assert.equal(request.init.headers.authorization, `Bearer ${accessToken}`);
});

test("the projects service validates a slug before reading OAuth state", async () => {
  let reads = 0;
  const service = createProjectsService({
    authStore: store(null, () => {
      reads += 1;
    }),
    fetchImplementation: async () => {
      throw new Error("must not request");
    },
  });

  await assert.rejects(
    service.create({ slug: "Invalid Project" }),
    /project slugs/i,
  );
  assert.equal(reads, 0);
});
