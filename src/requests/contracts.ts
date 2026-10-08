import { z } from "zod";
import { costSchema, coverage } from "../report/contracts.js";

// Explicit customer projections: unknown server fields never enter CLI output.
const text = z.string(), count = z.number().int().nonnegative();
const provider = z.enum(["managed", "anthropic", "openai"]);
const captureState = z.enum(["disabled", "expected", "unknown"]);
const reason = z.enum(["usage_limit_exceeded", "rate_limited", "customer_request", "provider_auth", "provider_unavailable", "provider_timeout", "provider_stream", "network_error", "gateway_error", "unknown"]);
const rejection = z.object({
  code: z.enum(["invalid_project_header", "invalid_workload_header", "workload_not_found", "workload_lookup_failed", "workload_bootstrap_failed", "invalid_tags", "invalid_json", "routing_rejected", "managed_mode_required", "bad_request"]),
  stage: z.enum(["workload", "request", "route", "responses"]), requested_project: text.optional(), requested_workload: text.optional(),
});
export const requestRowSchema = z.object({
  request_id: text.length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  ts: text, project_id: text, project: text.nullable(), workload_id: text, workload: text.nullable(),
  trace_id: text.length(32).regex(/^[0-9a-f]{32}$/).refine(value => !/^0+$/.test(value)).nullable(),
  caller_span_id: text.length(16).regex(/^[0-9a-f]{16}$/).nullable(), trace_context_status: z.enum(["absent", "valid", "invalid"]),
  request_environment: text.optional(), request_rejection: rejection.optional(), endpoint: text, is_streaming: z.boolean(),
  provider: provider.nullable(), requested_model: text, served_model: text, route_taken: text,
  status_code: z.number().int(), outcome: text, error_source: z.enum(["upstream", "network", "edge", "unclassified"]).nullable(),
  error_reason: reason, error_reason_covered: z.boolean(), error_retryable: z.boolean().nullable(), fallback_used: z.boolean(),
  tokens: z.object({ input_tokens: count, output_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, reasoning_output_tokens: count }),
  total_ms: z.number(), upstream_ttfb_ms: z.number(), capture_state: captureState, retry_count: count.nullable(), retry_wait_ms: count.nullable(),
});
const selection = z.object({
  request_environment: text.optional(), project_id: text.nullable(), workload_id: text.nullable(),
  outcome: z.enum(["success", "error"]).nullable(), status_code: z.number().int().nullable(), error_reason: reason.nullable(),
  provider: provider.nullable(), requested_model: text.nullable(), served_model: text.nullable(), route: text.nullable(), capture_state: captureState.nullable(),
});
const snapshot = { org_id: text, snapshot_watermark: text, coverage, generated_at: text };
export const feedSchema = z.object({ ...snapshot, window: z.enum(["10m", "1h", "6h", "24h", "7d"]), window_start: text, window_end: text, filters: selection, calls: z.array(requestRowSchema), next_cursor: text.min(1).nullable() });
export const traceSchema = z.object({ ...snapshot, trace_id: text, groups: z.array(z.object({ project_id: text, project: text.nullable(), total_count: count, captured_count: count, calls: z.array(requestRowSchema) })), next_cursor: text.min(1).nullable() });
export const detailSchema = z.object({
  org_id: text, call: requestRowSchema, cost: costSchema.extend({ provider: provider.nullable() }).nullable(),
  cost_section: z.discriminatedUnion("status", [z.object({ status: z.literal("available"), error: z.null() }), z.object({ status: z.literal("unavailable"), error: z.object({ code: z.literal("cost_query_failed"), request_id: text }) })]),
  payload_capability: z.object({ allowed: z.boolean(), credential_class: z.enum(["authkit_member", "org_api_key"]) }), coverage, generated_at: text,
});
const dimension = z.object({ groups: z.array(z.object({ key: text, requests: count, errors: count, first_observed_at: text.nullable(), last_observed_at: text.nullable() })), other_count: count, total_distinct: count });
export const failureSchema = z.object({ ...snapshot, window_start: text, window_end: text, requests: count, errors: count, error_rate: z.number().min(0).max(1), state: z.enum(["healthy", "observing", "degraded", "idle", "unknown"]), dominant_error_reason: reason.nullable(), reasons: dimension, workloads: dimension, providers: dimension, models: dimension });
