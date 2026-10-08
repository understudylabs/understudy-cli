import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { createReportReads, billingRange } from "../dist/report/reads.js";
import { addReportCommands } from "../dist/commands/report.js";
import { addReportReadCommands } from "../dist/commands/report-reads.js";
import { addBillingCommands } from "../dist/commands/billing.js";

const org = "synthetic-report-org";
const project = { id: "synthetic-report-project", org_id: org, slug: "synthetic-app", name: "Synthetic app" };
const workload = { id: "synthetic-report-workload", project_id: project.id, name: "synthetic-workload" };
const now = new Date("2024-03-02T00:00:00.000Z");
const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Date.now() / 1000 + 3600 })).toString("base64url");
const authStore = { read: async () => ({ version: 1, method: "oauth", accessToken: `synthetic.${claims}.synthetic` }) };
const group = { workload_id: workload.id, workload: workload.name, model: "synthetic-model", day: "2024-03-01", requests: 2,
  input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 2, cache_creation_input_tokens: 0,
  cache_read_pct: 0.5, customer_cost_usd: 0.01, error_rate: 0.5 };
function usage(url, overrides = {}) {
  return { project_id: project.id, window: url.searchParams.get("window"), window_start: "2024-03-01T18:00:00.000Z", window_end: now.toISOString(),
    group_by: url.searchParams.get("group_by").split(","), groups: [group], generated_at: now.toISOString(), ...overrides };
}
function harness(reply, saved = null) {
  const calls = [];
  const reads = createReportReads({ authStore, contextStore: { read: async () => saved }, now: () => now,
    baseUrl: "https://example.test", fetchImplementation: async (input, init) => {
      const url = new URL(input); calls.push({ url, init });
      if (url.pathname.endsWith("/projects")) return Response.json({ projects: [project] });
      if (url.pathname.endsWith("/workloads")) return Response.json({ workloads: [workload] });
      return Response.json(reply(url));
    } });
  return { reads, calls };
}
function programFor(reads, output) {
  const program = new Command().option("--json").exitOverride();
  addReportCommands(program, { query: (...args) => reads.query(...args), output: value => output.push(value) });
  addReportReadCommands(program, reads, value => output.push(value));
  addBillingCommands(program, reads, value => output.push(value));
  return program;
}

function projectStatus(url, requests = 0) {
  const range = { project_id: project.id, window: url.searchParams.get("window"),
    window_start: "2024-03-01T18:00:00.000Z", window_end: now.toISOString(), generated_at: now.toISOString() };
  if (url.pathname.endsWith("/provider-health")) {
    return { ...range, total_requests: requests, total_errors: 0, providers: [] };
  }
  return { ...range, workload_count: 1, workloads: [{ workload_id: workload.id, display_name: workload.name,
    status: requests ? "healthy" : "idle", requests,
    recent: { window_minutes: 60, requests: 0, errors: 0, error_rate: 0, status: "idle" },
    mode: requests ? "managed" : null, declared: { routed: "none", split_pct: 0 },
    route_shares: { primary: requests ? 1 : 0, understudy: 0, fallback: 0 }, error_rate: 0,
    last_error_at: null, example_request_ids: [], served_models: [], rerouted_pct: 0 }] };
}

const projectStatusCommands = [["report", "workload-status"], ["report", "providers"]];

test("report is the sole reporting command group", () => {
  const program = programFor({}, []);
  assert.equal(program.commands.some(command => command.name() === "reporting"), false);
  const report = program.commands.find(command => command.name() === "report");
  for (const name of ["summary", "usage", "usage-summary", "workload-status", "providers", "cost", "cost-breakdown"]) {
    assert.ok(report.commands.some(command => command.name() === name));
  }
});

test("project status help states the production environment default", () => {
  for (const [group, name] of projectStatusCommands) {
    const command = programFor({}, []).commands.find(command => command.name() === group)
      .commands.find(command => command.name() === name);
    assert.match(command.helpInformation(), /Request environment, or all \(default:\s+production\)/);
  }
});

test("empty production status shows its environment and an explicit test selection hint", async () => {
  for (const command of projectStatusCommands) {
    const { reads, calls } = harness(url => projectStatus(url));
    const output = [];
    await programFor(reads, output).parseAsync(["node", "understudy", ...command, "--project", project.slug, "--window", "6h"]);
    assert.equal(calls.at(-1).url.searchParams.get("request_environment"), "production");
    assert.equal(calls.at(-1).url.searchParams.get("window"), "6h");
    assert.match(output[0], /Request environment production/);
    assert.match(output[0], /No production requests in this selection/);
    assert.match(output[0], /--environment test or --environment all/);
  }
});

test("explicit nonproduction selections are visible without a production hint", async () => {
  for (const command of projectStatusCommands) {
    for (const environment of ["test", "all", "staging"]) {
      const { reads, calls } = harness(url => projectStatus(url));
      const output = [];
      await programFor(reads, output).parseAsync(["node", "understudy", ...command, "--project", project.slug,
        "--environment", environment]);
      assert.equal(calls.at(-1).url.searchParams.get("request_environment"), environment);
      assert.match(output[0], new RegExp(`Request environment ${environment}`));
      assert.doesNotMatch(output[0], /No production requests|--environment test/);
    }
  }
});

test("full-window traffic suppresses the empty hint even when recent status is idle", async () => {
  for (const command of projectStatusCommands) {
    const { reads } = harness(url => projectStatus(url, 2));
    const output = [];
    await programFor(reads, output).parseAsync(["node", "understudy", ...command, "--project", project.slug, "--window", "6h"]);
    assert.match(output[0], /Request environment production/);
    assert.doesNotMatch(output[0], /No production requests|--environment test/);
  }
});

test("status JSON retains its scoped shape without human guidance", async () => {
  for (const command of projectStatusCommands) {
    const { reads, calls } = harness(url => projectStatus(url));
    const output = [];
    await programFor(reads, output).parseAsync(["node", "understudy", "--json", ...command, "--project", project.slug, "--window", "6h"]);
    const data = projectStatus(calls.at(-1).url);
    assert.deepEqual(JSON.parse(output[0]), {
      organizationId: org, projectId: project.id,
      request: { window: "6h", request_environment: "production" }, data,
    });
    assert.doesNotMatch(output[0], /Request environment|No production requests|--environment test/);
  }
});

test("project usage preserves combined dimensions, cache and error rates, and exact selection", async () => {
  const { reads, calls } = harness(url => usage(url, { synthetic_internal: true, groups: [{ ...group, synthetic_internal: true }] }));
  const result = await reads.projectUsage({ projectId: ` ${project.id} `, window: " 6H ", groupBy: "workload, model, day", environment: "test" });
  assert.equal(calls.length, 2);
  const request = calls.at(-1);
  assert.equal(request.url.pathname, `/admin/v1/orgs/${org}/projects/${project.id}/usage-summary`);
  assert.equal(request.url.searchParams.get("window"), "6h");
  assert.equal(request.url.searchParams.get("group_by"), "workload,model,day");
  assert.equal(request.url.searchParams.get("request_environment"), "test");
  assert.equal(request.init.redirect, "error");
  assert.equal(result.data.groups[0].cache_read_pct, 0.5);
  assert.equal(result.data.groups[0].error_rate, 0.5);
  assert.equal(result.pricingCoverage, "unavailable");
  assert.equal(JSON.stringify(result).includes("synthetic_internal"), false);
});

test("project usage rejects unsupported selections before requesting data", async () => {
  for (const input of [{ window: "31d" }, { window: "0h" }, { groupBy: "workload,workload" }, { groupBy: "project" },
    { groupBy: "" }, { workloadId: workload.id }, { from: "2024-03-01" }, { granularity: "day" }]) {
    const { reads, calls } = harness(() => { throw new Error("Unexpected synthetic request"); });
    await assert.rejects(reads.projectUsage({ projectId: project.id, ...input }));
    assert.equal(calls.length, 0);
  }
});

test("project usage refuses foreign scope, changed grouping and possible server truncation", async () => {
  for (const overrides of [{ project_id: "synthetic-other-project" }, { window: "7d" }, { group_by: ["day"] },
    { groups: Array.from({ length: 5000 }, () => group) }]) {
    const { reads } = harness(url => usage(url, overrides));
    await assert.rejects(reads.projectUsage({ projectId: project.id, window: "6h", groupBy: "workload,model,day" }), /wrong project|different selection|5,000-group/);
  }
  const { reads, calls } = harness(() => { throw new Error("Unexpected synthetic report"); });
  await assert.rejects(reads.projectUsage({ projectId: "synthetic-other-project" }), /not found.*authenticated organization/);
  assert.equal(calls.length, 1);
});

test("report usage-summary preserves its scoped JSON and duration grouping", async () => {
  const { reads, calls } = harness(url => usage(url));
  const output = [];
  await programFor(reads, output).parseAsync(["node", "understudy", "--json", "report", "usage-summary", "--project-id", project.id,
    "--window", "6h", "--group-by", "workload,model,day", "--org", org]);
  const result = JSON.parse(output[0]);
  assert.equal(result.projectId, project.id);
  assert.equal(result.data.groups[0].error_rate, 0.5);
  assert.equal(result.organizationId, org);
  assert.equal(calls.at(-1).url.searchParams.get("window"), "6h");
});

test("report usage-summary uses the scoped wrapper and default seven-day window", async () => {
  const { reads, calls } = harness(url => usage(url));
  const output = [];
  await programFor(reads, output).parseAsync(["node", "understudy", "--json", "report", "usage-summary", "--project", project.slug]);
  assert.equal(JSON.parse(output[0]).projectId, project.id);
  assert.equal(JSON.parse(output[0]).data.window, "7d");
  assert.equal(calls.at(-1).url.searchParams.get("group_by"), "workload");
});

test("report summary remains organization-wide with seven-day project grouping", async () => {
  const calls = [], output = [];
  const reads = { query: async (kind, input) => { calls.push({ kind, input }); return { organizationId: org, request: {}, data: { org_id: org } }; } };
  await programFor(reads, output).parseAsync(["node", "understudy", "--json", "report", "summary", "--org", org]);
  assert.deepEqual(calls[0], { kind: "usage", input: { org, window: "7d", groupBy: "project", useDefaults: false } });
  assert.deepEqual(JSON.parse(output[0]), { organizationId: org, request: {}, data: { org_id: org } });
  const custom = [], customReads = { query: async (kind, input) => { custom.push(input); return { organizationId: org, request: {}, data: {} }; } };
  await programFor(customReads, []).parseAsync(["node", "understudy", "report", "summary", "--from", "2024-03-01", "--to", "2024-03-01"]);
  assert.equal(custom[0].window, undefined);
});

test("identifier aliases reject conflicts and cannot choose another organization", async () => {
  const { reads, calls } = harness(() => { throw new Error("Unexpected synthetic report"); });
  await assert.rejects(reads.query("usage", { project: project.slug, projectId: "synthetic-other-project" }), /conflicting/);
  await assert.rejects(reads.query("usage", { workload: workload.name, workloadId: "synthetic-other-workload" }), /conflicting/);
  await assert.rejects(reads.projectUsage({ projectId: project.id, org: "synthetic-other-org" }), /authenticated organization/);
  await assert.rejects(reads.billing("balance", { org: "synthetic-other-org" }), /authenticated organization/);
  assert.equal(calls.length, 0);
});

test("billing supports numeric offsets, optional seconds and fractional precision", () => {
  const range = billingRange({ from: "2024-03-01T03:30+03:30", to: "2024-03-01T01:00:00.123456789-02:00" }, now);
  assert.equal(range.get("from"), "2024-03-01T00:00:00.000Z");
  assert.equal(range.get("to"), "2024-03-01T03:00:00.123Z");
  for (const from of ["2023-02-29T00:00Z", "2024-02-30T00:00Z", "2024-03-01T24:00Z", "2024-03-01T00:60Z", "2024-03-01T00:00:60Z", "2024-03-01T00:00+24:00", "2024-03-01T00:00+01:60", "2024-03-01T00:00"]) {
    assert.throws(() => billingRange({ from, to: now.toISOString() }, now), /timestamp/);
  }
  const long = billingRange({ from: "2020-01-01T00:00Z", to: "2024-01-01T00:00Z" }, now);
  assert.equal(long.get("from"), "2020-01-01T00:00:00.000Z");
});

test("billing command keeps offset bounds and the organization assertion", async () => {
  const calls = [], output = [];
  const reads = { billing: async (kind, input) => { calls.push({ kind, input }); return { organizationId: org, request: {}, data: { summary: {} } }; } };
  await programFor(reads, output).parseAsync(["node", "understudy", "--json", "billing", "summary", "--org", org,
    "--from", "2024-03-01T03:30+03:30", "--to", "2024-03-02T00:00Z"]);
  assert.equal(calls[0].input.org, org);
  assert.equal(calls[0].input.from, "2024-03-01T03:30+03:30");
  assert.equal(calls[0].input.window, undefined);
});
