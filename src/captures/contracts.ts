import { z } from "zod";

const text = z.string();
const tags = z.custom<Record<string, string>>(value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(item => typeof item === "string");
}, "Capture tags must be a string map.").transform(value => Object.fromEntries(Object.entries(value)));
// Captures are customer-visible envelopes, never raw supplier diagnostics.
// Payload strings and caller tags are deliberately opaque customer content.
export const captureSchema = z.object({
  schema_version: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  request_id: text.min(1), workos_org_id: text.min(1), project_id: text.min(1),
  workload_id: text.optional(), placement_id: text.optional(), workload_name: text.optional(), workos_api_key_id: text.optional(),
  request_environment: text.optional(), ts: text, customer_request_body: text, response_body: text,
  mode: z.enum(["byo", "managed"]), provider: z.enum(["managed", "anthropic", "openai"]), requested_model: text.optional(),
  upstream_model: text.nullable().optional(), public_served_model: text.optional(), upstream_request_body: text.nullable().optional(),
  endpoint: text.optional(), status_code: z.number().int().optional(), latency_ms: z.number().optional(), response_source: text.optional(),
  trace_id: text.nullable().optional(), caller_span_id: text.nullable().optional(), trace_context_status: z.enum(["absent", "valid", "invalid"]).optional(), trace_flags: text.nullable().optional(),
  dataset_tag: text.nullable().optional(), end_user_id: text.nullable().optional(), tags: tags.nullable().optional(),
}).refine(capture => capture.mode !== "managed" || (capture.upstream_request_body == null && capture.provider === "managed"), "Managed capture projection contains an upstream request.");
export const listingSchema = z.object({
  captures: z.array(z.object({ key: text, request_id: text, workos_org_id: text, workos_api_key_id: text.optional(), size: z.number().nonnegative(), uploaded: text })),
  truncated: z.boolean(), cursor: text.nullable().optional(), skipped_malformed: z.number().int().nonnegative().optional(), scanned_through: text.optional(),
});
export function summarizeCapture(capture: z.infer<typeof captureSchema>) {
  return {
    request_id: capture.request_id, trace_id: capture.trace_id ?? null, schema_version: capture.schema_version,
    ts: capture.ts, project_id: capture.project_id, workload_id: capture.workload_id ?? capture.placement_id ?? null,
    mode: capture.mode, provider: capture.provider, endpoint: capture.endpoint ?? null, request_environment: capture.request_environment ?? "production",
    requested_model: capture.requested_model ?? null, upstream_model: capture.upstream_model ?? null, public_served_model: capture.public_served_model ?? null,
    status_code: capture.status_code ?? null, latency_ms: capture.latency_ms ?? null,
    tags: { count: Object.keys(capture.tags ?? {}).length, keys: Object.keys(capture.tags ?? {}).sort() },
    customer_request_body: Boolean(capture.customer_request_body), upstream_request_body: Boolean(capture.upstream_request_body), response_body: Boolean(capture.response_body),
  };
}
