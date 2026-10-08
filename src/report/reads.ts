import { z } from "zod";
import { createCredentialStore, type CredentialStore } from "../auth/credentials.js";
import { resolveManagementScope } from "../context/service.js";
import type { ContextStore } from "../context/storage.js";
import { CliError } from "../errors.js";
import { requestManagementJson, type ManagementOptions } from "../management/client.js";
import { listManagementProjects } from "../management/projects.js";
import { resolveManagementSession } from "../management/session.js";
import { balanceSchema, billingModelsSchema, billingSummarySchema, billingTrendSchema, breakdownSchema, costSchema, errorsSchema, providersSchema, reportingSchema, usageSummarySchema, workloadStatusSchema } from "./contracts.js";

export interface ReportReadInput {
  org?: string;
  project?: string;
  projectId?: string;
  workload?: string;
  workloadId?: string;
  environment?: string;
  window?: string;
  from?: string;
  to?: string;
  groupBy?: string;
  granularity?: string;
  excludeProject?: string[];
  excludeProjectId?: string[];
  useDefaults?: boolean;
  ignoreWorkloadDefault?: boolean;
}
interface ReadOptions { authStore?: CredentialStore; contextStore?: ContextStore; cwd?: string; baseUrl?: string; fetchImplementation?: typeof fetch; now?: () => Date }
export interface ScopedReport { organizationId: string; projectId?: string; workloadId?: string; request: Record<string, string | string[]>; data: unknown; pricingCoverage?: "unavailable" }
export type ProjectReport = "workload-status" | "providers" | "cost-breakdown";
export type BillingReport = "balance" | "summary" | "trend" | "usage-by-model";

function fail(message: string): never { throw new CliError(message); }
export function normalizeReportInput(input: ReportReadInput): ReportReadInput {
  const identifier = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > 255) fail("Identifier filters must contain between 1 and 255 characters.");
    return normalized;
  };
  const projectId = identifier(input.projectId), workloadId = identifier(input.workloadId);
  for (const [name, selector, id] of [["project", input.project, projectId], ["workload", input.workload, workloadId]]) {
    if (selector !== undefined && id !== undefined && selector !== id) fail(`Use one --${name} or --${name}-id selector, not conflicting values.`);
  }
  return { ...input, project: projectId ?? input.project, workload: workloadId ?? input.workload,
    excludeProject: [...new Set([...(input.excludeProject ?? []), ...(input.excludeProjectId ?? []).map(value => identifier(value)!)])] };
}
function oneOf(value: string, choices: string[], label: string): string {
  if (!choices.includes(value)) fail(`Invalid ${label}. Use ${choices.join(", ")}.`);
  return value;
}
function environment(value: string | undefined, fallback: string): string {
  const result = value ?? fallback;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result) || result.trim() !== result) fail("Environment must be a lowercase name of at most 64 characters, or all.");
  return result;
}
function day(value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("Use both --from and --to as inclusive UTC dates (YYYY-MM-DD).");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail("Invalid UTC date.");
  return parsed;
}
export function reportRange(input: ReportReadInput): { query: URLSearchParams; minutes: number } {
  const query = new URLSearchParams();
  let minutes: number;
  if (input.from !== undefined || input.to !== undefined) {
    if (input.window !== undefined) fail("Choose --window or --from/--to, not both.");
    const start = day(input.from);
    const end = day(input.to);
    minutes = (end.getTime() - start.getTime()) / 60_000 + 1_440;
    if (minutes <= 0 || minutes > 366 * 1_440) fail("The inclusive date range must be ordered and at most 366 days.");
    query.set("from", input.from!); query.set("to", input.to!);
  } else {
    const window = oneOf(input.window ?? "24h", ["24h", "7d", "30d"], "window");
    query.set("window", window);
    minutes = ({ "24h": 1_440, "7d": 10_080, "30d": 43_200 } as Record<string, number>)[window]!;
  }
  return { query, minutes };
}
export function duration(value: string, maxDays: number): number {
  const parts = /^(\d+)(m|h|d)$/.exec(value.trim().toLowerCase());
  const minutes = parts ? Number(parts[1]) * ({ m: 1, h: 60, d: 1_440 }[parts[2]!]!) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > maxDays * 1_440) fail(`Use a positive duration such as 30m or 6h (maximum ${maxDays * 24}h).`);
  return minutes;
}
export function billingRange(input: ReportReadInput, now: Date): URLSearchParams {
  if (input.from !== undefined || input.to !== undefined) {
    if (input.window !== undefined) fail("Choose --window or --from/--to, not both.");
    const exact = (value: string | undefined): Date => {
      const normalized = value?.trim();
      const match = normalized?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|[+-](\d{2}):(\d{2}))$/);
      if (!normalized || !match) fail("Billing bounds require both ISO timestamps with Z or a numeric UTC offset.");
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      if (days === undefined || day < 1 || day > days || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59 || Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59) fail("Invalid billing UTC timestamp.");
      const date = new Date(normalized);
      if (!Number.isFinite(date.getTime())) fail("Invalid billing UTC timestamp.");
      return date;
    };
    const from = exact(input.from), to = exact(input.to);
    if (to <= from) fail("Billing --to must be after --from (exclusive upper bound).");
    return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  }
  const minutes = duration(input.window ?? "30d", 366);
  return new URLSearchParams({ from: new Date(now.getTime() - minutes * 60_000).toISOString(), to: now.toISOString() });
}
function orgPath(session: ManagementOptions): string { return `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}`; }
function ensureOrganization(expected: string, actual: string): void {
  if (actual !== expected) fail("Understudy returned a report for the wrong organization.");
}
function ensureProject(expected: string, actual: string): void {
  if (actual !== expected) fail("Understudy returned a report for the wrong project.");
}
function queryRecord(query: URLSearchParams): Record<string, string | string[]> {
  return Object.fromEntries([...new Set(query.keys())].map((key) => [key, query.getAll(key).length > 1 ? query.getAll(key) : query.get(key)!]));
}

export function createReportReads(options: ReadOptions = {}) {
  const auth = { store: options.authStore ?? createCredentialStore(), contextStore: options.contextStore, cwd: options.cwd, baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation };
  const read = <T>(session: ManagementOptions, path: string, schema: z.ZodType<T>) => requestManagementJson(session, { path, action: "Report", timeoutMs: 30_000 }, schema);
  const sessionFor = async (input: Pick<ReportReadInput, "org">) => {
    const session = await resolveManagementSession(auth);
    if (input.org !== undefined && input.org !== session.organizationId) fail("The selected organization does not match the authenticated organization.");
    return session;
  };
  return {
    async query(kind: "usage" | "errors" | "costs", input: ReportReadInput = {}): Promise<ScopedReport> {
      input = normalizeReportInput(input);
      const { query, minutes } = reportRange(input);
      const group = oneOf(input.groupBy ?? "workload", ["project", "workload", "model"], "grouping");
      const interval = oneOf(input.granularity ?? (minutes <= 2_880 ? "hour" : "day"), ["minute", "hour", "day"], "granularity");
      if ((interval === "minute" && minutes > 1_440) || (interval === "hour" && minutes > 44_640)) fail("Granularity exceeds its supported range: minute up to 24h, hour up to 31d.");
      if (kind === "errors" && input.excludeProject?.length) fail("Error reports do not support --exclude-project.");
      if ((input.excludeProject?.length ?? 0) > 20) fail("At most 20 excluded projects are supported.");
      query.set("group_by", group); query.set("granularity", interval);
      query.set("request_environment", environment(input.environment, kind === "errors" ? "production" : "all"));
      const { session, project, workload } = await resolveManagementScope(auth, input);
      if (project) query.set("project_id", project.id);
      if (workload) query.set("workload_id", workload.id);
      if (input.excludeProject?.length) {
        const projects = await listManagementProjects(session);
        for (const selector of input.excludeProject) {
          const found = projects.filter((item) => item.id === selector || item.slug === selector);
          if (found.length !== 1) fail("An excluded project does not uniquely belong to the authenticated organization.");
          if (found[0]!.id === project?.id) fail("The selected project cannot also be excluded.");
          if (!query.getAll("exclude_project_id").includes(found[0]!.id)) query.append("exclude_project_id", found[0]!.id);
        }
      }
      const endpoint = kind === "errors" ? "errors" : "reporting";
      const data = kind === "errors"
        ? await read(session, `${orgPath(session)}/${endpoint}?${query}`, errorsSchema)
        : await read(session, `${orgPath(session)}/${endpoint}?${query}`, reportingSchema);
      ensureOrganization(session.organizationId, data.org_id);
      if (data.filters.project_id !== (project?.id ?? null) || data.filters.workload_id !== (workload?.id ?? null) || data.group_by !== group || data.granularity !== interval || (data.filters.request_environment !== undefined && data.filters.request_environment !== query.get("request_environment"))) fail("Understudy returned a report for a different selection.");
      if (data.window !== (input.from ? "custom" : query.get("window"))) fail("Understudy returned a report for a different window.");
      if (input.from && (data.window_start !== day(input.from).toISOString() || data.window_end !== new Date(day(input.to).getTime() + 86_400_000).toISOString())) fail("Understudy returned different UTC report bounds.");
      const rows = "groups" in data ? [...data.groups, ...data.recent] : data.series;
      if (rows.some((row) => (project && row.project_id !== null && row.project_id !== project.id) || (workload && row.workload_id !== null && row.workload_id !== workload.id))) fail("Understudy returned rows outside the selected scope.");
      if ("exclude_project_ids" in data.filters && JSON.stringify([...data.filters.exclude_project_ids].sort()) !== JSON.stringify(query.getAll("exclude_project_id").sort())) fail("Understudy returned different excluded projects.");
      return { organizationId: session.organizationId, ...(project && { projectId: project.id }), ...(workload && { workloadId: workload.id }), request: queryRecord(query), data, ...(kind === "costs" && { pricingCoverage: "unavailable" as const }) };
    },
    async project(kind: ProjectReport, input: ReportReadInput = {}): Promise<ScopedReport> {
      input = normalizeReportInput(input);
      if (input.from || input.to || input.groupBy || input.granularity || input.excludeProject?.length) fail("This report supports a duration window and environment, not date ranges or grouping.");
      if (kind !== "cost-breakdown" && input.workload) fail("This report is project-wide; it does not accept --workload.");
      const window = (input.window ?? (kind === "providers" ? "30m" : kind === "cost-breakdown" ? "7d" : "24h")).trim().toLowerCase();
      duration(window, kind === "cost-breakdown" ? 30 : 1);
      if (kind !== "cost-breakdown" && !/^\d+[mh]$/.test(window)) fail("This endpoint accepts minutes or hours, up to 24h.");
      const query = new URLSearchParams({ window, request_environment: environment(input.environment, kind === "cost-breakdown" ? "all" : "production") });
      const { session, project, workload } = await resolveManagementScope(auth, { ...input, requireProject: true, ignoreWorkloadDefault: input.ignoreWorkloadDefault || kind !== "cost-breakdown" });
      if (!project) fail("Select a project with --project or context set.");
      if (kind === "cost-breakdown" && workload) query.set("workload_id", workload.id);
      const path = `${orgPath(session)}/projects/${encodeURIComponent(project.id)}/${kind === "providers" ? "provider-health" : kind}?${query}`;
      const data = kind === "providers" ? await read(session, path, providersSchema)
        : kind === "workload-status" ? await read(session, path, workloadStatusSchema) : await read(session, path, breakdownSchema);
      ensureProject(project.id, data.project_id);
      if (data.window !== window) fail("Understudy returned a report for a different window.");
      if (kind === "cost-breakdown" && "workload_id" in data && (data.workload_id !== (workload?.id ?? null) || (workload && data.workloads.some((row) => row.workload_id !== workload.id)))) fail("Understudy returned costs for a different workload.");
      return { organizationId: session.organizationId, projectId: project.id, ...(kind === "cost-breakdown" && workload && { workloadId: workload.id }), request: queryRecord(query), data };
    },
    async projectUsage(input: ReportReadInput = {}): Promise<ScopedReport> {
      input = normalizeReportInput(input);
      if (input.workload !== undefined || input.from !== undefined || input.to !== undefined || input.granularity !== undefined || input.excludeProject?.length) fail("Project usage supports a duration, grouping, and environment; it does not support workload or date-range filters.");
      const window = (input.window ?? "7d").trim().toLowerCase();
      duration(window, 30);
      const groups = (input.groupBy ?? "workload").split(",").map(value => value.trim()).filter(Boolean);
      if (!groups.length || new Set(groups).size !== groups.length || groups.some(value => !["workload", "model", "day"].includes(value))) fail("Usage --group-by must contain unique values from workload, model, and day.");
      const { session, project } = await resolveManagementScope(auth, { ...input, requireProject: true, ignoreWorkloadDefault: true });
      if (!project) fail("Select a project with --project or context set.");
      const query = new URLSearchParams({ window, group_by: groups.join(","), request_environment: environment(input.environment, "all") });
      const data = await read(session, `${orgPath(session)}/projects/${encodeURIComponent(project.id)}/usage-summary?${query}`, usageSummarySchema);
      ensureProject(project.id, data.project_id);
      if (data.window !== window || JSON.stringify(data.group_by) !== JSON.stringify(groups)) fail("Understudy returned project usage for a different selection.");
      if (data.groups.length >= 5_000) fail("The usage response reached the 5,000-group server limit and may be incomplete. Narrow --window or query fewer --group-by dimensions.");
      return { organizationId: session.organizationId, projectId: project.id, request: queryRecord(query), data, pricingCoverage: "unavailable" };
    },
    async cost(requestId: string, input: Pick<ReportReadInput, "org"> = {}): Promise<ScopedReport> {
      requestId = requestId.trim();
      if (!requestId || requestId.length > 256 || /[\u0000-\u0020]/.test(requestId)) fail("Provide a request or correlation ID of at most 256 characters.");
      const session = await sessionFor(input);
      const data = await read(session, `${orgPath(session)}/calls/${encodeURIComponent(requestId)}/cost`, costSchema);
      ensureOrganization(session.organizationId, data.org_id);
      return { organizationId: session.organizationId, projectId: data.project_id, workloadId: data.workload_id, request: { correlation_id: requestId }, data };
    },
    async billing(kind: BillingReport, input: ReportReadInput = {}): Promise<ScopedReport> {
      input = normalizeReportInput(input);
      if (input.project || input.workload || input.environment || input.groupBy || input.granularity || input.excludeProject?.length) fail("Billing reads are organization-wide and do not support resource or environment filters.");
      if (kind === "balance" && (input.window || input.from || input.to)) fail("Balance is a current ledger snapshot and does not accept a time window.");
      const query = kind === "balance" ? new URLSearchParams() : billingRange(input, (options.now ?? (() => new Date()))());
      const session = await sessionFor(input);
      const path = `${orgPath(session)}/billing/${kind}${query.size ? `?${query}` : ""}`;
      const data = kind === "balance" ? await read(session, path, balanceSchema)
        : kind === "summary" ? await read(session, path, billingSummarySchema)
        : kind === "trend" ? await read(session, path, billingTrendSchema) : await read(session, path, billingModelsSchema);
      if ("balance" in data) ensureOrganization(session.organizationId, data.balance.org_id);
      if ("summary" in data) {
        ensureOrganization(session.organizationId, data.summary.org_id);
        if (new Date(data.summary.from).getTime() !== new Date(query.get("from")!).getTime() || new Date(data.summary.to).getTime() !== new Date(query.get("to")!).getTime()) fail("Understudy returned different billing bounds.");
      }
      return { organizationId: session.organizationId, request: queryRecord(query), data, ...(kind !== "balance" && { pricingCoverage: "unavailable" as const }) };
    },
  };
}
