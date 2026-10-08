import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addWorkloadsCommands } from "../dist/commands/workloads.js";

const project = {
  id: "synthetic-project-id",
  slug: "synthetic-project",
  name: "Synthetic Project",
};

const workload = {
  id: "synthetic-workload-id",
  projectId: project.id,
  name: "main",
  captureEnabled: false,
  routeKind: "none",
  routeModelId: null,
  routeTrafficPercent: 0,
  isDefault: true,
  createdAt: "2030-01-01T00:00:00.000Z",
};

function programFor(overrides = {}) {
  const calls = [];
  const output = [];
  const dependencies = {
    list: async (projectSelector) => {
      calls.push({ operation: "list", project: projectSelector });
      return { project, workloads: [workload] };
    },
    create: async (input) => {
      calls.push({ operation: "create", input });
      return {
        project,
        workload: {
          ...workload,
          name: input.name,
          captureEnabled: input.capture,
        },
      };
    },
    show: async (input) => {
      calls.push({ operation: "show", input });
      return { project, workload };
    },
    update: async (input) => {
      calls.push({ operation: "update", input });
      return {
        project,
        workload: {
          ...workload,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.capture === undefined
            ? {}
            : { captureEnabled: input.capture }),
        },
      };
    },
    output: (message) => output.push(message),
    ...overrides,
  };
  const program = new Command().option("--json").exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  addWorkloadsCommands(program, dependencies);
  return { program, calls, output };
}

test("workloads list forwards an exact project selector", async () => {
  const { program, calls, output } = programFor();
  await program.parseAsync([
    "node",
    "understudy",
    "workloads",
    "list",
    "--project",
    project.slug,
  ]);

  assert.deepEqual(calls, [{ operation: "list", project: project.slug }]);
  assert.match(output[0], /Workloads in project synthetic-project/);
  assert.match(output[0], /main \(synthetic-workload-id\) - capture off/);
});

test("workloads create defaults capture off and enables it only with --capture", async () => {
  const withoutCapture = programFor();
  await withoutCapture.program.parseAsync([
    "node",
    "understudy",
    "workloads",
    "create",
    "new-workload",
    "--project",
    project.slug,
  ]);
  assert.deepEqual(withoutCapture.calls[0].input, {
    project: project.slug,
    name: "new-workload",
    capture: false,
  });

  const withCapture = programFor();
  await withCapture.program.parseAsync([
    "node",
    "understudy",
    "workloads",
    "create",
    "captured-workload",
    "--project",
    project.slug,
    "--capture",
  ]);
  assert.equal(withCapture.calls[0].input.capture, true);
});

test("workloads show supports global JSON output", async () => {
  const { program, calls, output } = programFor();
  await program.parseAsync([
    "node",
    "understudy",
    "--json",
    "workloads",
    "show",
    "main",
    "--project",
    project.id,
  ]);

  assert.deepEqual(calls, [
    {
      operation: "show",
      input: { project: project.id, workload: "main" },
    },
  ]);
  assert.deepEqual(JSON.parse(output[0]), { project, workload });
});

test("workloads show reports configured deployment routing", async () => {
  const { program, output } = programFor({
    show: async () => ({
      project,
      workload: {
        ...workload,
        routeKind: "deployment",
        routeTrafficPercent: 35,
      },
    }),
  });

  await program.parseAsync([
    "node",
    "understudy",
    "workloads",
    "show",
    "main",
    "--project",
    project.slug,
  ]);

  assert.match(output[0], /Routing\s+configured deployment at 35%/);
});

test("workloads update accepts a name and capture on or off", async () => {
  const enabled = programFor();
  await enabled.program.parseAsync([
    "node",
    "understudy",
    "workloads",
    "update",
    workload.id,
    "--project",
    project.slug,
    "--name",
    "renamed-workload",
    "--capture",
    "on",
  ]);
  assert.deepEqual(enabled.calls[0].input, {
    project: project.slug,
    workload: workload.id,
    name: "renamed-workload",
    capture: true,
  });

  const disabled = programFor();
  await disabled.program.parseAsync([
    "node",
    "understudy",
    "workloads",
    "update",
    "main",
    "--project",
    project.slug,
    "--capture",
    "off",
  ]);
  assert.equal(disabled.calls[0].input.capture, false);
});

test("workloads update rejects empty changes and invalid capture values", async () => {
  const empty = programFor();
  await assert.rejects(
    empty.program.parseAsync([
      "node",
      "understudy",
      "workloads",
      "update",
      "main",
      "--project",
      project.slug,
    ]),
    /at least one workload change/i,
  );
  assert.deepEqual(empty.calls, []);

  const invalid = programFor();
  await assert.rejects(
    invalid.program.parseAsync([
      "node",
      "understudy",
      "workloads",
      "update",
      "main",
      "--project",
      project.slug,
      "--capture",
      "maybe",
    ]),
    /capture on or --capture off/i,
  );
  assert.deepEqual(invalid.calls, []);
});

test("workload operations defer omitted project selection to saved context", async () => {
  for (const args of [["list"], ["create", "new-workload"], ["show", "main"], ["update", "main", "--name", "renamed-workload"]]) {
    const { program, calls } = programFor();
    await program.parseAsync(["node", "understudy", "workloads", ...args]);
    assert.equal(calls.length, 1);
    assert.equal((calls[0].input ?? calls[0]).project, undefined);
  }
});

test("legacy project-id alias and route flags forward explicit values", async () => {
  const calls = [];
  const h = programFor({ route: async input => { calls.push(input); return { project, workload }; } });
  await h.program.parseAsync(["node", "understudy", "workloads", "route", "main", "--project-id", project.id, "--model-id", "synthetic-model", "--traffic-pct", "25", "--capture", "off"]);
  assert.deepEqual(calls, [{ project: project.id, workload: "main", modelId: "synthetic-model", trafficPercent: 25, clear: undefined, capture: false }]);
  const invalid = programFor();
  await assert.rejects(invalid.program.parseAsync(["node", "understudy", "workloads", "list", "--project", "one", "--project-id", "two"]), /only one project selector/);
});
