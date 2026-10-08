import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addProjectsCommands } from "../dist/commands/projects.js";

function programFor(dependencies) {
  const program = new Command().option("--json");
  addProjectsCommands(program, dependencies);
  return program;
}

test("projects list supports the global JSON contract", async () => {
  const output = [];
  const projects = [
    {
      id: "synthetic-project",
      slug: "example-project",
      name: "Example Project",
    },
  ];
  await programFor({
    list: async () => projects,
    create: async () => {
      throw new Error("must not create");
    },
    output: (message) => output.push(message),
  }).parseAsync(["node", "understudy", "--json", "projects", "list"]);

  assert.deepEqual(JSON.parse(output[0]), { projects });
});

test("projects list prints a compact table", async () => {
  const output = [];
  await programFor({
    list: async () => [
      {
        id: "synthetic-project",
        slug: "example-project",
        name: "Example Project",
      },
    ],
    create: async () => {
      throw new Error("must not create");
    },
    output: (message) => output.push(message),
  }).parseAsync(["node", "understudy", "projects", "list"]);

  assert.match(output[0], /^SLUG\s+NAME\s+ID/m);
  assert.match(output[0], /example-project\s+Example Project\s+synthetic-project/);
});

test("projects create passes the slug and optional name", async () => {
  const output = [];
  const inputs = [];
  await programFor({
    list: async () => [],
    create: async (input) => {
      inputs.push(input);
      return {
        id: "synthetic-project",
        slug: input.slug,
        name: input.name ?? input.slug,
      };
    },
    output: (message) => output.push(message),
  }).parseAsync([
    "node",
    "understudy",
    "projects",
    "create",
    "example-project",
    "--name",
    "Example Project",
  ]);

  assert.deepEqual(inputs, [
    { slug: "example-project", name: "Example Project" },
  ]);
  assert.deepEqual(output, [
    "Created project example-project (synthetic-project).",
  ]);
});

test("projects create supports the global JSON contract", async () => {
  const output = [];
  const project = {
    id: "synthetic-project",
    slug: "example-project",
    name: "example-project",
  };
  await programFor({
    list: async () => [],
    create: async () => project,
    output: (message) => output.push(message),
  }).parseAsync([
    "node",
    "understudy",
    "--json",
    "projects",
    "create",
    "example-project",
  ]);

  assert.deepEqual(JSON.parse(output[0]), project);
});

test("projects create rejects an invalid slug before its dependency", async () => {
  let creates = 0;
  const program = programFor({
    list: async () => [],
    create: async () => {
      creates += 1;
      throw new Error("must not create");
    },
    output: () => undefined,
  });

  await assert.rejects(
    program.parseAsync([
      "node",
      "understudy",
      "projects",
      "create",
      "Invalid Project",
    ]),
    /project slugs/i,
  );
  assert.equal(creates, 0);
});

for (const name of ["switch", "use"]) {
  test(`projects ${name} forwards scope assertion to verified context selection`, async () => {
    const calls = [], output = [];
    const project = { id: "synthetic-project", slug: "synthetic-project", name: "Synthetic Project" };
    await programFor({ switch: async (selector, org) => { calls.push({ selector, org }); return { organizationId: org, project }; },
      output: message => output.push(message) }).parseAsync(["node", "understudy", "--json", "projects", name, project.slug, "--org", "synthetic-organization"]);
    assert.deepEqual(calls, [{ selector: project.slug, org: "synthetic-organization" }]);
    assert.deepEqual(JSON.parse(output[0]).project, project);
  });
}
