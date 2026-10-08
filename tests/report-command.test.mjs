import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addReportCommands } from "../dist/commands/report.js";

const coverage = {
  sourceTimestamp: "2026-08-01T12:00:00.000Z",
  dataCompleteness: 0.9,
  knownGaps: ["synthetic coverage gap"],
};

const usageTotals = {
  requests: 10,
  inputTokens: 100,
  cacheReadInputTokens: 25,
  cacheCreationInputTokens: 5,
  outputTokens: 20,
  totalTokens: 120,
};

const errorTotals = {
  requests: 10,
  errors: 2,
  errorRate: 0.2,
  bySource: { upstream: 1, network: 1, edge: 0, unclassified: 0 },
  byStatus: [{ statusCode: 503, count: 2 }],
};

const summary = {
  organizationId: "synthetic-organization",
  window: "24h",
  health: {
    state: "degraded",
    windowMinutes: 10,
    requests: 20,
    errors: 2,
    errorRate: 0.1,
    activeWorkloads: 1,
    idleWorkloads: 2,
    coverage,
  },
  usage: usageTotals,
  errors: { ...errorTotals, coverage },
  costs: {
    recordedCustomerCostUsd: 1.5,
    pricingCoverage: "unavailable",
  },
};

const health = {
  organizationId: "synthetic-organization",
  recent: {
    state: "degraded",
    windowMinutes: 10,
    windowStart: "2026-08-01T11:50:00.000Z",
    windowEnd: "2026-08-01T12:00:00.000Z",
    requests: 20,
    errors: 2,
    errorRate: 0.1,
  },
  baseline: {
    state: "observing",
    windowMinutes: 60,
    windowStart: "2026-08-01T11:00:00.000Z",
    windowEnd: "2026-08-01T12:00:00.000Z",
    requests: 100,
    errors: 3,
    errorRate: 0.03,
  },
  workloads: [],
  activeWorkloads: 1,
  idleWorkloads: 2,
  rosterAvailable: true,
  workloadsTruncated: false,
  coverage,
  generatedAt: "2026-08-01T12:00:01.000Z",
};

const usage = {
  organizationId: "synthetic-organization",
  window: "24h",
  windowStart: "2026-07-31T12:00:00.000Z",
  windowEnd: "2026-08-01T12:00:00.000Z",
  totals: usageTotals,
  workloads: [],
  generatedAt: "2026-08-01T12:00:02.000Z",
};

const errors = {
  organizationId: "synthetic-organization",
  window: "24h",
  windowStart: "2026-07-31T12:00:00.000Z",
  windowEnd: "2026-08-01T12:00:00.000Z",
  totals: errorTotals,
  workloads: [],
  coverage,
  generatedAt: "2026-08-01T12:00:03.000Z",
};

const costs = {
  organizationId: "synthetic-organization",
  window: "24h",
  windowStart: "2026-07-31T12:00:00.000Z",
  windowEnd: "2026-08-01T12:00:00.000Z",
  recordedCustomerCostUsd: 1.5,
  pricingCoverage: "unavailable",
  workloads: [],
  generatedAt: "2026-08-01T12:00:02.000Z",
};

function harness({ healthResult = health } = {}) {
  const calls = [];
  const output = [];
  const dependencies = {
    summary: async (window) => {
      calls.push(["summary", window]);
      return { ...summary, window };
    },
    health: async () => {
      calls.push(["health"]);
      return healthResult;
    },
    usage: async (window) => {
      calls.push(["usage", window]);
      return { ...usage, window };
    },
    errors: async (window) => {
      calls.push(["errors", window]);
      return { ...errors, window };
    },
    costs: async (window) => {
      calls.push(["costs", window]);
      return { ...costs, window };
    },
    output: (message) => output.push(message),
  };
  const program = new Command().option("--json");
  addReportCommands(program, dependencies);
  return { program, calls, output };
}

test("bare report defaults to 24h and prints all four headline signals", async () => {
  const result = harness();
  await result.program.parseAsync(["node", "understudy", "report"]);

  assert.deepEqual(result.calls, [["summary", "24h"]]);
  assert.match(result.output[0], /Health\s+degraded/);
  assert.match(result.output[0], /Requests\s+10/);
  assert.match(result.output[0], /Errors\s+2/);
  assert.match(result.output[0], /Recorded customer cost\s+\$1\.50/);
  assert.match(result.output[0], /Cost coverage\s+not reported by the platform/);
  assert.doesNotMatch(result.output[0], /provider cost/i);
});

test("bare report supports a selected window and global JSON", async () => {
  const result = harness();
  await result.program.parseAsync([
    "node",
    "understudy",
    "--json",
    "report",
    "--window",
    "7d",
  ]);

  assert.deepEqual(result.calls, [["summary", "7d"]]);
  assert.deepEqual(JSON.parse(result.output[0]), { ...summary, window: "7d" });
});

test("report subcommands return their focused JSON contracts", async () => {
  for (const [name, value, expectedCall] of [
    ["health", health, ["health"]],
    ["usage", usage, ["usage", "24h"]],
    ["errors", errors, ["errors", "24h"]],
    ["costs", costs, ["costs", "24h"]],
  ]) {
    const result = harness();
    await result.program.parseAsync([
      "node",
      "understudy",
      "--json",
      "report",
      name,
    ]);
    assert.deepEqual(result.calls, [expectedCall]);
    assert.deepEqual(JSON.parse(result.output[0]), value);
  }
});

test("report health warns when workload rows are truncated", async () => {
  const result = harness({
    healthResult: { ...health, workloadsTruncated: true },
  });

  await result.program.parseAsync([
    "node",
    "understudy",
    "report",
    "health",
  ]);

  assert.match(result.output[0], /Workload rows\s+truncated by Understudy/);
});

test("report subcommands honor an explicitly selected window", async () => {
  const afterSubcommand = harness();
  await afterSubcommand.program.parseAsync([
    "node",
    "understudy",
    "report",
    "usage",
    "--window",
    "7d",
  ]);
  assert.deepEqual(afterSubcommand.calls, [["usage", "7d"]]);

  const beforeSubcommand = harness();
  await beforeSubcommand.program.parseAsync([
    "node",
    "understudy",
    "report",
    "--window",
    "30d",
    "usage",
  ]);
  assert.deepEqual(beforeSubcommand.calls, [["usage", "30d"]]);
});

test("report health rejects a parent window instead of ignoring it", async () => {
  const result = harness();
  await assert.rejects(
    result.program.parseAsync([
      "node",
      "understudy",
      "report",
      "--window",
      "7d",
      "health",
    ]),
    /current snapshot.*does not support --window/i,
  );

  assert.deepEqual(result.calls, []);
});

test("report commands reject unsupported windows before their dependency", async () => {
  const result = harness();
  await assert.rejects(
    result.program.parseAsync([
      "node",
      "understudy",
      "report",
      "usage",
      "--window",
      "1h",
    ]),
    /24h, 7d, or 30d/,
  );
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.output, []);
});
