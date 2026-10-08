import { Command } from "commander";
import { CliError } from "../errors.js";

export interface RequestQuery {
  org?: string; project?: string; workload?: string; environment?: string; window?: string;
  outcome?: string; statusCode?: string | number; errorReason?: string; provider?: string;
  requestedModel?: string; servedModel?: string; route?: string; captureState?: string;
  windowStart?: string; windowEnd?: string; snapshotWatermark?: string;
  retries?: number | string; includeRejectionDetails?: boolean; limit?: string | number; cursor?: string; all?: boolean;
}
export const windows: Record<string, number> = { "10m": 600000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
export function textFilter(value: string, label: string, max = 255): string {
  if (!value.trim() || value.length > max || /[\u0000-\u001f\u007f\ufffd]/.test(value)) throw new CliError(`Invalid ${label}.`);
  return value.trim();
}
export function requestEnvironment(value = "all"): string {
  if (value.trim() !== value || (value !== "all" && !/^[a-z][a-z0-9_-]{0,63}$/.test(value))) throw new CliError("Environment must be a lowercase name or all.");
  return value;
}
export function pageLimit(value: string | number | undefined, fallback = 100): number {
  if (value === undefined) return fallback;
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new CliError("Page size must be an integer from 1 to 100.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new CliError("Page size must be an integer from 1 to 100.");
  return parsed;
}
export function requestFilters(input: RequestQuery): URLSearchParams {
  const query = new URLSearchParams({ request_environment: requestEnvironment(input.environment), window: input.window ?? "1h" });
  if (!Object.hasOwn(windows, query.get("window")!)) throw new CliError("Window must be 10m, 1h, 6h, 24h, or 7d.");
  if (input.outcome !== undefined && !["success", "error"].includes(input.outcome)) throw new CliError("Outcome must be success or error.");
  if (input.provider !== undefined && input.provider !== "managed") throw new CliError("The customer provider filter supports managed only.");
  if (input.captureState !== undefined && !["disabled", "expected", "unknown"].includes(input.captureState)) throw new CliError("Capture state must be disabled, expected, or unknown.");
  if (input.statusCode !== undefined && !/^[1-5]\d\d$/.test(String(input.statusCode))) throw new CliError("Status code must be an HTTP status from 100 to 599.");
  // Error reasons are server-owned strings. Validate syntax without inventing
  // mappings or rejecting a newly supported server reason.
  if (input.errorReason !== undefined && !/^[a-z][a-z0-9_]{0,79}$/.test(input.errorReason)) throw new CliError("Invalid error reason.");
  const fields: [keyof RequestQuery, string][] = [["outcome", "outcome"], ["statusCode", "status_code"], ["errorReason", "error_reason"], ["provider", "provider"], ["requestedModel", "requested_model"], ["servedModel", "served_model"], ["route", "route"], ["captureState", "capture_state"]];
  for (const [key, name] of fields) if (input[key] !== undefined) query.set(name, textFilter(String(input[key]), name));
  const anchors = [input.windowStart, input.windowEnd, input.snapshotWatermark];
  if (anchors.some(value => value !== undefined)) {
    if (anchors.some(value => value === undefined)) throw new CliError("Supply window-start, window-end, and snapshot-watermark together.");
    for (const value of anchors) if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value!) || !Number.isFinite(Date.parse(value!)) || new Date(value!).toISOString() !== value) throw new CliError("Timeline anchors must be exact UTC instants with milliseconds.");
    if (Date.parse(input.windowEnd!) - Date.parse(input.windowStart!) !== windows[input.window ?? "1h"]) throw new CliError("The explicit timeline must have exactly the selected window's duration.");
    if (Date.parse(input.snapshotWatermark!) > Date.now() || Date.parse(input.windowEnd!) > Date.now()) throw new CliError("The timeline cannot be in the future.");
    query.set("window_start", input.windowStart!); query.set("window_end", input.windowEnd!); query.set("snapshot_watermark", input.snapshotWatermark!);
  }
  if (input.includeRejectionDetails) query.set("include_rejection_details", "true");
  if (input.limit !== undefined) query.set("limit", String(pageLimit(input.limit)));
  if (input.cursor !== undefined) query.set("cursor", textFilter(input.cursor, "cursor", 4096));
  if (input.all && input.cursor) throw new CliError("Start an all-pages selection without a cursor so coverage includes its first page.");
  return query;
}
export function addRequestFilterOptions(command: Command, options: { pagination?: boolean } = {}): Command {
  command.option("--org <id>", "Require the authenticated organization.")
    .option("--project <selector>", "Exact project id, slug, or name.")
    .option("--workload <selector>", "Exact workload id or name within the project.")
    .option("--environment <name>", "Request environment, or all (default: all).")
    .option("--window <window>", "10m, 1h, 6h, 24h, or 7d (default: 1h).")
    .option("--outcome <value>", "success or error.")
    .option("--status-code <code>", "HTTP status code.")
    .option("--error-reason <reason>", "Server error reason.")
    .option("--provider <provider>", "Customer provider label (managed).")
    .option("--requested-model <model>", "Exact requested model.")
    .option("--served-model <model>", "Exact public serving model.")
    .option("--route <route>", "Exact route label.")
    .option("--capture-state <state>", "disabled, expected, or unknown.")
    .option("--window-start <utc>", "Frozen UTC window start; all three timeline anchors required.")
    .option("--window-end <utc>", "Frozen UTC window end; duration must match --window.")
    .option("--snapshot-watermark <utc>", "Frozen UTC ingestion watermark.")
    .option("--include-rejection-details", "Include recorded pre-inference rejection diagnostics.");
  if (options.pagination !== false) command.option("--limit <count>", "Page size from 1 to 100.").option("--cursor <cursor>", "Continue the same filtered snapshot.").option("--all", "Read every page of the selected snapshot.");
  return command;
}
