import { z } from "zod";

const text = z.string();
const count = z.number().int().nonnegative();
const amount = z.number();
const provider = z.enum(["anthropic", "openai", "managed"]);
export const coverage = z.object({ source_timestamp: text.nullable(), data_completeness: z.number().min(0).max(1), known_gaps: z.array(text) });
const tokens = z.object({ input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count, reasoning_output_tokens: count });
const dollars = z.object({ uncached_input_usd: amount, cache_write_usd: amount, cache_read_usd: amount, output_usd: amount });
const range = { window: text, window_start: text, window_end: text, generated_at: text };
const dimensions = { project_id: text.nullable(), project: text.nullable(), workload_id: text.nullable(), workload: text.nullable(), model: text.nullable() };
const usage = z.object({ requests: count, input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count, total_tokens: count, customer_cost_usd: amount });
const selection = z.object({ project_id: text.nullable(), workload_id: text.nullable(), request_environment: text.optional() });
const grouping = z.enum(["project", "workload", "model"]);
const granularity = z.enum(["minute", "hour", "day"]);

export const reportingSchema = z.object({
  org_id: text, ...range, group_by: grouping, granularity,
  filters: selection.extend({ exclude_project_ids: z.array(text) }),
  totals: usage, series: z.array(usage.extend({ ...dimensions, bucket: text })),
});
export const usageSummarySchema = z.object({
  project_id: text, ...range, group_by: z.array(z.enum(["workload", "model", "day"])),
  groups: z.array(z.object({
    workload_id: text.nullable(), workload: text.nullable(), model: text.nullable(), day: text.nullable(),
    requests: count, input_tokens: count, output_tokens: count, cache_read_input_tokens: count,
    cache_creation_input_tokens: count, cache_read_pct: z.number().min(0).max(1),
    customer_cost_usd: amount, error_rate: z.number().min(0).max(1),
  })),
});
const sources = z.object({ upstream: count, network: count, edge: count, unclassified: count });
export const errorsSchema = z.object({
  org_id: text, ...range, group_by: grouping, granularity, filters: selection,
  totals: z.object({ requests: count, errors: count, error_rate: amount, by_source: sources, by_status: z.array(z.object({ status_code: count, count })) }),
  series: z.array(z.object({ bucket: text, errors: count, by_source: sources })),
  groups: z.array(z.object({ ...dimensions, requests: count, errors: count, error_rate: amount, last_error_at: text.nullable() })),
  recent: z.array(z.object({ request_id: text, ts: text, project_id: text, project: text.nullable(), workload_id: text, workload: text.nullable(), provider, requested_model: text, served_model: text, route_taken: text, status_code: count, error_source: text, total_ms: amount, captured: z.boolean() })),
  recent_limit: count, coverage,
});
export const costSchema = z.object({
  org_id: text, request_id: text, ts: text, project_id: text, workload_id: text,
  provider, served_model: text, tokens, pricing_status: z.enum(["priced", "unpriced"]),
  unpriced_reason: z.enum(["usage_not_parsed", "pricing_pending"]).nullable(),
  customer_cost_usd: amount.nullable(), cost_categories: dollars.nullable(), coverage, generated_at: text,
});
export const breakdownSchema = z.object({
  project_id: text, workload_id: text.nullable(), ...range,
  workloads: z.array(z.object({ workload_id: text, workload: text.nullable(), requests: count, priced_requests: count, cost: dollars.extend({ total_usd: amount }) })),
  totals: dollars.extend({ total_usd: amount, requests: count, priced_requests: count }), coverage,
});
export const providersSchema = z.object({
  project_id: text, ...range, total_requests: count, total_errors: count,
  providers: z.array(z.object({ provider, workload: text, model: text, request_count: count, error_5xx_count: count, error_5xx_rate: amount, timeout_count: count, fallback_count: count, last_failing_at: text.nullable(), example_request_ids: z.array(text) })),
});
const health = z.enum(["healthy", "degraded", "idle"]);
export const workloadStatusSchema = z.object({
  project_id: text, ...range, workload_count: count,
  workloads: z.array(z.object({
    workload_id: text, display_name: text, status: health,
    recent: z.object({ window_minutes: count, requests: count, errors: count, error_rate: amount, status: health }),
    mode: provider.nullable(), declared: z.object({ routed: z.enum(["pin", "steer", "none"]), split_pct: z.number().min(0).max(100) }),
    requests: count, route_shares: z.object({ primary: amount, understudy: amount, fallback: amount }), error_rate: amount, last_error_at: text.nullable(), example_request_ids: z.array(text),
    served_models: z.array(z.object({ model: text, provider_label: provider, requests: count, share: amount })), rerouted_pct: amount,
  })),
});

const billingTokens = tokens.extend({ total_tokens: count });
export const balanceSchema = z.object({ balance: z.object({
  org_id: text, billing_mode: z.enum(["prepaid", "postpaid"]), status: z.enum(["active", "warning", "suspended", "delinquent"]),
  balance_usd: amount, currency: text, low_balance_threshold_usd: amount,
  grants: z.object({ total_granted_usd: amount, total_remaining_usd: amount, soonest_expiry: text.nullable() }),
}) });
export const billingSummarySchema = z.object({ summary: z.object({
  org_id: text, from: text, to: text, tokens: billingTokens, metered_requests: count, priced_events: count, estimated_cost_usd: amount, blended_price_per_mtok: amount,
}) });
export const billingModelsSchema = z.object({ rows: z.array(z.object({ provider, served_model: text, requests: count, tokens: billingTokens, cost_usd: amount })) });
export const billingTrendSchema = z.object({ points: z.array(z.object({ day: text, tokens: billingTokens, cost_usd: amount })) });
