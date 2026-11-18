import { z } from "zod";

import { CliError } from "../errors.js";

// Customer read contracts for experiments and evaluators. These mirror the
// platform's /customer/v1 projections. Unknown fields are stripped so the
// CLI output contract changes only when this file does.

const idSchema = z.string().min(1).max(256);
const countSchema = z.number().int().nonnegative();

export const experimentStatusSchema = z.enum(["draft", "active", "stopped"]);

export const experimentSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  status: experimentStatusSchema,
  request_environment: z.string().min(1),
  target_tag: z.string().nullable(),
  target_values: z.array(z.string()).nullable(),
  control_model: z.string().min(1),
  candidate_model: z.string().min(1),
  candidate_percent: z.number().int().min(0).max(100),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
  project_id: idSchema,
  project_slug: z.string().min(1),
  project_name: z.string().min(1),
  workload_id: idSchema,
  // null when the workload was deleted; the experiment is stopped but kept.
  workload_name: z.string().min(1).nullable(),
}).refine((value) => (value.target_tag === null) === (value.target_values === null));

export const experimentListSchema = z.object({ experiments: z.array(experimentSchema) });

export type Experiment = z.infer<typeof experimentSchema>;

const rubricSchema = z.object({
  name: z.string().min(1).max(40),
  implementation: z.literal("deterministic").optional(),
  pass_when: z.string().min(1),
  fail_when: z.string().min(1),
  na_when: z.string().min(1).optional(),
  check: z.record(z.string(), z.unknown()).optional(),
}).refine((rubric) => (rubric.implementation === undefined) === (rubric.check === undefined));

export const evaluatorSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  status: z.enum(["draft", "active", "paused"]),
  score_from: z.string().min(1),
  project_id: idSchema,
  project_name: z.string(),
  project_slug: z.string(),
  workload_id: idSchema,
  workload_name: z.string(),
  version: z.object({
    id: idSchema,
    version: z.number().int().min(1),
    // null when every rubric is a code check.
    judge_model: z.string().min(1).nullable(),
    rubrics: z.array(rubricSchema).min(1),
  }),
});

export type Evaluator = z.infer<typeof evaluatorSchema>;

export const intervalSchema = z.object({ value: z.number(), low: z.number(), high: z.number() });
export type Interval = z.infer<typeof intervalSchema>;

const rubricStatsSchema = z.object({
  rubric: z.string().min(1),
  pass: countSchema,
  fail: countSchema,
  na: countSchema,
  pass_rate: z.number().nullable(),
});

export const evaluatorListSchema = z.object({
  evaluators: z.array(evaluatorSchema.extend({
    stats: z.object({
      traces_judged: countSchema,
      rated_traces: countSchema,
      passed_traces: countSchema,
      trace_pass_rate: intervalSchema.nullable(),
      rubrics: z.array(rubricStatsSchema),
      recent: z.array(z.object({ day: z.string().min(1), rate: z.number().nullable() })).default([]),
    }),
  })),
});

export type EvaluatorListRow = z.infer<typeof evaluatorListSchema>["evaluators"][number];

export const evaluatorDetailSchema = z.object({
  evaluator: evaluatorSchema,
  experiments: z.array(z.object({
    id: idSchema,
    name: z.string().min(1),
    status: experimentStatusSchema,
    control_model: z.string().min(1),
    candidate_model: z.string().min(1),
  })),
});

export const summaryStatsSchema = z.object({
  traces_judged: countSchema,
  skips: z.record(z.string(), countSchema),
  rated_traces: countSchema,
  passed_traces: countSchema,
  trace_pass_rate: intervalSchema.nullable(),
  priced_traces: countSchema,
  unpriced_traces: countSchema,
  cost_per_trace_usd: z.number().nullable(),
  rubrics: z.array(rubricStatsSchema),
});

export type SummaryStats = z.infer<typeof summaryStatsSchema>;

export const summarySchema = z.object({
  evaluator_id: idSchema,
  evaluator_version_id: idSchema,
  version: z.number().int().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  total: summaryStatsSchema,
  by_day: z.array(summaryStatsSchema.extend({ day: z.string().min(1) })),
  by_day_model: z.array(z.object({
    day: z.string().min(1),
    model: z.string(),
    rated_traces: countSchema,
    passed_traces: countSchema,
  })).default([]),
  by_model: z.array(summaryStatsSchema.extend({ model: z.string() })),
  by_variant: z.array(summaryStatsSchema.extend({
    experiment_id: z.string().nullable(),
    variant: z.string().nullable(),
  })),
  variant_differences: z.array(z.object({
    experiment_id: z.string().min(1),
    candidate_minus_control: intervalSchema.nullable(),
  })),
});

export type Summary = z.infer<typeof summarySchema>;

export const scoreListSchema = z.object({
  evaluator_version_id: idSchema,
  scores: z.array(z.object({
    request_id: idSchema,
    trace_ended_at: z.string().min(1),
    model: z.string(),
    rubric: z.string().min(1),
    verdict: z.enum(["pass", "fail", "na"]),
    reason: z.string().nullable(),
  })),
  next_cursor: z.string().min(1).nullable(),
});

/** A group needs this many rated traces before the platform reports a rate. */
export const minimumRatedTraces = 30;
/** The widest summary and scores range the customer API accepts. */
export const maxRangeDays = 90;
/** The platform's default range when `from` is omitted. */
export const defaultRangeDays = 30;
const dayMs = 86_400_000;

export function resourceId(value: string, label: string): string {
  if (!value.trim() || value.length > 256 || /[\u0000-\u001f\u007f�/?#]/.test(value)) {
    throw new CliError(`Invalid ${label} id.`);
  }
  return value.trim();
}

/** Accept an ISO date or datetime and normalize it to the UTC instant the API accepts. */
export function instant(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new CliError(`${label} must be an ISO date (2030-01-31) or UTC datetime (2030-01-31T12:00:00Z).`);
  }
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(parsed)) throw new CliError(`${label} is not a valid date.`);
  return new Date(parsed).toISOString();
}

export interface Range { from?: string; to?: string }

/** Validate a range against the platform defaults (last 30 days, at most 90). */
export function scoreRange(input: Range, now = Date.now()): Range {
  const from = input.from === undefined ? undefined : instant(input.from, "--from");
  const to = input.to === undefined ? undefined : instant(input.to, "--to");
  const effectiveTo = to === undefined ? now : Date.parse(to);
  const effectiveFrom = from === undefined ? effectiveTo - defaultRangeDays * dayMs : Date.parse(from);
  if (effectiveFrom >= effectiveTo) throw new CliError("--from must be before --to.");
  if (effectiveTo - effectiveFrom > maxRangeDays * dayMs) {
    throw new CliError(`The range can span at most ${maxRangeDays} days.`);
  }
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

export function rangeQuery(range: Range): string {
  const query = new URLSearchParams();
  if (range.from) query.set("from", range.from);
  if (range.to) query.set("to", range.to);
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function customerPath(organizationId: string, ...segments: string[]): string {
  return `/customer/v1/orgs/${encodeURIComponent(organizationId)}/${segments.map(encodeURIComponent).join("/")}`;
}

export function assertUniqueIds(rows: readonly { id: string }[], resource: string): void {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new CliError(`Understudy returned a ${resource} listing with repeated ids.`);
  }
}

export const oauthOnlyMessage =
  "Experiment and evaluator reads require browser OAuth as an organization member. Run `understudy login`.";
