import { z } from "zod";
import { createCredentialStore } from "../auth/credentials.js";
import { CliError } from "../errors.js";
import { resolveManagementScope, type ManagementScopeOptions } from "../context/service.js";
import { requestManagementJson } from "../management/client.js";
import type { SessionOptions } from "../migrations/scope.js";
import { MetadataBudget, MAX_METADATA_PAGE_BYTES, withRetry, boundedInteger } from "../captures/options.js";
import { requestEnvironment, requestFilters, pageLimit, textFilter, type RequestQuery } from "./filters.js";

export interface RequestsOptions extends SessionOptions { cwd?: string; contextStore?: ManagementScopeOptions["contextStore"] }
export type RequestScope = Awaited<ReturnType<typeof resolveManagementScope>>;
import { requestRowSchema, feedSchema, traceSchema, detailSchema, failureSchema } from "./contracts.js";
export { requestRowSchema } from "./contracts.js";
export type RequestRow = z.infer<typeof requestRowSchema>;
export function requestId(value: string): string {
  const id = value.toLowerCase();
  if (id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new CliError("Supply a complete request id (UUIDv7).");
  return id;
}
export function traceId(value: string): string {
  const id = value.toLowerCase();
  if (id.length !== 32 || !/^[0-9a-f]{32}$/.test(id) || /^0+$/.test(id)) throw new CliError("Supply a nonzero 32-character hexadecimal trace id.");
  return id;
}
export async function resolveRequestScope(options: RequestsOptions, input: RequestQuery = {}, requireProject = false, useDefaults = true): Promise<RequestScope> {
  return resolveManagementScope({ ...options, store: options.store ?? createCredentialStore() }, { org: input.org, project: input.project, workload: input.workload, requireProject, useDefaults });
}
export function publicScope(scope: RequestScope) {
  return { organizationId: scope.session.organizationId, projectId: scope.project?.id ?? null, workloadId: scope.workload?.id ?? null };
}
function base(scope: RequestScope) { return `/admin/v1/orgs/${encodeURIComponent(scope.session.organizationId)}/request-logs`; }
function badScope(): never { throw new CliError("The returned request evidence does not match the authenticated scope or selected snapshot."); }
function assertRow(row: RequestRow, scope: RequestScope, environment: string, selected = true) {
  if (selected && ((scope.project && row.project_id !== scope.project.id) || (scope.workload && row.workload_id !== scope.workload.id))) badScope();
  if (environment !== "all" && (row.request_environment ?? "production") !== environment) badScope();
}
function scopedFilters(scope: RequestScope, input: RequestQuery) {
  const query = requestFilters(input);
  if (scope.project) query.set("project_id", scope.project.id);
  if (scope.workload) query.set("workload_id", scope.workload.id);
  return query;
}
function stable(value: Record<string, unknown>) { return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }
export async function readRequestFeed(scope: RequestScope, input: RequestQuery) {
  const query = scopedFilters(scope, input), environment = requestEnvironment(input.environment);
  query.set("limit", String(pageLimit(input.limit)));
  let first: z.infer<typeof feedSchema> | undefined;
  const budget = new MetadataBudget();
  const calls: RequestRow[] = [], cursors = new Set<string>(), ids = new Set<string>(), pageCoverage: Record<string, unknown>[] = [];
  let pageCount = 0, cursor: string | null = input.cursor ?? null;
  if (cursor) cursors.add(cursor);
  do {
    if (cursor) query.set("cursor", cursor); else query.delete("cursor");
    const page = await withRetry(() => requestManagementJson(scope.session, { path: `${base(scope)}?${query}`, action: "Request listing", timeoutMs: 30000, maxResponseBytes: MAX_METADATA_PAGE_BYTES }, feedSchema), boundedInteger(input.retries, "Retries", 0, 5, 2));
    if (page.org_id !== scope.session.organizationId || page.window !== (input.window ?? "1h")) badScope();
    for (const key of ["project_id", "workload_id", "request_environment", "outcome", "status_code", "error_reason", "provider", "requested_model", "served_model", "route", "capture_state"]) {
      const expected = query.get(key);
      const actual = page.filters[key as keyof typeof page.filters];
      if (expected === null ? actual !== null && actual !== undefined : String(actual) !== expected) badScope();
    }
    if (first && (page.window_start !== first.window_start || page.window_end !== first.window_end || page.snapshot_watermark !== first.snapshot_watermark || stable(page.filters) !== stable(first.filters))) badScope();
    if (!first) {
      first = page;
      for (const [key, value] of [["window_start", page.window_start], ["window_end", page.window_end], ["snapshot_watermark", page.snapshot_watermark]]) {
        if (query.has(key) && query.get(key) !== value) badScope();
        query.set(key, value);
      }
    }
    for (const row of page.calls) {
      assertRow(row, scope, environment);
      if (ids.has(row.request_id)) throw new CliError("The request snapshot repeated a request across pages.");
      budget.add(row); ids.add(row.request_id); calls.push(row);
    }
    budget.add({ coverage: page.coverage, cursor: page.next_cursor }, 0); pageCoverage.push(page.coverage); pageCount++;
    cursor = page.next_cursor;
    if (cursor && cursors.has(cursor)) throw new CliError("The request cursor did not advance.");
    if (cursor) cursors.add(cursor);
  } while (input.all && cursor);
  return { ...first!, calls, next_cursor: cursor, scope: publicScope(scope), traversal: { pages: pageCount, complete: cursor === null && !input.cursor, startedFromCursor: !!input.cursor, requests: calls.length }, pageCoverage };
}
export function createRequestsService(options: RequestsOptions = {}) {
  return {
    async list(input: RequestQuery = {}) { requestFilters(input); return readRequestFeed(await resolveRequestScope(options, input), input); },
    async show(idInput: string, input: RequestQuery = {}) {
      const id = requestId(idInput), environment = requestEnvironment(input.environment);
      const scope = await resolveRequestScope(options, input);
      const query = new URLSearchParams({ request_environment: environment });
      if (input.includeRejectionDetails) query.set("include_rejection_details", "true");
      const result = await requestManagementJson(scope.session, { path: `${base(scope)}/requests/${id}?${query}`, action: "Request lookup", timeoutMs: 30000, maxResponseBytes: MAX_METADATA_PAGE_BYTES }, detailSchema);
      if (result.org_id !== scope.session.organizationId || result.call.request_id !== id) badScope();
      assertRow(result.call, scope, environment);
      if (result.cost && (result.cost.org_id !== scope.session.organizationId || result.cost.request_id !== id || result.cost.project_id !== result.call.project_id || result.cost.workload_id !== result.call.workload_id)) badScope();
      return { ...result, scope: publicScope(scope) };
    },
    async failureContext(input: RequestQuery = {}) {
      if (input.limit !== undefined || input.cursor !== undefined || input.all) throw new CliError("Failure context summarizes a filtered window; omit pagination.");
      requestFilters(input);
      const scope = await resolveRequestScope(options, input), query = scopedFilters(scope, input);
      const result = await requestManagementJson(scope.session, { path: `${base(scope)}/failure-context?${query}`, action: "Failure context", timeoutMs: 30000, maxResponseBytes: MAX_METADATA_PAGE_BYTES }, failureSchema);
      if (result.org_id !== scope.session.organizationId) badScope();
      for (const key of ["window_start", "window_end", "snapshot_watermark"] as const) if (query.has(key) && query.get(key) !== result[key]) badScope();
      return { ...result, scope: publicScope(scope), selection: Object.fromEntries(query) };
    },
    async trace(idInput: string, input: RequestQuery = {}) {
      const id = traceId(idInput), environment = requestEnvironment(input.environment);
      for (const key of ["window", "outcome", "statusCode", "errorReason", "provider", "requestedModel", "servedModel", "route", "captureState", "windowStart", "windowEnd", "snapshotWatermark"] as const) if (input[key] !== undefined) throw new CliError(`Trace lookup does not support ${key}; use request listing for time-window selection.`);
      if (input.all && input.cursor) throw new CliError("Start complete trace traversal without a cursor.");
      const scope = await resolveRequestScope(options, input), query = new URLSearchParams({ request_environment: environment, limit: String(pageLimit(input.limit)) });
      if (input.includeRejectionDetails) query.set("include_rejection_details", "true");
      let cursor = input.cursor ? textFilter(input.cursor, "cursor", 4096) : null;
      const cursors = new Set<string>(), ids = new Set<string>(), groups = new Map<string, { project_id: string; project: string | null; server_total_count: number; server_captured_count: number; calls: RequestRow[] }>();
      if (cursor) cursors.add(cursor);
      const budget = new MetadataBudget();
      let snapshot: string | undefined, pageCount = 0, examined = 0;
      const pageCoverage: Record<string, unknown>[] = [];
      do {
        if (cursor) query.set("cursor", cursor); else query.delete("cursor");
        const page = await withRetry(() => requestManagementJson(scope.session, { path: `${base(scope)}/traces/${id}?${query}`, action: "Trace lookup", timeoutMs: 30000, maxResponseBytes: MAX_METADATA_PAGE_BYTES }, traceSchema), boundedInteger(input.retries, "Retries", 0, 5, 2));
        if (page.org_id !== scope.session.organizationId || page.trace_id !== id || (snapshot && page.snapshot_watermark !== snapshot)) badScope();
        budget.add({ coverage: page.coverage, cursor: page.next_cursor, groups: page.groups.map(({ calls, ...group }) => group) }, 0); snapshot = page.snapshot_watermark; pageCount++; pageCoverage.push(page.coverage);
        for (const group of page.groups) {
          const saved = groups.get(group.project_id);
          if (saved && (saved.server_total_count !== group.total_count || saved.server_captured_count !== group.captured_count)) badScope();
          const output = saved ?? { project_id: group.project_id, project: group.project, server_total_count: group.total_count, server_captured_count: group.captured_count, calls: [] };
          for (const row of group.calls) {
            if (row.project_id !== group.project_id || row.trace_id !== id) badScope();
            assertRow(row, scope, environment, false);
            if (ids.has(row.request_id)) throw new CliError("The trace snapshot repeated a request across pages.");
            budget.add(row); ids.add(row.request_id); examined++;
            if ((!scope.project || row.project_id === scope.project.id) && (!scope.workload || row.workload_id === scope.workload.id)) output.calls.push(row);
          }
          groups.set(group.project_id, output);
        }
        cursor = page.next_cursor;
        if (cursor && cursors.has(cursor)) throw new CliError("The trace cursor did not advance.");
        if (cursor) cursors.add(cursor);
      } while (input.all && cursor);
      return { org_id: scope.session.organizationId, trace_id: id, snapshot_watermark: snapshot!, scope: publicScope(scope), environment, groups: [...groups.values()].filter(group => !scope.project || group.project_id === scope.project.id).map(group => ({ ...group, matched_count: group.calls.length })), next_cursor: cursor, traversal: { pages: pageCount, complete: cursor === null && !input.cursor, examined, startedFromCursor: !!input.cursor }, pageCoverage, selection: "Project and workload filters apply locally after organization-scoped trace lookup. Server group counts describe the entire project within this trace." };
    },
    async traces(input: RequestQuery = {}) {
      requestFilters(input);
      const feed = await readRequestFeed(await resolveRequestScope(options, input), input);
      const traces = new Map<string, { trace_id: string; requests: number; projects: Set<string>; workloads: Set<string> }>();
      let untraced = 0;
      for (const row of feed.calls) {
        if (!row.trace_id) { untraced++; continue; }
        const trace = traces.get(row.trace_id) ?? { trace_id: row.trace_id, requests: 0, projects: new Set<string>(), workloads: new Set<string>() };
        trace.requests++; trace.projects.add(row.project_id); trace.workloads.add(row.workload_id); traces.set(row.trace_id, trace);
      }
      const { calls, ...selection } = feed;
      return { ...selection, traces: [...traces.values()].map(trace => ({ ...trace, projects: [...trace.projects], workloads: [...trace.workloads] })), untracedRequests: untraced, traceCoverage: "Trace identities observed in this request selection; counts exclude requests outside its filters and window." };
    },
  };
}
export type RequestsService = ReturnType<typeof createRequestsService>;
