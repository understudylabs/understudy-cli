import { z } from "zod";
import { CliError } from "../errors.js";
import { requestManagementJson } from "../management/client.js";
import type { RequestScope } from "../requests/service.js";
import { MetadataBudget, MAX_METADATA_PAGE_BYTES, boundedInteger, withRetry } from "./options.js";

const DAY = 86_400_000;
const instant = z.string().datetime({ precision: null });
const pageSchema = z.object({
  canonical_scope: z.object({ schema_version: z.literal("understudy.export-scope.v1"), selector: z.literal("workload-window"), org_id: z.string(), project_id: z.string(), workload_id: z.string(), from: instant, to: instant, ingestion_cutoff: instant }),
  captures: z.array(z.object({ request_id: z.string().min(1), capture_key: z.string(), captured_at: instant, url: z.string().url() })), next_cursor: z.string().min(1).nullable(),
});
export function timestampWindow(input: { from?: string; to?: string }, now = Date.now()) {
  if (!input.from || !input.to) throw new CliError("Capture time search requires both --from and --to.");
  const values = [input.from, input.to].map(value => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CliError("Capture timestamps need a timezone and at most millisecond precision.");
    const calendar = value.slice(0, 10);
    if (new Date(`${calendar}T00:00:00.000Z`).toISOString().slice(0, 10) !== calendar) throw new CliError("Capture timestamp calendar date is invalid.");
    return new Date(value).toISOString();
  });
  if (Date.parse(values[0]!) >= Date.parse(values[1]!) || Date.parse(values[1]!) > now || Date.parse(values[1]!) - Date.parse(values[0]!) > DAY) throw new CliError("Capture search needs a nonempty past window of at most 24 hours.");
  return { from: values[0]!, to: values[1]! };
}
export function workloadDay(input: { date?: string; last?: string }, now = Date.now()) {
  if (input.date && input.last) throw new CliError("Choose --date or --last.");
  if (input.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new CliError("Date must be a completed UTC date (YYYY-MM-DD).");
    const from = `${input.date}T00:00:00.000Z`, start = Date.parse(from);
    if (!Number.isFinite(start) || new Date(start).toISOString() !== from || start + DAY > Math.floor(now / DAY) * DAY) throw new CliError("Date must be a completed UTC date.");
    return { from, to: new Date(start + DAY).toISOString() };
  }
  if (input.last !== "1d") throw new CliError("Indexed capture export supports --date or --last 1d.");
  return { from: new Date(now - DAY).toISOString(), to: new Date(now).toISOString() };
}
export async function searchCaptures(scope: RequestScope, input: { from?: string; to?: string; environment?: string; retries?: string | number }) {
  if (!scope.project || !scope.workload) throw new CliError("Capture timestamp search requires a project and workload.");
  if (input.environment !== undefined && input.environment !== "production") throw new CliError("Indexed capture search supports the production environment only.");
  const now = Date.now(), window = timestampWindow(input, now);
  const start = Math.min(Date.parse(window.from), now - DAY), indexWindow = { from: new Date(start).toISOString(), to: new Date(start + DAY).toISOString() };
  const captures: Array<{ request_id: string; captured_at: string }> = [], cursors = new Set<string>(), requests = new Set<string>(), budget = new MetadataBudget();
  let canonical: z.infer<typeof pageSchema>["canonical_scope"] | undefined, cursor: string | null = null, previous: z.infer<typeof pageSchema>["captures"][number] | undefined, pages = 0, scanned = 0;
  do {
    const page = await withRetry(() => requestManagementJson(scope.session, {
      path: `/admin/v1/orgs/${encodeURIComponent(scope.session.organizationId)}/projects/${encodeURIComponent(scope.project!.id)}/workloads/${encodeURIComponent(scope.workload!.id)}/captures/export`, method: "POST", action: "Indexed capture search", timeoutMs: 60000, maxResponseBytes: MAX_METADATA_PAGE_BYTES,
      body: { ...indexWindow, ...(cursor ? { cursor, ingestion_cutoff: canonical!.ingestion_cutoff } : {}) },
      responseFailureMessages: { 501: "The server returned 501 for indexed capture search. This capability is unavailable on this server; no request-log substitution or sampled result was used." },
    }, pageSchema), boundedInteger(input.retries, "Retries", 0, 5, 2));
    const current = page.canonical_scope;
    budget.add({ cursor: page.next_cursor }, 0);
    if (current.org_id !== scope.session.organizationId || current.project_id !== scope.project.id || current.workload_id !== scope.workload.id || current.from !== indexWindow.from || current.to !== indexWindow.to || Date.parse(current.ingestion_cutoff) < Date.parse(indexWindow.to) || Date.parse(current.ingestion_cutoff) > now + 60000 || (canonical && JSON.stringify(current) !== JSON.stringify(canonical))) throw new CliError("Indexed capture search changed its requested scope or frozen window.");
    canonical ??= current; pages++;
    if (!page.captures.length && page.next_cursor) throw new CliError("Indexed capture search returned an empty non-terminal page.");
    let reachedEnd = false;
    for (const capture of page.captures) {
      budget.add({ request_id: capture.request_id, capture_key: capture.capture_key, captured_at: capture.captured_at }); scanned++;
      const parts = capture.capture_key.split("/"), at = Date.parse(capture.captured_at);
      if (!capture.capture_key.startsWith(`${scope.session.organizationId}/${scope.project.id}/`) || !capture.capture_key.endsWith(`/${capture.request_id}.jsonl`) || parts.length < 7 || parts.some(part => !part || part === "." || part === "..") || at < start || at >= start + DAY) throw new CliError("Indexed capture search returned an out-of-scope reference.");
      if (previous && compareReferences(previous, capture) >= 0) throw new CliError("Indexed capture search repeated or reordered references.");
      previous = capture;
      if (requests.has(capture.request_id)) throw new CliError("Indexed capture search repeated a request."); requests.add(capture.request_id);
      if (at >= Date.parse(window.to)) reachedEnd = true;
      if (at >= Date.parse(window.from) && at < Date.parse(window.to)) captures.push({ request_id: capture.request_id, captured_at: capture.captured_at });
    }
    cursor = page.next_cursor;
    if (cursor && cursors.has(cursor)) throw new CliError("Indexed capture search repeated a cursor.");
    if (cursor) cursors.add(cursor);
    if (reachedEnd) break;
  } while (cursor);
  return { window, index_window: indexWindow, ingestion_cutoff: canonical!.ingestion_cutoff, captures, scanned_count: scanned, pages };
}
function compareReferences(left: z.infer<typeof pageSchema>["captures"][number], right: z.infer<typeof pageSchema>["captures"][number]) {
  const time = Date.parse(left.captured_at) - Date.parse(right.captured_at);
  if (time) return time;
  const a = left.captured_at.match(/\.(\d+)Z$/)?.[1] ?? "", b = right.captured_at.match(/\.(\d+)Z$/)?.[1] ?? "", width = Math.max(a.length, b.length);
  const values = [[a.padEnd(width, "0"), b.padEnd(width, "0")], [left.request_id, right.request_id], [left.capture_key, right.capture_key]];
  for (const [a, b] of values) { if (a! < b!) return -1; if (a! > b!) return 1; }
  return 0;
}
