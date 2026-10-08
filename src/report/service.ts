import { z } from "zod";

import {
  createCredentialStore,
  type CredentialStore,
} from "../auth/credentials.js";
import {
  requestManagementJson,
  type ManagementOptions,
} from "../management/client.js";
import { resolveManagementSession } from "../management/session.js";
import { CliError } from "../errors.js";

export const defaultReportWindow = "24h" as const;
export const reportWindows = ["24h", "7d", "30d"] as const;
export type ReportWindow = (typeof reportWindows)[number];

const reportWindowSchema = z.enum(reportWindows);
// Organization reporting returns recorded cost but not a priced-request count.
// Keep that missing completeness signal explicit in every cost result.
const unavailablePricingCoverage = "unavailable" as const;
const healthStateSchema = z.enum([
  "healthy",
  "observing",
  "degraded",
  "idle",
  "unknown",
]);

const coverageSchema = z.object({
  source_timestamp: z.string().nullable(),
  data_completeness: z.number().min(0).max(1),
  known_gaps: z.array(z.string()),
});

const healthWindowSchema = z.object({
  state: healthStateSchema,
  window_minutes: z.number().int().positive(),
  window_start: z.string().min(1),
  window_end: z.string().min(1),
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  error_rate: z.number().min(0).max(1),
});

const healthResponseSchema = z.object({
  org_id: z.string().min(1),
  recent: healthWindowSchema,
  baseline: healthWindowSchema,
  workloads: z.array(
    z.object({
      project_id: z.string().min(1),
      project: z.string().min(1),
      workload_id: z.string().min(1),
      workload: z.string().min(1),
      state: healthStateSchema,
      requests: z.number().int().positive(),
      errors: z.number().int().nonnegative(),
      error_rate: z.number().min(0).max(1),
    }),
  ),
  active_workloads: z.number().int().nonnegative(),
  idle_workloads: z.number().int().nonnegative().nullable(),
  roster_available: z.boolean(),
  workloads_truncated: z.boolean(),
  coverage: coverageSchema,
  generated_at: z.string().min(1),
});

const usageTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  customer_cost_usd: z.number().nonnegative(),
});

const usageWorkloadRowSchema = usageTotalsSchema.extend({
  project_id: z.string().nullable(),
  project: z.string().nullable(),
  workload_id: z.string().nullable(),
  workload: z.string().nullable(),
});

const reportingResponseSchema = z.object({
  org_id: z.string().min(1),
  window: reportWindowSchema,
  window_start: z.string().min(1),
  window_end: z.string().min(1),
  group_by: z.literal("workload"),
  filters: z.object({
    project_id: z.null(),
    workload_id: z.null(),
    exclude_project_ids: z.array(z.string()).max(0),
  }),
  totals: usageTotalsSchema,
  series: z.array(usageWorkloadRowSchema),
  generated_at: z.string().min(1),
});

const reportingOptionsResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  workloads: z.array(
    z.object({
      id: z.string().min(1),
      project_id: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  generated_at: z.string().min(1),
});

const errorSourceSchema = z.object({
  upstream: z.number().int().nonnegative(),
  network: z.number().int().nonnegative(),
  edge: z.number().int().nonnegative(),
  unclassified: z.number().int().nonnegative(),
});

const errorStatusSchema = z.object({
  status_code: z.number().int(),
  count: z.number().int().nonnegative(),
});

const errorTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  error_rate: z.number().min(0).max(1),
  by_source: errorSourceSchema,
  by_status: z.array(errorStatusSchema),
});

const errorGroupSchema = z.object({
  project_id: z.string().nullable(),
  project: z.string().nullable(),
  workload_id: z.string().nullable(),
  workload: z.string().nullable(),
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  error_rate: z.number().min(0).max(1),
  last_error_at: z.string().nullable(),
});

const errorsResponseSchema = z.object({
  org_id: z.string().min(1),
  window: reportWindowSchema,
  window_start: z.string().min(1),
  window_end: z.string().min(1),
  group_by: z.literal("workload"),
  filters: z.object({
    project_id: z.null(),
    workload_id: z.null(),
  }),
  totals: errorTotalsSchema,
  groups: z.array(errorGroupSchema),
  coverage: coverageSchema,
  generated_at: z.string().min(1),
});

export interface Coverage {
  sourceTimestamp: string | null;
  dataCompleteness: number;
  knownGaps: string[];
}

export type HealthState = z.infer<typeof healthStateSchema>;

export interface HealthWindow {
  state: HealthState;
  windowMinutes: number;
  windowStart: string;
  windowEnd: string;
  requests: number;
  errors: number;
  errorRate: number;
}

export interface HealthWorkload {
  projectId: string;
  project: string;
  workloadId: string;
  workload: string;
  state: HealthState;
  requests: number;
  errors: number;
  errorRate: number;
}

export interface HealthReport {
  organizationId: string;
  recent: HealthWindow;
  baseline: HealthWindow;
  workloads: HealthWorkload[];
  activeWorkloads: number;
  idleWorkloads: number | null;
  rosterAvailable: boolean;
  workloadsTruncated: boolean;
  coverage: Coverage;
  generatedAt: string;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageWorkload extends UsageTotals {
  projectId: string | null;
  project: string | null;
  workloadId: string | null;
  workload: string;
}

export interface UsageReport {
  organizationId: string;
  window: ReportWindow;
  windowStart: string;
  windowEnd: string;
  totals: UsageTotals;
  workloads: UsageWorkload[];
  generatedAt: string;
}

export interface CostWorkload {
  projectId: string | null;
  project: string | null;
  workloadId: string | null;
  workload: string;
  requests: number;
  recordedCustomerCostUsd: number;
}

export interface CostReport {
  organizationId: string;
  window: ReportWindow;
  windowStart: string;
  windowEnd: string;
  recordedCustomerCostUsd: number;
  pricingCoverage: typeof unavailablePricingCoverage;
  workloads: CostWorkload[];
  generatedAt: string;
}

export interface ErrorSourceCounts {
  upstream: number;
  network: number;
  edge: number;
  unclassified: number;
}

export interface ErrorStatusCount {
  statusCode: number;
  count: number;
}

export interface ErrorTotals {
  requests: number;
  errors: number;
  errorRate: number;
  bySource: ErrorSourceCounts;
  byStatus: ErrorStatusCount[];
}

export interface ErrorWorkload {
  projectId: string | null;
  project: string;
  workloadId: string | null;
  workload: string;
  requests: number;
  errors: number;
  errorRate: number;
  lastErrorAt: string | null;
}

export interface ErrorReport {
  organizationId: string;
  window: ReportWindow;
  windowStart: string;
  windowEnd: string;
  totals: ErrorTotals;
  workloads: ErrorWorkload[];
  coverage: Coverage;
  generatedAt: string;
}

export interface ReportSummary {
  organizationId: string;
  window: ReportWindow;
  health: {
    state: HealthState;
    windowMinutes: number;
    requests: number;
    errors: number;
    errorRate: number;
    activeWorkloads: number;
    idleWorkloads: number | null;
    coverage: Coverage;
  };
  usage: UsageTotals;
  errors: ErrorTotals & { coverage: Coverage };
  costs: {
    recordedCustomerCostUsd: number;
    pricingCoverage: typeof unavailablePricingCoverage;
  };
}

interface ReportServiceOptions {
  authStore?: CredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

export interface ReportService {
  summary(window?: string): Promise<ReportSummary>;
  health(): Promise<HealthReport>;
  usage(window?: string): Promise<UsageReport>;
  errors(window?: string): Promise<ErrorReport>;
  costs(window?: string): Promise<CostReport>;
}

export function parseReportWindow(
  value: string = defaultReportWindow,
): ReportWindow {
  const parsed = reportWindowSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("Invalid window. Use 24h, 7d, or 30d.");
  }
  return parsed.data;
}

export function createReportService(
  options: ReportServiceOptions = {},
): ReportService {
  const store = options.authStore ?? createCredentialStore();
  const sessionOptions = {
    store,
    baseUrl: options.baseUrl,
    fetchImplementation: options.fetchImplementation,
  };

  return {
    async summary(value = defaultReportWindow) {
      const window = parseReportWindow(value);
      const session = await resolveManagementSession(sessionOptions);
      const [health, reporting, errors] = await Promise.all([
        readHealth(session),
        readReporting(session, window),
        readErrors(session, window),
      ]);
      const usage = normalizeUsage(reporting);
      const errorReport = normalizeErrors(errors);
      assertSameOrganization(
        session.organizationId,
        health.organizationId,
        usage.organizationId,
        errorReport.organizationId,
      );
      return {
        organizationId: session.organizationId,
        window,
        health: {
          state: health.recent.state,
          windowMinutes: health.recent.windowMinutes,
          requests: health.recent.requests,
          errors: health.recent.errors,
          errorRate: health.recent.errorRate,
          activeWorkloads: health.activeWorkloads,
          idleWorkloads: health.idleWorkloads,
          coverage: health.coverage,
        },
        usage: usage.totals,
        errors: { ...errorReport.totals, coverage: errorReport.coverage },
        costs: {
          recordedCustomerCostUsd: reporting.totals.customer_cost_usd,
          pricingCoverage: unavailablePricingCoverage,
        },
      };
    },

    async health() {
      const session = await resolveManagementSession(sessionOptions);
      const health = await readHealth(session);
      assertSameOrganization(session.organizationId, health.organizationId);
      return health;
    },

    async usage(value = defaultReportWindow) {
      const window = parseReportWindow(value);
      const session = await resolveManagementSession(sessionOptions);
      const [reporting, options] = await Promise.all([
        readReporting(session, window),
        readReportingOptions(session),
      ]);
      const usage = normalizeUsage(reporting, options);
      assertSameOrganization(session.organizationId, usage.organizationId);
      return usage;
    },

    async errors(value = defaultReportWindow) {
      const window = parseReportWindow(value);
      const session = await resolveManagementSession(sessionOptions);
      const errors = normalizeErrors(await readErrors(session, window));
      assertSameOrganization(session.organizationId, errors.organizationId);
      return errors;
    },

    async costs(value = defaultReportWindow) {
      const window = parseReportWindow(value);
      const session = await resolveManagementSession(sessionOptions);
      const [reporting, options] = await Promise.all([
        readReporting(session, window),
        readReportingOptions(session),
      ]);
      const costs = normalizeCosts(reporting, options);
      assertSameOrganization(session.organizationId, costs.organizationId);
      return costs;
    },
  };
}

async function readHealth(options: ManagementOptions): Promise<HealthReport> {
  const response = await requestManagementJson(
    options,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/request-logs/health-summary`,
      action: "Health report",
      invalidResponseMessage:
        "Understudy returned an invalid health report. Try again shortly.",
    },
    healthResponseSchema,
  );

  return {
    organizationId: response.org_id,
    recent: normalizeHealthWindow(response.recent),
    baseline: normalizeHealthWindow(response.baseline),
    workloads: response.workloads.map((workload) => ({
      projectId: workload.project_id,
      project: workload.project,
      workloadId: workload.workload_id,
      workload: workload.workload,
      state: workload.state,
      requests: workload.requests,
      errors: workload.errors,
      errorRate: workload.error_rate,
    })),
    activeWorkloads: response.active_workloads,
    idleWorkloads: response.idle_workloads,
    rosterAvailable: response.roster_available,
    workloadsTruncated: response.workloads_truncated,
    coverage: normalizeCoverage(response.coverage),
    generatedAt: response.generated_at,
  };
}

async function readReporting(
  options: ManagementOptions,
  window: ReportWindow,
): Promise<z.infer<typeof reportingResponseSchema>> {
  const response = await requestManagementJson(
    options,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/reporting?window=${window}&group_by=workload`,
      action: "Usage report",
      invalidResponseMessage:
        "Understudy returned an invalid usage report. Try again shortly.",
    },
    reportingResponseSchema,
  );
  if (response.window !== window) {
    throw new CliError(
      "Understudy returned an invalid usage report. Try again shortly.",
    );
  }
  return response;
}

async function readReportingOptions(
  options: ManagementOptions,
): Promise<z.infer<typeof reportingOptionsResponseSchema>> {
  return requestManagementJson(
    options,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/reporting/options`,
      action: "Reporting options",
      invalidResponseMessage:
        "Understudy returned invalid reporting options. Try again shortly.",
    },
    reportingOptionsResponseSchema,
  );
}

async function readErrors(
  options: ManagementOptions,
  window: ReportWindow,
): Promise<z.infer<typeof errorsResponseSchema>> {
  const response = await requestManagementJson(
    options,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/errors?window=${window}&group_by=workload`,
      action: "Error report",
      invalidResponseMessage:
        "Understudy returned an invalid error report. Try again shortly.",
    },
    errorsResponseSchema,
  );
  if (response.window !== window) {
    throw new CliError(
      "Understudy returned an invalid error report. Try again shortly.",
    );
  }
  return response;
}

function normalizeHealthWindow(
  window: z.infer<typeof healthWindowSchema>,
): HealthWindow {
  return {
    state: window.state,
    windowMinutes: window.window_minutes,
    windowStart: window.window_start,
    windowEnd: window.window_end,
    requests: window.requests,
    errors: window.errors,
    errorRate: window.error_rate,
  };
}

function normalizeCoverage(
  coverage: z.infer<typeof coverageSchema>,
): Coverage {
  return {
    sourceTimestamp: coverage.source_timestamp,
    dataCompleteness: coverage.data_completeness,
    knownGaps: [...coverage.known_gaps],
  };
}

function normalizeUsage(
  response: z.infer<typeof reportingResponseSchema>,
  options?: z.infer<typeof reportingOptionsResponseSchema>,
): UsageReport {
  const workloads = enrichWorkloadMetadata(
    aggregateUsageWorkloads(response.series),
    options,
  );
  return {
    organizationId: response.org_id,
    window: response.window,
    windowStart: response.window_start,
    windowEnd: response.window_end,
    totals: normalizeUsageTotals(response.totals),
    workloads: workloads.map((workload) => ({
      projectId: workload.projectId,
      project: workload.projectName,
      workloadId: workload.workloadId,
      workload: displayName(workload.workloadName, workload.workloadId),
      ...workload.usage,
    })),
    generatedAt: response.generated_at,
  };
}

function normalizeCosts(
  response: z.infer<typeof reportingResponseSchema>,
  options?: z.infer<typeof reportingOptionsResponseSchema>,
): CostReport {
  const workloads = enrichWorkloadMetadata(
    aggregateUsageWorkloads(response.series),
    options,
  );
  return {
    organizationId: response.org_id,
    window: response.window,
    windowStart: response.window_start,
    windowEnd: response.window_end,
    recordedCustomerCostUsd: response.totals.customer_cost_usd,
    pricingCoverage: unavailablePricingCoverage,
    workloads: workloads.map((workload) => ({
      projectId: workload.projectId,
      project: workload.projectName,
      workloadId: workload.workloadId,
      workload: displayName(workload.workloadName, workload.workloadId),
      requests: workload.usage.requests,
      recordedCustomerCostUsd: workload.recordedCustomerCostUsd,
    })),
    generatedAt: response.generated_at,
  };
}

function normalizeUsageTotals(
  totals: z.infer<typeof usageTotalsSchema>,
): UsageTotals {
  return {
    requests: totals.requests,
    inputTokens: totals.input_tokens,
    cacheReadInputTokens: totals.cache_read_input_tokens,
    cacheCreationInputTokens: totals.cache_creation_input_tokens,
    outputTokens: totals.output_tokens,
    totalTokens: totals.total_tokens,
  };
}

interface AggregatedWorkload {
  projectId: string | null;
  projectName: string | null;
  workloadId: string | null;
  workloadName: string | null;
  usage: UsageTotals;
  recordedCustomerCostUsd: number;
}

function aggregateUsageWorkloads(
  rows: readonly z.infer<typeof usageWorkloadRowSchema>[],
): AggregatedWorkload[] {
  const workloads = new Map<string, AggregatedWorkload>();
  for (const row of rows) {
    const projectId = normalizeIdentifier(row.project_id);
    const projectName = normalizeIdentifier(row.project);
    const workloadId = normalizeIdentifier(row.workload_id);
    const workloadName = normalizeIdentifier(row.workload);
    const key =
      workloadId === null
        ? JSON.stringify([
            projectId === null
              ? ["name", projectName]
              : ["id", projectId],
            ["workload-name", workloadName],
          ])
        : JSON.stringify(["workload-id", workloadId]);
    const existing = workloads.get(key);
    if (
      existing !== undefined &&
      existing.projectId !== null &&
      projectId !== null &&
      existing.projectId !== projectId
    ) {
      throw new CliError(
        "Understudy returned an invalid usage report. Try again shortly.",
      );
    }
    const current = existing ?? {
      projectId,
      projectName,
      workloadId,
      workloadName,
      usage: emptyUsageTotals(),
      recordedCustomerCostUsd: 0,
    };
    current.projectId ??= projectId;
    current.projectName ??= projectName;
    current.workloadName ??= workloadName;
    current.usage.requests += row.requests;
    current.usage.inputTokens += row.input_tokens;
    current.usage.cacheReadInputTokens += row.cache_read_input_tokens;
    current.usage.cacheCreationInputTokens += row.cache_creation_input_tokens;
    current.usage.outputTokens += row.output_tokens;
    current.usage.totalTokens += row.total_tokens;
    current.recordedCustomerCostUsd += row.customer_cost_usd;
    workloads.set(key, current);
  }
  return [...workloads.values()];
}

function enrichWorkloadMetadata(
  workloads: readonly AggregatedWorkload[],
  options?: z.infer<typeof reportingOptionsResponseSchema>,
): AggregatedWorkload[] {
  if (options === undefined) return [...workloads];

  const projects = uniqueById(options.projects);
  const workloadOptions = uniqueById(options.workloads);
  return workloads.map((workload) => {
    if (workload.workloadId === null) return workload;

    const option = workloadOptions.get(workload.workloadId);
    if (
      option === undefined ||
      option === null ||
      (workload.projectId !== null && workload.projectId !== option.project_id)
    ) {
      return workload;
    }

    const project = projects.get(option.project_id);
    return {
      ...workload,
      projectId: workload.projectId ?? option.project_id,
      projectName:
        workload.projectName ?? (project === null ? null : project?.name ?? null),
      workloadName: workload.workloadName ?? option.name,
    };
  });
}

function uniqueById<T extends { id: string }>(
  values: readonly T[],
): Map<string, T | null> {
  const unique = new Map<string, T | null>();
  for (const value of values) {
    unique.set(value.id, unique.has(value.id) ? null : value);
  }
  return unique;
}

function emptyUsageTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function normalizeErrors(
  response: z.infer<typeof errorsResponseSchema>,
): ErrorReport {
  return {
    organizationId: response.org_id,
    window: response.window,
    windowStart: response.window_start,
    windowEnd: response.window_end,
    totals: {
      requests: response.totals.requests,
      errors: response.totals.errors,
      errorRate: response.totals.error_rate,
      bySource: { ...response.totals.by_source },
      byStatus: response.totals.by_status.map((status) => ({
        statusCode: status.status_code,
        count: status.count,
      })),
    },
    workloads: response.groups.map((workload) => ({
      projectId: normalizeIdentifier(workload.project_id),
      project: displayName(workload.project, workload.project_id),
      workloadId: normalizeIdentifier(workload.workload_id),
      workload: displayName(workload.workload, workload.workload_id),
      requests: workload.requests,
      errors: workload.errors,
      errorRate: workload.error_rate,
      lastErrorAt: workload.last_error_at,
    })),
    coverage: normalizeCoverage(response.coverage),
    generatedAt: response.generated_at,
  };
}

function normalizeIdentifier(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function displayName(value: string | null, fallback: string | null): string {
  return (
    normalizeIdentifier(value) ??
    normalizeIdentifier(fallback) ??
    "unattributed"
  );
}

function assertSameOrganization(
  expected: string,
  ...actual: readonly string[]
): void {
  if (actual.some((organizationId) => organizationId !== expected)) {
    throw new CliError("Understudy returned a report for the wrong organization.");
  }
}
