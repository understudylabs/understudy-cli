import assert from "node:assert/strict";
import test from "node:test";

import {
  createManagementProject,
  listManagementProjects,
} from "../dist/management/projects.js";

const accessToken = ["synthetic", "oauth", "access"].join("-");

function options(fetchImplementation) {
  return {
    accessToken,
    organizationId: "synthetic/organization",
    baseUrl: "https://example.test/",
    fetchImplementation,
  };
}

test("project listing paginates and normalizes public fields", async () => {
  const requests = [];
  const projects = await listManagementProjects(
    options(async (input, init) => {
      requests.push({ input: String(input), init });
      return requests.length === 1
        ? Response.json({
            projects: [
              {
                id: "synthetic-project-one",
                org_id: "synthetic/organization",
                slug: "first-project",
                name: "First Project",
                ignored_field: "not part of the CLI contract",
              },
            ],
            cursor: "next/page",
          })
        : Response.json({
            projects: [
              {
                id: "synthetic-project-two",
                org_id: "synthetic/organization",
                slug: "second-project",
                name: "second-project",
              },
            ],
            cursor: null,
          });
    }),
  );

  assert.deepEqual(projects, [
    {
      id: "synthetic-project-one",
      slug: "first-project",
      name: "First Project",
    },
    {
      id: "synthetic-project-two",
      slug: "second-project",
      name: "second-project",
    },
  ]);
  assert.deepEqual(
    requests.map((request) => request.input),
    [
      "https://example.test/admin/v1/orgs/synthetic%2Forganization/projects",
      "https://example.test/admin/v1/orgs/synthetic%2Forganization/projects?cursor=next%2Fpage",
    ],
  );
  assert.ok(
    requests.every(
      (request) =>
        request.init.headers.authorization === `Bearer ${accessToken}`,
    ),
  );
});

test("project creation sends the exact normalized request", async () => {
  let request;
  const project = await createManagementProject(
    options(async (input, init) => {
      request = { input: String(input), init };
      return Response.json(
        {
          id: "synthetic-project",
          org_id: "synthetic/organization",
          slug: "new-project",
          name: "New Project",
          internal_field: "ignored",
        },
        { status: 201 },
      );
    }),
    { slug: "new-project", name: "New Project" },
  );

  assert.deepEqual(project, {
    id: "synthetic-project",
    slug: "new-project",
    name: "New Project",
  });
  assert.equal(
    request.input,
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/projects",
  );
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), {
    slug: "new-project",
    name: "New Project",
  });
});

test("project creation defaults the display name to the slug", async () => {
  let body;
  await createManagementProject(
    options(async (_input, init) => {
      body = JSON.parse(init.body);
      return Response.json({
        id: "synthetic-project",
        org_id: "synthetic/organization",
        slug: "default-name",
        name: "default-name",
      });
    }),
    { slug: "default-name" },
  );

  assert.deepEqual(body, { slug: "default-name", name: "default-name" });
});

test("project listing rejects a project from another organization", async () => {
  await assert.rejects(
    listManagementProjects(
      options(async () =>
        Response.json({
          projects: [
            {
              id: "synthetic-project",
              org_id: "different-organization",
              slug: "foreign-project",
              name: "Foreign Project",
            },
          ],
          cursor: null,
        }),
      ),
    ),
    /invalid project list/i,
  );
});

test("project creation rejects a project from another organization", async () => {
  await assert.rejects(
    createManagementProject(
      options(async () =>
        Response.json(
          {
            id: "synthetic-project",
            org_id: "different-organization",
            slug: "foreign-project",
            name: "Foreign Project",
          },
          { status: 201 },
        ),
      ),
      { slug: "foreign-project", name: "Foreign Project" },
    ),
    /invalid project creation response.*outcome is unknown/i,
  );
});

test("project creation rejects a response for a different slug", async () => {
  await assert.rejects(
    createManagementProject(
      options(async () =>
        Response.json(
          {
            id: "synthetic-project",
            org_id: "synthetic/organization",
            slug: "different-project",
            name: "Different Project",
          },
          { status: 201 },
        ),
      ),
      { slug: "requested-project", name: "Requested Project" },
    ),
    (error) => {
      assert.match(error.message, /invalid project creation response/i);
      assert.match(error.message, /outcome is unknown/i);
      assert.match(error.message, /projects list/i);
      return true;
    },
  );
});

test("project creation rejects a response with a different name", async () => {
  await assert.rejects(
    createManagementProject(
      options(async () =>
        Response.json(
          {
            id: "synthetic-project",
            org_id: "synthetic/organization",
            slug: "requested-project",
            name: "Different Project",
          },
          { status: 201 },
        ),
      ),
      { slug: "requested-project", name: "Requested Project" },
    ),
    (error) => {
      assert.match(error.message, /invalid project creation response/i);
      assert.match(error.message, /outcome is unknown/i);
      assert.match(error.message, /projects list/i);
      return true;
    },
  );
});

test("invalid project slugs fail before any request", async () => {
  let requests = 0;

  await assert.rejects(
    createManagementProject(
      options(async () => {
        requests += 1;
        throw new Error("must not request");
      }),
      { slug: "Invalid Project" },
    ),
    /project slugs/i,
  );
  assert.equal(requests, 0);
});

test("invalid project names fail before any request", async () => {
  let requests = 0;

  await assert.rejects(
    createManagementProject(
      options(async () => {
        requests += 1;
        throw new Error("must not request");
      }),
      { slug: "valid-project", name: "" },
    ),
    /project names/i,
  );
  assert.equal(requests, 0);
});

test("an uncertain project creation never exposes response details", async () => {
  const privateDetail = "private response detail";

  await assert.rejects(
    createManagementProject(
      options(async () =>
        Response.json({ message: privateDetail }, { status: 500 }),
      ),
      { slug: "uncertain-project" },
    ),
    (error) => {
      assert.match(error.message, /may have succeeded/i);
      assert.match(error.message, /projects list/i);
      assert.doesNotMatch(error.message, new RegExp(privateDetail));
      assert.doesNotMatch(error.message, new RegExp(accessToken));
      return true;
    },
  );
});
