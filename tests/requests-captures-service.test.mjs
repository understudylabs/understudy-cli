import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequestsService } from "../dist/requests/service.js";
import { createCapturesService } from "../dist/captures/service.js";
import { createMigrationService } from "../dist/migrations/service.js";
import { requestFilters } from "../dist/requests/filters.js";

const org = "synthetic-org", project = "synthetic-project", workload = "synthetic-workload";
const id1 = "00000000-0000-7000-8000-000000000001", id2 = "00000000-0000-7000-8000-000000000002";
const trace = "11111111111111111111111111111111";
const start = "2020-01-01T00:00:00.000Z", end = "2020-01-01T01:00:00.000Z";
const coverage = { source_timestamp: end, data_completeness: 1, known_gaps: ["Synthetic capture retention is unverified."] };
const contextStore = { read: async () => null };
function store() {
  const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Date.now() / 1000 + 3600 })).toString("base64url");
  return { read: async () => ({ version: 1, method: "oauth", accessToken: `synthetic.${claims}.synthetic` }), write: async () => {}, clear: async () => {} };
}
function row(id = id1, overrides = {}) { return { request_id: id, project_id: project, workload_id: workload, trace_id: trace, request_environment: "test", ts: start, project: "Synthetic project", workload: "Synthetic workload", caller_span_id: null, trace_context_status: "valid", endpoint: "/v1/messages", is_streaming: false, provider: "managed", requested_model: "synthetic-model", served_model: "synthetic-model", route_taken: "primary", status_code: 200, outcome: "success", error_source: null, error_reason: "unknown", error_reason_covered: true, error_retryable: null, fallback_used: false, tokens: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0 }, total_ms: 1, upstream_ttfb_ms: 1, capture_state: "expected", retry_count: 0, retry_wait_ms: 0, ...overrides }; }
function feed(url, calls = [], next = null, overrides = {}) {
  const filters = Object.fromEntries(["request_environment", "project_id", "workload_id", "outcome", "status_code", "error_reason", "provider", "requested_model", "served_model", "route", "capture_state"].map(key => [key, (key === "status_code" && url.searchParams.has(key) ? Number(url.searchParams.get(key)) : url.searchParams.get(key))]));
  return { org_id: org, window: url.searchParams.get("window") ?? "1h", window_start: start, window_end: end, snapshot_watermark: end, filters, calls, next_cursor: next, coverage, generated_at: end, ...overrides };
}
function capture(id = id1, overrides = {}) { return { schema_version: 4, mode: "managed", provider: "managed", request_id: id, workos_org_id: org, project_id: project, workload_id: workload, request_environment: "test", ts: start, customer_request_body: '{"synthetic":"request"}', response_body: '{"synthetic":"response"}', trace_id: trace, ...overrides }; }
async function setup(t, handler) {
  const cwd = await mkdtemp(path.join(tmpdir(), "synthetic-capture-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const calls = [];
  const options = { cwd, store: store(), contextStore, baseUrl: "https://example.test", fetchImplementation: async (value, init) => {
    const url = new URL(value); calls.push({ url, init });
    if (url.pathname.endsWith("/projects")) return Response.json({ projects: [{ id: project, org_id: org, slug: project, name: "Synthetic project" }, { id: "synthetic-other-project", org_id: org, slug: "synthetic-other-project", name: "Other synthetic project" }], cursor: null });
    if (url.pathname.endsWith("/workloads")) return Response.json({ workloads: [{ id: workload, project_id: project, name: workload, capture_enabled: true }], cursor: null });
    return handler(url, init);
  } };
  return { cwd, options, calls, requests: createRequestsService(options), captures: createCapturesService(options) };
}

test("organization keys can read captures in their authenticated organization", async t => {
  const ctx = await setup(t, url => url.pathname.endsWith("/snapshot") ? Response.json({ org_id: org }) : Response.json({ capture: capture() }));
  const options = { ...ctx.options, store: {
    read: async () => ({ version: 1, method: "organization_key", apiKey: ["synthetic", "organization", "key"].join("-"), organizationId: org, keyId: "synthetic-key", serviceUrl: "https://example.test" }),
    write: async () => {}, clear: async () => {},
  } };
  const captures = createCapturesService(options);
  const result = await captures.get(id1, { project, workload });
  assert.equal(result.capture.request_id, id1);
  assert.equal(result.capture.customer_request_body, true);
  await assert.rejects(() => captures.get(id1, { org: "synthetic-foreign", project }), /organization/);
});

test("request filters preserve all supported selectors and require a complete exact-duration timeline", () => {
  const query = requestFilters({ environment: "test", window: "1h", outcome: "error", statusCode: 429, errorReason: "rate_limited", provider: "managed", requestedModel: "synthetic/request", servedModel: "synthetic/served", route: "synthetic-route", captureState: "expected", windowStart: start, windowEnd: end, snapshotWatermark: end, includeRejectionDetails: true, limit: "100" });
  assert.equal(query.get("requested_model"), "synthetic/request"); assert.equal(query.get("include_rejection_details"), "true"); assert.equal(query.get("capture_state"), "expected");
  assert.throws(() => requestFilters({ windowStart: start }), /together/);
  assert.throws(() => requestFilters({ window: "6h", windowStart: start, windowEnd: end, snapshotWatermark: end }), /duration/);
  assert.throws(() => requestFilters({ provider: "synthetic-supplier" }), /managed only/);
  assert.throws(() => requestFilters({ limit: "1.5" }), /integer/);
  assert.throws(() => requestFilters({ environment: "test\n" }), /Environment/);
});

test("request traversal continues empty pages and pins scope, filters, and snapshot", async t => {
  const ctx = await setup(t, url => {
    const cursor = url.searchParams.get("cursor");
    if (!cursor) return Response.json(feed(url, [], "synthetic-first"));
    assert.equal(url.searchParams.get("window_start"), start); assert.equal(url.searchParams.get("snapshot_watermark"), end);
    return Response.json(feed(url, [row()], null));
  });
  const result = await ctx.requests.list({ project, workload, environment: "test", outcome: "success", all: true });
  assert.equal(result.calls.length, 1); assert.equal(result.traversal.pages, 2); assert.equal(result.traversal.complete, true);
  assert.equal(result.scope.organizationId, org); assert.equal(result.pageCoverage.length, 2);
});

test("request traversal refuses scope drift, repeated cursors, and repeated requests", async t => {
  for (const mode of ["scope", "snapshot", "cursor", "duplicate"]) {
    const ctx = await setup(t, url => {
      const cursor = url.searchParams.get("cursor");
      if (!cursor) return Response.json(feed(url, [row()], "synthetic-next"));
      if (mode === "scope") return Response.json(feed(url, [row(id2, { workload_id: "synthetic-foreign" })]));
      if (mode === "snapshot") return Response.json(feed(url, [row(id2)], null, { snapshot_watermark: start }));
      if (mode === "cursor") return Response.json(feed(url, [], "synthetic-next"));
      return Response.json(feed(url, [row()]));
    });
    await assert.rejects(() => ctx.requests.list({ project, workload, all: true }), /scope|snapshot|cursor|repeated/);
  }
});

test("failure context is a window aggregate and rejects pagination before remote access", async t => {
  const ctx = await setup(t, url => {
    assert.ok(url.pathname.endsWith("/failure-context")); assert.equal(url.searchParams.get("workload_id"), workload);
    return Response.json({ org_id: org, window_start: start, window_end: end, snapshot_watermark: end, requests: 2, errors: 1, error_rate: 0.5, state: "degraded", coverage, generated_at: end, dominant_error_reason: null, ...Object.fromEntries(["reasons", "workloads", "providers", "models"].map(key => [key, { groups: [], other_count: 0, total_distinct: 0 }])) });
  });
  await assert.rejects(() => ctx.requests.failureContext({ limit: 10 }), /omit pagination/); assert.equal(ctx.calls.length, 0);
  const result = await ctx.requests.failureContext({ project, workload, environment: "test" }); assert.equal(result.requests, 2);
  await assert.rejects(() => ctx.requests.failureContext({ org: "synthetic-foreign" }), /organization/);
});

test("trace lookup traverses the entire org trace before applying local project selection", async t => {
  const ctx = await setup(t, url => {
    assert.equal(url.searchParams.has("project_id"), false);
    const second = url.searchParams.has("cursor");
    return Response.json({ org_id: org, trace_id: trace, snapshot_watermark: end, groups: [{ project_id: second ? project : "synthetic-other-project", project: "Synthetic", total_count: 1, captured_count: 1, calls: [row(second ? id2 : id1, { project_id: second ? project : "synthetic-other-project" })] }], next_cursor: second ? null : "synthetic-next", coverage, generated_at: end });
  });
  const result = await ctx.requests.trace(trace, { project, workload, all: true });
  assert.equal(result.traversal.examined, 2); assert.equal(result.groups.length, 1); assert.equal(result.groups[0].calls[0].request_id, id2); assert.equal(result.traversal.complete, true);
});

test("trace discovery reports window-limited identities and untraced requests", async t => {
  const ctx = await setup(t, url => Response.json(feed(url, [row(), row(id2, { trace_id: null })])));
  const result = await ctx.requests.traces({ all: true });
  assert.equal(result.traces[0].requests, 1); assert.equal(result.untracedRequests, 1); assert.match(result.traceCoverage, /outside/);
});

test("stored capture listing traverses empty pages and rejects absent continuations and foreign keys", async t => {
  const ctx = await setup(t, url => Response.json(url.searchParams.has("cursor") ? { captures: [{ key: `${org}/${project}/synthetic-key/synthetic.jsonl`, request_id: id1, workos_org_id: org, size: 12, uploaded: start }], truncated: false, skipped_malformed: 1 } : { captures: [], truncated: true, cursor: "synthetic-next", skipped_malformed: 0 }));
  const result = await ctx.captures.list({ project, workload, environment: "test", all: true });
  assert.equal(result.captures.length, 1); assert.equal(result.traversal.pages, 2); assert.equal(result.scan[1].skippedMalformed, 1);
  const bad = await setup(t, () => Response.json({ captures: [], truncated: true }));
  await assert.rejects(() => bad.captures.list({ project, all: true }), /continuation/);
  const foreign = await setup(t, () => Response.json({ captures: [{ key: `${org}/synthetic-foreign/file`, request_id: id1, workos_org_id: org, size: 1, uploaded: start }], truncated: false }));
  await assert.rejects(() => foreign.captures.list({ project }), /selected project/);
});

test("capture reads verify envelope scope and keep file output private without overwriting", async t => {
  const ctx = await setup(t, () => Response.json({ capture: capture() }));
  const output = ".understudy/synthetic-capture.jsonl";
  const result = await ctx.captures.get(id1, { project, workload, environment: "test", output });
  assert.equal((await stat(result.artifact)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(result.artifact, "utf8")).request_id, id1);
  await assert.rejects(() => ctx.captures.get(id1, { project, output }), /already exists/);
  await assert.rejects(() => ctx.captures.get(id1, { project, output: "outside.json" }), /private state/);
  const foreign = await setup(t, () => Response.json({ capture: capture(id1, { workload_id: "synthetic-foreign" }) }));
  await assert.rejects(() => foreign.captures.get(id1, { project, workload }), /scope/);
});

test("safe filtered export preserves selected snapshot, missing payloads, and customer-byte hashes", async t => {
  const ctx = await setup(t, url => {
    if (url.pathname.endsWith("/request-logs")) return Response.json(feed(url, url.searchParams.has("cursor") ? [row(id2)] : [row()], url.searchParams.has("cursor") ? null : "synthetic-next"));
    if (url.pathname.endsWith(id1)) return Response.json({ capture: capture() });
    if (url.pathname.endsWith(id2)) return new Response(null, { status: 404 });
    throw new Error("Unexpected synthetic request");
  });
  const result = await ctx.captures.export({ project, workload, environment: "test", downloadId: "synthetic-download", includePayload: true, yes: true });
  assert.equal(result.status, "complete_with_gaps"); assert.equal(result.requested, 2); assert.equal(result.retrieved, 1); assert.equal(result.missing, 1);
  const manifest = JSON.parse(await readFile(result.artifact, "utf8"));
  assert.equal(manifest.selection.source, "request-log-snapshot"); assert.equal(manifest.selection.traversal.complete, true);
  assert.equal(manifest.entries[1].httpStatus, 404); assert.match(manifest.integrity, /not the original/);
  assert.equal((await stat(result.artifact)).mode & 0o777, 0o600);
  const body = await readFile(path.join(result.directory, manifest.entries[0].file), "utf8"); assert.equal(JSON.parse(body).request_id, id1);
  const scopePath = path.join(result.directory, "scope.json");
  await writeFile(scopePath, JSON.stringify({ organization: { id: org }, project: { id: project, slug: project, name: "Synthetic project" }, workload: { id: workload, name: "Synthetic workload", captureEnabled: true } }), { mode: 0o600 });
  const local = createMigrationService({ cwd: ctx.cwd, store: { read: async () => { throw new Error("Unexpected synthetic authentication"); } } });
  const imported = await local.importRun({ scope: scopePath, index: result.importIndex, runId: "synthetic-import" });
  assert.equal(imported.verified, 1); assert.equal(imported.completeness, "source_inventory_unverified");
  assert.equal((await local.verify("synthetic-import")).verified, 1);
  assert.ok(ctx.calls.every(call => !call.url.pathname.endsWith("/captures/export"))); assert.equal(JSON.stringify(manifest).includes("synthetic.synthetic"), false);
  await assert.rejects(() => ctx.captures.export({ project, workload, downloadId: "synthetic-download" }), /scope, selection, or payload mode/);
});

test("download fails closed on authorization failure while preserving an interrupted manifest", async t => {
  const ctx = await setup(t, url => url.pathname.endsWith("/request-logs") ? Response.json(feed(url, [row()])) : new Response(null, { status: 403 }));
  await assert.rejects(() => ctx.captures.export({ project, workload, downloadId: "synthetic-interrupted" }), /403.*Partial download/s);
  const artifact = path.join(ctx.cwd, ".understudy/downloads/synthetic-interrupted/manifest.json");
  const manifest = JSON.parse(await readFile(artifact, "utf8")); assert.equal(manifest.status, "interrupted"); assert.equal(manifest.missing, 0);
});

test("request projections strip unknown fields and preserve known rejection diagnostics", async t => {
  const unknown = { synthetic_internal: "should be omitted" };
  const ctx = await setup(t, url => Response.json(feed(url, [row(id1, { ...unknown, request_rejection: { code: "bad_request", stage: "request", ...unknown }, tokens: { ...row().tokens, ...unknown } })], null, { ...unknown, coverage: { ...coverage, ...unknown } })));
  const result = await ctx.requests.list();
  assert.equal(JSON.stringify(result).includes("synthetic_internal"), false);
  assert.equal(result.calls[0].request_rejection.code, "bad_request");
  for (const overrides of [{ calls: [row(id1, { tokens: { input_tokens: "invalid" } })] }, { org_id: "synthetic-foreign" }]) {
    const malformed = await setup(t, url => Response.json(feed(url, [row()], null, overrides)));
    await assert.rejects(() => malformed.requests.list(), /invalid response|scope/);
  }
});

test("request detail keeps customer cost and capability while rejecting foreign cost scope", async t => {
  function detail() { return { org_id: org, call: row(), cost: { org_id: org, request_id: id1, ts: start, project_id: project, workload_id: workload, provider: "managed", served_model: "synthetic-model", tokens: row().tokens, pricing_status: "unpriced", unpriced_reason: "pricing_pending", customer_cost_usd: null, cost_categories: null, coverage, generated_at: end, synthetic_internal: true }, cost_section: { status: "available", error: null }, payload_capability: { allowed: true, credential_class: "org_api_key" }, coverage, generated_at: end, synthetic_internal: true }; }
  const ctx = await setup(t, () => Response.json(detail()));
  const result = await ctx.requests.show(id1, { project, workload });
  assert.equal(result.cost.pricing_status, "unpriced"); assert.equal(result.payload_capability.allowed, true);
  assert.equal(JSON.stringify(result).includes("synthetic_internal"), false);
  const foreign = await setup(t, () => { const value = detail(); value.cost.org_id = "synthetic-foreign"; return Response.json(value); });
  await assert.rejects(() => foreign.requests.show(id1), /scope/);
});

test("capture projection strips supplier metadata without changing customer payload strings", async t => {
  const source = capture(id1, { customer_request_body: '{ "provider": "synthetic-customer-content" }', upstream_response_headers: { internal: "omit" }, synthetic_internal: true, tags: { synthetic: "caller tag" } });
  const ctx = await setup(t, () => Response.json({ capture: source }));
  const result = await ctx.captures.get(id1, { project, workload, includePayload: true, yes: true });
  assert.equal(result.capture.customer_request_body, source.customer_request_body);
  assert.deepEqual(result.capture.tags, { synthetic: "caller tag" });
  assert.equal("synthetic_internal" in result.capture, false); assert.equal("upstream_response_headers" in result.capture, false);
  const unsafe = await setup(t, () => Response.json({ capture: capture(id1, { upstream_request_body: "unexpected managed supplier request" }) }));
  await assert.rejects(() => unsafe.captures.get(id1, { project }), /invalid response/);
});

test("capture tags preserve own prototype-named keys through reads and saved exports", async t => {
  const tags = JSON.parse('{"__proto__":"synthetic-prototype","constructor":"synthetic-constructor","toString":"synthetic-method"}');
  const ctx = await setup(t, url => url.pathname.endsWith("/request-logs") ? Response.json(feed(url, [row()])) : Response.json({ capture: capture(id1, { tags }) }));
  const result = await ctx.captures.get(id1, { project, workload, includePayload: true, yes: true });
  assert.deepEqual(result.capture.tags, tags);
  assert.equal(Object.hasOwn(result.capture.tags, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(result.capture.tags), Object.prototype);
  assert.equal(Object.prototype.synthetic, undefined);
  const saved = await ctx.captures.export({ project, workload, downloadId: "synthetic-tag-export", includePayload: true, yes: true });
  const manifest = JSON.parse(await readFile(saved.artifact, "utf8"));
  const body = JSON.parse(await readFile(path.join(saved.directory, manifest.entries[0].file), "utf8"));
  assert.deepEqual(body.tags, tags);
  for (const invalid of [JSON.parse('{"__proto__":17}'), { constructor: null }, ["synthetic-tag"]]) {
    const bad = await setup(t, () => Response.json({ capture: capture(id1, { tags: invalid }) }));
    await assert.rejects(() => bad.captures.get(id1, { project }), /invalid response/);
  }
});

test("trace download completes every metadata page before fetching the selected payloads", async t => {
  const ctx = await setup(t, url => {
    if (url.pathname.includes("/request-logs/traces/")) {
      const second = url.searchParams.has("cursor");
      return Response.json({ org_id: org, trace_id: trace, snapshot_watermark: end, groups: [{ project_id: project, project: "Synthetic project", total_count: 2, captured_count: 2, calls: [row(second ? id2 : id1)] }], next_cursor: second ? null : "synthetic-next", coverage, generated_at: end });
    }
    return Response.json({ capture: capture(url.pathname.endsWith(id2) ? id2 : id1) });
  });
  const result = await ctx.captures.downloadTrace(trace, { project, workload, environment: "test", downloadId: "synthetic-trace" });
  assert.equal(result.retrieved, 2); assert.equal(result.missing, 0);
  const manifest = JSON.parse(await readFile(result.artifact, "utf8"));
  assert.equal(manifest.selection.source, "request-log-trace"); assert.equal(manifest.selection.traversal.pages, 2);
  const kinds = ctx.calls.map(call => call.url.pathname.includes("/request-logs/traces/") ? "metadata" : call.url.pathname.includes("/captures/") ? "capture" : "scope");
  assert.ok(kinds.lastIndexOf("metadata") < kinds.indexOf("capture"));
});

test("indexed migration export reports the platform limitation and preserves its run", async t => {
  const ctx = await setup(t, url => { assert.ok(url.pathname.endsWith("/captures/export")); return new Response(null, { status: 501 }); });
  const service = createMigrationService(ctx.options);
  const run = await service.init({ project, workload, runId: "synthetic-unavailable" });
  await assert.rejects(() => service.export(run.runId, "2020-01-01"), /Indexed customer capture export is unavailable.*captures export/s);
  assert.equal(JSON.parse(await readFile(path.join(run.directory, "run.json"), "utf8")).runId, run.runId);
});

test("an invalid later export page stops before any payload is requested or saved", async t => {
  const ctx = await setup(t, url => {
    assert.ok(url.pathname.endsWith("/request-logs"));
    return Response.json(url.searchParams.has("cursor") ? feed(url, [row(id2)], null, { org_id: "synthetic-foreign" }) : feed(url, [row()], "synthetic-next"));
  });
  await assert.rejects(() => ctx.captures.export({ project, workload, downloadId: "synthetic-rejected" }), /scope/);
  assert.ok(ctx.calls.every(call => !call.url.pathname.includes("/captures/")));
  await assert.rejects(() => stat(path.join(ctx.cwd, ".understudy/downloads/synthetic-rejected/manifest.json")), { code: "ENOENT" });
});

test("capture UUIDs accept non-v7 IDs and summaries omit payload and tag values by default", async t => {
  const id = "00000000-0000-4000-8000-000000000003";
  const ctx = await setup(t, () => Response.json({ capture: capture(id, { tags: { synthetic: "private synthetic value" } }) }));
  await assert.rejects(() => ctx.captures.get(id, { project, includePayload: true }), /include-payload --yes/);
  assert.equal(ctx.calls.length, 0);
  const result = await ctx.captures.get(id, { project, workload });
  assert.equal(result.capture.request_id, id);
  assert.equal(result.capture.customer_request_body, true);
  assert.deepEqual(result.capture.tags, { count: 1, keys: ["synthetic"] });
  assert.equal(JSON.stringify(result).includes("private synthetic value"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-response"), false);
});

test("workload storage listing defaults to production and explicit all is honored", async t => {
  const ctx = await setup(t, url => Response.json({ captures: [], truncated: false }));
  await ctx.captures.list({ project, workload });
  assert.equal(ctx.calls.at(-1).url.searchParams.get("request_environment"), "production");
  assert.equal(ctx.calls.at(-1).url.searchParams.get("limit"), "25");
  await ctx.captures.list({ project, workload, environment: "all" });
  assert.equal(ctx.calls.at(-1).url.searchParams.get("request_environment"), "all");
});

test("explicit private ID batches deduplicate IDs and export summaries without querying the feed", async t => {
  const ctx = await setup(t, url => {
    assert.ok(url.pathname.includes("/captures/"));
    return Response.json({ capture: capture(url.pathname.endsWith(id2) ? id2 : id1) });
  });
  const { MigrationStorage } = await import("../dist/migrations/storage.js");
  const storage = new MigrationStorage(ctx.cwd), file = path.join(storage.root, "synthetic-ids.txt");
  await storage.write(file, `# Synthetic inputs\n${id1}\n${id2}\n${id1}\n`);
  const result = await ctx.captures.export({ project, workload, requestIdsFile: file, downloadId: "synthetic-explicit" });
  assert.equal(result.requested, 2); assert.equal(result.retrieved, 2); assert.equal(result.includePayload, false); assert.equal(result.importIndex, null);
  const manifest = JSON.parse(await readFile(result.artifact, "utf8"));
  const saved = JSON.parse(await readFile(path.join(result.directory, manifest.entries[0].file), "utf8"));
  assert.equal(saved.customer_request_body, true); assert.match(manifest.entries[0].file, /^summaries\//);
  await assert.rejects(() => ctx.captures.export({ project, requestId: id1, window: "24h" }), /cannot be combined/);
  await assert.rejects(() => ctx.captures.export({ project, from: start, to: end }), /does not accept timestamp/);
});

test("resume freezes snapshot membership and verifies every reused file, no-resume redownloads it", async t => {
  let feeds = 0, bodies = 0;
  const ctx = await setup(t, url => {
    if (url.pathname.endsWith("/request-logs")) { feeds++; return Response.json(feed(url, [row()])); }
    bodies++; return Response.json({ capture: capture() });
  });
  const input = { project, workload, downloadId: "synthetic-resume", includePayload: true, yes: true };
  const result = await ctx.captures.export(input);
  await ctx.captures.export(input);
  assert.equal(feeds, 1); assert.equal(bodies, 1);
  const manifest = JSON.parse(await readFile(result.artifact, "utf8")), bodyPath = path.join(result.directory, manifest.entries[0].file);
  await writeFile(bodyPath, "synthetic corrupt file", { mode: 0o600 });
  await assert.rejects(() => ctx.captures.export(input), /integrity/);
  assert.equal(feeds, 1); assert.equal(bodies, 1);
  await ctx.captures.export({ ...input, resume: false });
  assert.equal(feeds, 1); assert.equal(bodies, 2);
  const other = createCapturesService({ ...ctx.options, baseUrl: "https://other.example.test" });
  await assert.rejects(() => other.export(input), /scope, selection, or payload mode/);
});

test("capture batch retries transient failures, preserves permanent gaps, and resumes failed members", async t => {
  let attempts = 0;
  const ctx = await setup(t, () => ++attempts === 1 ? new Response(null, { status: 429 }) : Response.json({ capture: capture() }));
  const result = await ctx.captures.export({ project, workload, requestId: id1, downloadId: "synthetic-retry", retries: 1 });
  assert.equal(attempts, 2); assert.equal(result.retrieved, 1);
  let fail = true;
  const partial = await setup(t, () => fail ? new Response(null, { status: 503 }) : Response.json({ capture: capture() }));
  const input = { project, workload, requestId: id1, downloadId: "synthetic-failed", retries: 0 };
  assert.equal((await partial.captures.export(input)).failed, 1);
  fail = false; assert.equal((await partial.captures.export(input)).retrieved, 1);
});

test("bounded metadata and payload limits fail without returning truncated data", async t => {
  const { MetadataBudget, MAX_CAPTURE_BYTES } = await import("../dist/captures/options.js");
  assert.throws(() => new MetadataBudget().add("synthetic", 100001), /100000/);
  const ctx = await setup(t, () => new Response(new Uint8Array(MAX_CAPTURE_BYTES + 1), { headers: { "content-type": "application/json" } }));
  await assert.rejects(() => ctx.captures.get(id1, { project, retries: 0 }), /byte|limit|MiB/i);
});

test("timestamp search uses the indexed API, exact cutoff, and requested interval without exposing URLs", async t => {
  const ctx = await setup(t, (url, init) => {
    assert.ok(url.pathname.endsWith("/captures/export"));
    const body = JSON.parse(init.body);
    assert.equal(body.from, start); assert.equal(body.to, "2020-01-02T00:00:00.000Z");
    return Response.json({ canonical_scope: { schema_version: "understudy.export-scope.v1", selector: "workload-window", org_id: org, project_id: project, workload_id: workload, from: body.from, to: body.to, ingestion_cutoff: body.to }, captures: [{ request_id: id1, capture_key: `${org}/${project}/synthetic-key/2020/01/01/${id1}.jsonl`, captured_at: start, url: "https://example.test/synthetic-capture" }], next_cursor: null });
  });
  const result = await ctx.captures.list({ project, workload, from: start, to: end });
  assert.equal(result.captures.length, 1); assert.equal(JSON.stringify(result).includes("https://"), false);
  const unavailable = await setup(t, () => new Response(null, { status: 501 }));
  await assert.rejects(() => unavailable.captures.list({ project, workload, from: start, to: end }), /returned 501.*no request-log substitution/);
});

test("indexed day export uses the flat workload contract and reports an actual unavailable response", async t => {
  const ctx = await setup(t, url => url.pathname.endsWith(`/workloads/${workload}`) ? Response.json({ id: workload, project_id: project, capture_enabled: true }) : new Response(null, { status: 501 }));
  await assert.rejects(() => ctx.captures.export({ project, workload, date: "2020-01-01", includePayload: true, yes: true, downloadId: "synthetic-indexed" }), /Indexed customer capture export is unavailable/);
  assert.ok(ctx.calls.some(call => call.url.pathname.endsWith("/captures/export")));
  const run = JSON.parse(await readFile(path.join(ctx.cwd, ".understudy/downloads/synthetic-indexed/run.json"), "utf8"));
  assert.equal(run.captureWindow.from, start); assert.equal(run.captureWindow.to, "2020-01-02T00:00:00.000Z");
});

test("indexed exports reject mixed selection modes before authentication", async t => {
  const ctx = await setup(t, () => { throw new Error("Unexpected network request"); });
  const captures = createCapturesService({ ...ctx.options, store: { read: async () => { throw new Error("Unexpected authentication"); } } });
  const input = { project, workload, date: "2020-01-01", includePayload: true, yes: true };
  for (const extra of [
    { requestId: id1 }, { requestIdsFile: ".understudy/synthetic-ids.txt" },
    { window: "24h" }, { outcome: "error" }, { statusCode: "429" }, { errorReason: "rate_limited" },
    { provider: "managed" }, { requestedModel: "synthetic-model" }, { servedModel: "synthetic-model" },
    { route: "synthetic-route" }, { captureState: "expected" }, { windowStart: start }, { windowEnd: end },
    { snapshotWatermark: end }, { includeRejectionDetails: true }, { limit: "10" }, { all: true },
  ]) await assert.rejects(() => captures.export({ ...input, ...extra }), /cannot be combined/, JSON.stringify(extra));
  await assert.rejects(() => captures.export({ ...input, last: "1d" }), /Choose --date or --last/);
  await assert.rejects(() => captures.export({ ...input, from: start, to: end }), /does not accept timestamp/);
  await assert.rejects(() => captures.export({ ...input, cursor: "synthetic-cursor" }), /omit --cursor/);
  await assert.rejects(() => captures.export({ ...input, traceIdsFile: ".understudy/synthetic-ids.txt" }), /trace-ID export is unavailable/);
  await assert.rejects(() => captures.downloadTrace(undefined, input), /Use captures export --date or --last/);
  assert.deepEqual(ctx.calls, []);
});

test("indexed exports retain payload, scope, environment and frozen-download restrictions", async t => {
  const ctx = await setup(t, () => { throw new Error("Unexpected indexed export"); });
  const input = { project, workload, date: "2020-01-01", includePayload: true, yes: true };
  for (const [extra, expected] of [
    [{ includePayload: false }, /requires --include-payload --yes/], [{ yes: false }, /requires --include-payload --yes/],
    [{ workload: undefined }, /requires a project and workload/], [{ environment: "all" }, /production environment only/],
    [{ resume: false }, /always resumes/], [{ out: ".understudy/synthetic-indexed", downloadId: "synthetic-indexed" }, /Choose --download-id or --out/],
    [{ date: "2020-02-30" }, /completed UTC date/], [{ date: undefined, last: "2d" }, /--last 1d/],
  ]) await assert.rejects(() => ctx.captures.export({ ...input, ...extra }), expected);
  assert.ok(ctx.calls.every(call => !call.url.pathname.endsWith("/captures/export")));
});

test("rolling indexed exports resume the original complete workload window", async t => {
  const windows = [];
  const ctx = await setup(t, (url, init) => {
    if (url.pathname.endsWith(`/workloads/${workload}`)) return Response.json({ id: workload, project_id: project, capture_enabled: true });
    assert.ok(url.pathname.endsWith("/captures/export"));
    const body = JSON.parse(init.body); windows.push({ from: body.from, to: body.to });
    return Response.json({ canonical_scope: { schema_version: "understudy.export-scope.v1", selector: "workload-window", org_id: org, project_id: project, workload_id: workload, from: body.from, to: body.to, ingestion_cutoff: body.to }, captures: [], next_cursor: null });
  });
  const input = { project, workload, last: "1d", includePayload: true, yes: true, downloadId: "synthetic-rolling" };
  const first = await ctx.captures.export(input), resumed = await ctx.captures.export(input);
  assert.equal(first.source, "indexed-workload-window");
  assert.equal(Date.parse(first.window.to) - Date.parse(first.window.from), 86_400_000);
  assert.deepEqual(resumed.window, first.window);
  assert.ok(windows.every(window => window.from === first.window.from && window.to === first.window.to));
  assert.equal(first.completeForDay, true);
  assert.equal(first.unavailable, 0);
  assert.ok(ctx.calls.every(call => !call.url.pathname.includes("request-logs")));
});

test("concurrent download checkpoints are batched and output retains deterministic member order", async t => {
  const { MigrationStorage } = await import("../dist/migrations/storage.js");
  const { downloadCaptures } = await import("../dist/captures/download.js");
  const ctx = await setup(t, () => { throw new Error("Unexpected network request"); });
  const storage = new MigrationStorage(ctx.cwd), write = storage.write.bind(storage);
  let checkpoints = 0, active = 0, maximum = 0;
  storage.write = async (file, value) => { if (file.endsWith("manifest.json")) checkpoints++; return write(file, value); };
  const members = Array.from({ length: 120 }, (_, i) => ({ requestId: `synthetic-${i}`, projectId: project, workloadId: workload, traceId: null }));
  const result = await downloadCaptures({ storage, organizationId: org, intent: { source: "synthetic" }, options: { downloadId: "synthetic-concurrent", concurrency: 2 }, select: async () => ({ members, selection: { source: "synthetic" } }), fetch: async member => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return { request_id: member.requestId };
  } });
  assert.equal(maximum, 2); assert.ok(checkpoints <= 6, `Expected bounded checkpoints, got ${checkpoints}`);
  const manifest = JSON.parse(await readFile(result.artifact, "utf8"));
  assert.deepEqual(manifest.entries.map(entry => entry.requestId), members.map(member => member.requestId));
});

test("terminal capture listings accept an omitted or null continuation cursor", async t => {
  const ctx = await setup(t, () => Response.json({ captures: [], truncated: false, cursor: null }));
  assert.equal((await ctx.captures.list({ project, workload, all: true })).traversal.complete, true);
  const bad = await setup(t, () => Response.json({ captures: [], truncated: true, cursor: null }));
  await assert.rejects(() => bad.captures.list({ project, workload, all: true }), /continuation/);
});

test("a full redownload clears an older importer index when payloads have expired", async t => {
  let expired = false;
  const ctx = await setup(t, () => expired ? new Response(null, { status: 404 }) : Response.json({ capture: capture() }));
  const input = { project, workload, requestId: id1, includePayload: true, yes: true, downloadId: "synthetic-expiry" };
  const initial = await ctx.captures.export(input);
  assert.ok(initial.importIndex);
  expired = true;
  const result = await ctx.captures.export({ ...input, resume: false });
  assert.equal(result.retrieved, 0); assert.equal(result.missing, 1); assert.equal(result.importIndex, null);
  await assert.rejects(() => stat(initial.importIndex), { code: "ENOENT" });
});

test("explicit trace files collect all trace pages and do not call an unverified legacy endpoint", async t => {
  const secondTrace = "22222222222222222222222222222222";
  const ctx = await setup(t, url => {
    if (url.pathname.includes("/request-logs/traces/")) {
      const selected = url.pathname.endsWith(secondTrace), selectedId = selected ? id2 : id1, selectedTrace = selected ? secondTrace : trace;
      return Response.json({ org_id: org, trace_id: selectedTrace, snapshot_watermark: end, groups: [{ project_id: project, project: "Synthetic project", total_count: 1, captured_count: 1, calls: [row(selectedId, { trace_id: selectedTrace })] }], next_cursor: null, coverage, generated_at: end });
    }
    return Response.json({ capture: capture(url.pathname.endsWith(id2) ? id2 : id1, { trace_id: url.pathname.endsWith(id2) ? secondTrace : trace }) });
  });
  const { MigrationStorage } = await import("../dist/migrations/storage.js");
  const storage = new MigrationStorage(ctx.cwd), file = path.join(storage.root, "synthetic-traces.txt");
  await storage.write(file, `${trace}\n${secondTrace}\n${trace}\n`);
  const result = await ctx.captures.downloadTrace(undefined, { project, workload, traceIdsFile: file, downloadId: "synthetic-trace-batch" });
  assert.equal(result.requested, 2); assert.equal(result.retrieved, 2);
  assert.ok(ctx.calls.every(call => !call.url.pathname.endsWith("/request-ids")));
});

test("indexed raw downloads record gone objects as payload gaps", async t => {
  const ctx = await setup(t, (url, init) => {
    if (url.pathname.endsWith(`/workloads/${workload}`)) return Response.json({ id: workload, project_id: project, capture_enabled: true });
    if (url.pathname.endsWith("/captures/export")) {
      const body = JSON.parse(init.body);
      return Response.json({ canonical_scope: { schema_version: "understudy.export-scope.v1", selector: "workload-window", org_id: org, project_id: project, workload_id: workload, from: body.from, to: body.to, ingestion_cutoff: body.to }, captures: [{ request_id: id1, capture_key: `${org}/${project}/synthetic-key/2020/01/01/${id1}.jsonl`, captured_at: start, url: "https://synthetic.r2.cloudflarestorage.com/object" }], next_cursor: null });
    }
    return new Response(null, { status: 410 });
  });
  const result = await ctx.captures.export({ project, workload, date: "2020-01-01", includePayload: true, yes: true, downloadId: "synthetic-gone" });
  assert.equal(result.unavailable, 1); assert.equal(result.completeForDay, false);
  await assert.rejects(() => ctx.captures.list({ project, workload, from: start, to: end, requestedModel: "synthetic-model" }), /cannot be combined/);
});
