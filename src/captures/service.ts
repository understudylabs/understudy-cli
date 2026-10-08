import path from "node:path";
import { open } from "node:fs/promises";
import { z } from "zod";
import { CliError } from "../errors.js";
import { requestManagementJson, defaultManagementUrl } from "../management/client.js";
import { MigrationStorage, digest } from "../migrations/storage.js";
import { createRequestsService, readRequestFeed, resolveRequestScope, publicScope, traceId, type RequestRow, type RequestsOptions, type RequestScope } from "../requests/service.js";
import { pageLimit, requestEnvironment, textFilter, requestFilters, type RequestQuery } from "../requests/filters.js";

import { captureSchema, listingSchema, summarizeCapture } from "./contracts.js";
import { downloadCaptures, type CaptureMember } from "./download.js";
import { captureRequestId, downloadOptions, readIdFile, withRetry, MetadataBudget, MAX_CAPTURE_BYTES, MAX_METADATA_PAGE_BYTES, type DownloadOptions } from "./options.js";
import { searchCaptures } from "./search.js";
import { exportIndexedDay } from "./indexed.js";
export interface CaptureInput extends RequestQuery, DownloadOptions { requestId?: string; requestIdsFile?: string; traceIdsFile?: string; from?: string; to?: string; date?: string; last?: string }
export function captureBase(scope: RequestScope): string {
  if (!scope.project) throw new CliError("Capture operations require a project.");
  return `/admin/v1/orgs/${encodeURIComponent(scope.session.organizationId)}/projects/${encodeURIComponent(scope.project.id)}${scope.workload ? `/workloads/${encodeURIComponent(scope.workload.id)}` : ""}/captures`;
}
function assertCapture(capture: z.infer<typeof captureSchema>, scope: RequestScope, id: string, environment: string) {
  if (capture.request_id !== id || capture.workos_org_id !== scope.session.organizationId || capture.project_id !== scope.project?.id || (scope.workload && (capture.workload_id ?? capture.placement_id) !== scope.workload.id) || (environment !== "all" && (capture.request_environment ?? "production") !== environment)) throw new CliError("The returned capture does not match the selected request and authenticated scope.");
}
export async function getScopedCapture(scope: RequestScope, id: string, environment = "all") {
  const result = await requestManagementJson(scope.session, { path: `${captureBase(scope)}/${encodeURIComponent(id)}`, action: "Capture lookup", timeoutMs: 30000, maxResponseBytes: MAX_CAPTURE_BYTES }, z.object({ capture: captureSchema }));
  assertCapture(result.capture, scope, id, environment);
  return result.capture;
}
const toMember = (row: RequestRow): CaptureMember => ({ requestId: row.request_id, projectId: row.project_id, workloadId: row.workload_id || null, traceId: row.trace_id });
export function createCapturesService(options: RequestsOptions = {}) {
  const requests = createRequestsService(options), storage = new MigrationStorage(options.cwd);
  function fetcher(selectedOrg: string, input: CaptureInput) {
    const scopes = new Map<string, Promise<RequestScope>>();
    return async (member: CaptureMember) => {
      const key = JSON.stringify([member.projectId, member.workloadId]);
      let scope = scopes.get(key);
      if (!scope) {
        scope = resolveRequestScope(options, { org: selectedOrg, project: member.projectId, ...(member.workloadId ? { workload: member.workloadId } : {}) }, true, false).catch(error => { scopes.delete(key); throw error; });
        scopes.set(key, scope);
      }
      const capture = await getScopedCapture(await scope, member.requestId, requestEnvironment(input.environment));
      if (member.traceId && capture.trace_id !== undefined && capture.trace_id !== member.traceId) throw new CliError("Captured trace identity differs from the selected request metadata.");
      return input.includePayload ? capture : summarizeCapture(capture);
    };
  }
  function queryIntent(scope: RequestScope, input: CaptureInput, mode: string) {
    const { output, out, downloadId, includePayload, yes, concurrency, retries, resume, ...query } = input;
    return { mode, ...query, ...publicScope(scope), serviceOrigin: new URL(scope.session.baseUrl ?? defaultManagementUrl).origin, environment: requestEnvironment(input.environment) };
  }
  return {
    async list(input: CaptureInput = {}) {
      if (input.from !== undefined || input.to !== undefined) {
        if (input.cursor || input.limit !== undefined || input.all) throw new CliError("Timestamp search scans its complete index window; omit pagination flags.");
        for (const field of ["window", "outcome", "statusCode", "errorReason", "provider", "requestedModel", "servedModel", "route", "captureState", "windowStart", "windowEnd", "snapshotWatermark"] as const) if (input[field] !== undefined) throw new CliError("Timestamp search cannot be combined with request-log filters.");
        const scope = await resolveRequestScope(options, input, true);
        return { scope: publicScope(scope), environment: "production", ...await searchCaptures(scope, input) };
      }
      for (const field of ["window", "outcome", "statusCode", "errorReason", "provider", "requestedModel", "servedModel", "route", "captureState", "windowStart", "windowEnd", "snapshotWatermark"] as const) if (input[field] !== undefined) throw new CliError("Stored capture listing does not support request filters. Use requests list or captures export for a filtered metadata selection.");
      const limit = pageLimit(input.limit, 25);
      if (input.all && input.cursor) throw new CliError("Start complete capture traversal without a cursor.");
      const scope = await resolveRequestScope(options, input, true);
      const environment = requestEnvironment(input.environment ?? (scope.workload ? "production" : "all"));
      if (!scope.workload && environment !== "all") throw new CliError("Stored project capture listing has no environment filter. Select a workload or use requests list.");
      const query = new URLSearchParams({ limit: String(limit) });
      if (scope.workload) query.set("request_environment", environment);
      let cursor = input.cursor ? textFilter(input.cursor, "cursor", 8192) : null, pageCount = 0;
      const cursors = new Set<string>(), keys = new Set<string>(), captures: z.infer<typeof listingSchema>["captures"] = [];
      const scan: Array<{ skippedMalformed: number | null; scannedThrough: string | null }> = [], budget = new MetadataBudget();
      if (cursor) cursors.add(cursor);
      do {
        if (cursor) query.set("cursor", cursor); else query.delete("cursor");
        const page = await requestManagementJson(scope.session, { path: `${captureBase(scope)}?${query}`, action: "Capture listing", timeoutMs: 30000, maxResponseBytes: MAX_METADATA_PAGE_BYTES }, listingSchema);
        budget.add({ cursor: page.cursor, skippedMalformed: page.skipped_malformed, scannedThrough: page.scanned_through }, 0);
        for (const item of page.captures) {
          if (item.workos_org_id !== scope.session.organizationId || !item.key.startsWith(`${scope.session.organizationId}/${scope.project!.id}/`)) throw new CliError("The capture listing crossed the authenticated organization or selected project.");
          if (keys.has(item.key)) throw new CliError("Capture listing repeated an object across pages.");
          budget.add(item); keys.add(item.key); captures.push(item);
        }
        if (page.truncated && !page.cursor) throw new CliError("A truncated capture page did not supply its continuation cursor.");
        cursor = page.truncated ? page.cursor! : null;
        if (cursor && cursors.has(cursor)) throw new CliError("The capture cursor did not advance.");
        if (cursor) cursors.add(cursor);
        pageCount++; scan.push({ skippedMalformed: page.skipped_malformed ?? null, scannedThrough: page.scanned_through ?? null });
      } while (input.all && cursor);
      return { scope: publicScope(scope), environment, captures, nextCursor: cursor, traversal: { pages: pageCount, complete: cursor === null && !input.cursor, startedFromCursor: !!input.cursor }, scan, coverage: "Stored-object listing is not an atomic snapshot and does not measure uncaptured traffic." };
    },
    async get(idInput: string, input: CaptureInput = {}) {
      const storage = new MigrationStorage(options.cwd);
      const settings = downloadOptions(input);
      const id = captureRequestId(idInput), environment = requestEnvironment(input.environment);
      const output = input.output ?? input.out;
      const artifact = output ? path.resolve(options.cwd ?? process.cwd(), output) : undefined;
      if (artifact) await storage.check(artifact, true);
      const scope = await resolveRequestScope(options, input, true), body = await withRetry(() => getScopedCapture(scope, id, environment), settings.retries);
      const capture = input.includePayload ? body : summarizeCapture(body);
      if (!artifact) return { scope: publicScope(scope), capture };
      const bytes = Buffer.from(`${JSON.stringify(capture)}\n`);
      // Private storage validation happens before writing and rejects outside paths,
      // symlinks, tracked state and permissive existing files.
      await storage.check(artifact, true);
      const handle = await open(artifact, "wx", 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError("The capture output already exists; choose a new private path."); throw error; });
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      return { scope: publicScope(scope), requestId: id, artifact, bytes: bytes.length, sha256: digest(bytes), representation: input.includePayload ? "customer-visible-json" : "capture-summary" };
    },
    async export(input: CaptureInput = {}) {
      downloadOptions(input);
      if (input.from !== undefined || input.to !== undefined) throw new CliError("Capture export does not accept timestamp search flags. Use captures list --from --to, or a filtered request snapshot export.");
      if (input.cursor) throw new CliError("Capture export starts at the first page of a selected request snapshot; omit --cursor.");
      if (input.requestId && input.requestIdsFile) throw new CliError("Choose a request id or --request-ids-file.");
      if (input.traceIdsFile !== undefined) throw new CliError("Capture export accepts request IDs, a filtered snapshot, or an indexed workload day; trace-ID export is unavailable.");
      if (input.date !== undefined || input.last !== undefined) {
        if (input.date !== undefined && input.last !== undefined) throw new CliError("Choose --date or --last.");
        if ([input.requestId, input.requestIdsFile, input.window, input.outcome, input.statusCode, input.errorReason, input.provider, input.requestedModel, input.servedModel, input.route, input.captureState, input.windowStart, input.windowEnd, input.snapshotWatermark, input.includeRejectionDetails, input.limit, input.all].some(value => value !== undefined)) throw new CliError("Indexed workload-day export cannot be combined with request IDs or snapshot filters.");
        const scope = await resolveRequestScope(options, input, true);
        return exportIndexedDay(scope, input, options);
      }
      const explicit = input.requestId !== undefined || input.requestIdsFile !== undefined;
      if (explicit && [input.window, input.outcome, input.statusCode, input.errorReason, input.provider, input.requestedModel, input.servedModel, input.route, input.captureState, input.windowStart, input.windowEnd, input.snapshotWatermark, input.from, input.to].some(value => value !== undefined)) throw new CliError("Explicit request IDs cannot be combined with snapshot or timestamp filters.");
      requestFilters(input);
      const scope = await resolveRequestScope(options, input, true);
      const ids = input.requestId ? [captureRequestId(input.requestId)] : input.requestIdsFile ? await readIdFile(storage, path.resolve(storage.project, input.requestIdsFile), captureRequestId) : undefined;
      return downloadCaptures({ storage, organizationId: scope.session.organizationId, intent: { ...queryIntent(scope, input, explicit ? "explicit-request-ids" : "request-log-snapshot"), ...(ids ? { requestIds: ids } : {}) }, options: input,
        select: async () => {
          if (ids) return { members: ids.map(requestId => ({ requestId, projectId: scope.project!.id, workloadId: scope.workload?.id ?? null, traceId: null })), selection: { source: "explicit-request-ids", ...publicScope(scope), requestIds: ids } };
          const { calls, ...selection } = await readRequestFeed(scope, { ...input, all: true });
          return { members: calls.map(toMember), selection: { source: "request-log-snapshot", ...selection } };
        }, fetch: fetcher(scope.session.organizationId, input) });
    },
    async downloadTrace(idInput: string | undefined, input: CaptureInput = {}) {
      downloadOptions(input);
      if (input.date !== undefined || input.last !== undefined) throw new CliError("Use captures export --date or --last for indexed workload-day exports.");
      if (input.cursor) throw new CliError("Trace download starts at the first trace page; omit --cursor.");
      if (idInput && input.traceIdsFile) throw new CliError("Choose a trace id or --trace-ids-file.");
      const scope = await resolveRequestScope(options, input);
      const ids = idInput ? [traceId(idInput)] : input.traceIdsFile ? await readIdFile(storage, path.resolve(storage.project, input.traceIdsFile), traceId) : [];
      if (!ids.length) throw new CliError("Supply a trace id or --trace-ids-file.");
      return downloadCaptures({ storage, organizationId: scope.session.organizationId, intent: { ...queryIntent(scope, input, "request-log-traces"), traceIds: ids }, options: input,
        select: async () => {
          const members: CaptureMember[] = [], traces = [], budget = new MetadataBudget();
          for (const id of ids) {
            const trace = await requests.trace(id, { ...input, org: scope.session.organizationId, all: true });
            for (const group of trace.groups) for (const row of group.calls) { const member = toMember(row); budget.add(member); members.push(member); }
            const metadata = { ...trace, groups: trace.groups.map(({ calls, ...group }) => group) };
            budget.add(metadata, 0); traces.push(metadata);
          }
          return { members, selection: ids.length === 1 ? { source: "request-log-trace", ...traces[0] } : { source: "request-log-traces", traces } };
        }, fetch: fetcher(scope.session.organizationId, input) });
    },
  };
}
export type CapturesService = ReturnType<typeof createCapturesService>;
