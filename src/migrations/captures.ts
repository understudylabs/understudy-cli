import path from "node:path";
import { z } from "zod";
import { CliError } from "../errors.js";
import { requestManagementJson, ManagementError, ManagementTransportError, type ManagementOptions } from "../management/client.js";
import { withRetry, boundedInteger, MetadataBudget, MAX_METADATA_PAGE_BYTES } from "../captures/options.js";
import { captureIndexSchema, object, type CaptureIndex, type Run, type Scope } from "./contracts.js";
import { capturePath } from "./scope.js";
import { digest, MigrationStorage } from "./storage.js";
import { BufferBudget } from "./buffer-budget.js";
const MAX_BYTES = 64 * 1024 * 1024;
const BUFFER_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_WORKERS = 16;
export interface CaptureSelection { lastDays?: string; from?: string; to?: string }
export interface CaptureProgress { phase: "download" | "verify" | "reconstruct"; date?: string; saved: number; bytes: number; unavailable: number }
export function selectCaptureWindow(input: CaptureSelection): Run["captureWindow"] {
    if (input.lastDays !== undefined) {
        if (input.from !== undefined || input.to !== undefined || !/^[1-9]\d*$/.test(input.lastDays))
            throw new CliError("Use --last-days with a positive whole number, or use --from and --to together.");
        const days = Number(input.lastDays), end = Math.floor(Date.now() / 86400000) * 86400000;
        const start = end - days * 86400000;
        if (!Number.isSafeInteger(days) || start < 0) throw new CliError("The requested day range is invalid.");
        return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
    }
    if (input.from === undefined && input.to === undefined) return undefined;
    const parse = (value?: string) => {
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CliError("Supply --from and --to as UTC dates (YYYY-MM-DD); --to is exclusive.");
        const ms = Date.parse(`${value}T00:00:00.000Z`);
        if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new CliError("The requested day range is invalid.");
        return ms;
    };
    const from = parse(input.from), to = parse(input.to);
    if (from >= to || to > Math.floor(Date.now() / 86400000) * 86400000) throw new CliError("Select a nonempty range of completed UTC days; --to is exclusive.");
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

async function concurrent<T, R>(values: T[], workers: number, action: (value: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let cursor = 0, failed = false, failure: unknown;
    await Promise.all(Array.from({ length: Math.min(workers, values.length) }, async () => {
        while (!failed && cursor < values.length) {
            const position = cursor++;
            try { results[position] = await action(values[position]!); }
            catch (error) { failed = true; failure = error; }
        }
    }));
    if (failed) throw failure;
    return results;
}
const listingSchema = z.object({ captures: z.array(z.object({
        key: z.string(), request_id: z.string(), size: z.number().int().nonnegative(), uploaded: z.string(),
    })), truncated: z.boolean(), cursor: z.string().nullable().optional(), skipped_malformed: z.number().int().nonnegative().optional() });
const pageSchema = z.object({
    canonical_scope: z.object({ schema_version: z.literal("understudy.export-scope.v1"), selector: z.literal("workload-window"), org_id: z.string(), project_id: z.string(), workload_id: z.string(), from: z.string(), to: z.string(), ingestion_cutoff: z.string() }),
    captures: z.array(z.object({ request_id: z.string().min(1), capture_key: z.string(), captured_at: z.string(), url: z.string() })),
    next_cursor: z.string().nullable(),
});
export function requireSessionScope(session: ManagementOptions, run: Run): void {
    if (session.organizationId !== run.scope.organization.id)
        throw new CliError("The current authenticated organization does not match this run.");
}
function validateKey(key: string, requestId: string, scope: Scope): void {
    if (!key.startsWith(`${scope.organization.id}/${scope.project.id}/`) || !key.endsWith(`/${requestId}.jsonl`))
        throw new CliError("Capture reference does not match the run scope.");
}
export function decodeCapture(bytes: Buffer, scope: Scope, expectedRequest?: string): Record<string, unknown> {
    let value;
    try {
        value = object(JSON.parse(bytes.toString("utf8")));
    }
    catch {
        throw new CliError("A capture has an invalid envelope. Its bytes were not accepted.");
    }
    if (typeof value.request_id !== "string" || !value.request_id || (expectedRequest !== undefined && value.request_id !== expectedRequest) ||
        (value.workos_org_id ?? value.org_id) !== scope.organization.id || value.project_id !== scope.project.id ||
        (value.workload_id ?? value.placement_id) !== scope.workload.id)
        throw new CliError("A capture does not match its request and organization/project/workload scope.");
    return value;
}
export async function readIndex(storage: MigrationStorage, run: Run): Promise<CaptureIndex> {
    const index = captureIndexSchema.parse(await storage.json(path.join(storage.runPath(run.runId), "captures.json")));
    if (JSON.stringify(index.scope) !== JSON.stringify(run.scope) || new Set(index.rows.map((r) => r.requestId)).size !== index.rows.length)
        throw new CliError("Capture index has an invalid scope or duplicate requests.");
    return index;
}
export async function verifyCaptures(storage: MigrationStorage, run: Run): Promise<{
    index: CaptureIndex;
    sourceDigest: string;
}> {
    const index = await readIndex(storage, run);
    await verifyRows(storage, run, index.rows);
    return { index, sourceDigest: digest(JSON.stringify(index)) };
}
async function verifyRows(storage: MigrationStorage, run: Run, rows: CaptureIndex["rows"]) {
    const budget = new BufferBudget(BUFFER_BYTES);
    await concurrent(rows, 8, async row => {
        if (!/^captures\/[a-f0-9]{64}\.jsonl$/.test(row.file))
            throw new CliError("Capture index contains an invalid private file reference.");
        if (row.bytes > MAX_BYTES) throw new CliError("A capture exceeds the explicit 64 MiB object limit.");
        await budget.run(row.bytes, async () => {
            const bytes = await storage.read(path.join(storage.runPath(run.runId), row.file), row.bytes);
            if (bytes.length !== row.bytes || digest(bytes) !== row.sha256)
                throw new CliError("Capture integrity verification did not match the stored size and hash.");
            decodeCapture(bytes, run.scope, row.requestId);
        });
    });
}
export async function inventoryCaptures(storage: MigrationStorage, run: Run, session: ManagementOptions) {
    requireSessionScope(session, run);
    const rows = new Map<string, z.infer<typeof listingSchema>["captures"][number]>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let malformed = 0;
    do {
        const query: URLSearchParams = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
        const page: z.infer<typeof listingSchema> = await requestManagementJson(session, { path: `${capturePath(run.scope)}?${query}`, action: "Capture inventory" }, listingSchema);
        for (const row of page.captures) {
            validateKey(row.key, row.request_id, run.scope);
            const prior = rows.get(row.request_id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(row))
                throw new CliError("Capture inventory contains conflicting references.");
            rows.set(row.request_id, row);
        }
        malformed += page.skipped_malformed ?? 0;
        cursor = page.truncated ? page.cursor ?? null : null;
        if (page.truncated && !cursor)
            throw new CliError("Capture inventory was truncated without a continuation cursor.");
        if (cursor && cursors.has(cursor))
            throw new CliError("Capture inventory repeated a continuation cursor.");
        if (cursor)
            cursors.add(cursor);
    } while (cursor);
    const result = { schemaVersion: 1, scope: run.scope, observedAt: new Date().toISOString(), exhausted: true, skippedMalformed: malformed, rows: [...rows.values()] };
    await storage.writeJson(path.join(storage.runPath(run.runId), "inventory.json"), result);
    return { requests: rows.size, skippedMalformed: malformed, exhausted: true };
}
export async function importCaptures(storage: MigrationStorage, run: Run, input: string) {
    const source = await storage.read(input);
    const lines = source.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
    const rows: CaptureIndex["rows"] = [];
    const seen = new Set<string>();
    const entries: { requestId: string; target: string; expectedBytes: number; sha256: string }[] = [];
    for (const line of lines) {
        let row;
        try {
            row = object(JSON.parse(line));
        }
        catch {
            throw new CliError("Private capture index contains invalid JSON.");
        }
        const requestId = row.request_id;
        const relative = row.file ?? row.local_path;
        const expectedBytes = row.size ?? row.size_bytes;
        if (typeof requestId !== "string" || !requestId || typeof relative !== "string" || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_BYTES || typeof row.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.content_sha256))
            throw new CliError("Private capture index requires request id, relative file, byte size, and content hash.");
        const sourceRoot = row.file === undefined && relative.startsWith("source/") && path.basename(path.dirname(input)) === "source" ? path.dirname(path.dirname(input)) : path.dirname(input);
        const target = path.resolve(sourceRoot, relative);
        if (path.isAbsolute(relative) || path.relative(path.resolve(sourceRoot), target).startsWith(".."))
            throw new CliError("Private capture index references a file outside its source directory.");
        if (seen.has(requestId))
            throw new CliError("Private capture index repeats a request id.");
        entries.push({ requestId, target, expectedBytes, sha256: row.content_sha256 });
        seen.add(requestId);
    }
    let cursor = 0, failed = false, failure: unknown;
    const worker = async () => {
        while (!failed && cursor < entries.length) {
            const position = cursor++, entry = entries[position]!;
            try {
                const bytes = await storage.read(entry.target);
                if (bytes.length !== entry.expectedBytes || digest(bytes) !== entry.sha256) throw new CliError("Imported capture did not match its declared size and hash.");
                decodeCapture(bytes, run.scope, entry.requestId);
                const file = `captures/${entry.sha256}.jsonl`, destination = path.join(storage.runPath(run.runId), file);
                let existing = false;
                try { const saved = await storage.read(destination); existing = saved.length === bytes.length && digest(saved) === entry.sha256; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                if (!existing) await storage.write(destination, bytes);
                rows[position] = { requestId: entry.requestId, file, bytes: bytes.length, sha256: entry.sha256 };
            } catch (error) { failed = true; failure = error; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, worker));
    if (failed) throw failure;
    const index: CaptureIndex = { schemaVersion: 1, scope: run.scope, provenance: "private_import", rows,
        gaps: [{ code: "import_source_completeness_unverified" }] };
    await storage.writeJson(path.join(storage.runPath(run.runId), "captures.json"), index);
    return { requests: rows.length, verified: rows.length, completeness: "source_inventory_unverified" };
}
export function utcDay(value: string): {
    from: string;
    to: string;
} {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new CliError("Select an explicit complete UTC day (YYYY-MM-DD).");
    const start = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== value || start + 86400000 > Date.now())
        throw new CliError("Select a valid, completed UTC day.");
    return { from: new Date(start).toISOString(), to: new Date(start + 86400000).toISOString() };
}
async function download<T>(url: string, fetcher: typeof fetch, budget: BufferBudget, consume: (bytes: Buffer | null) => Promise<T>): Promise<T> {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new CliError("Capture download address is invalid.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !parsed.hostname.endsWith(".r2.cloudflarestorage.com"))
        throw new CliError("Capture download requires a trusted HTTPS object-storage address.");
    let response;
    const controller = new AbortController();
    const headerTimeout = setTimeout(() => controller.abort(), 60000);
    try {
        response = await fetcher(url, { redirect: "error", signal: controller.signal });
    }
    catch {
        throw new ManagementTransportError("Capture download could not complete. Resume the same export to retry.");
    }
    finally { clearTimeout(headerTimeout); }
    if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        return consume(null);
    }
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ManagementError("Capture download could not complete. Resume the same export to retry.", response.status);
    }
    // Encoded or unknown sizes reserve the full object allowance. A declared
    // size is only an upper bound: enforce it against every decoded chunk.
    const declared = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
    const allowance = (!encoding || encoding.toLowerCase() === "identity") && declared !== null && /^\d+$/.test(declared) ? Number(declared) : MAX_BYTES;
    if (!Number.isSafeInteger(allowance) || allowance > MAX_BYTES) {
        await response.body.cancel();
        throw new CliError("A capture exceeds the explicit 64 MiB object limit; no bytes were truncated.");
    }
    const body = response.body;
    return budget.run(allowance, async () => {
        const reader = body.getReader();
        const bodyTimeout = setTimeout(() => controller.abort(), 60000);
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                length += next.value.length;
                if (length > allowance) {
                    await reader.cancel();
                    throw new CliError("A capture exceeded its reserved byte limit; no bytes were truncated.");
                }
                chunks.push(next.value);
            }
        }
        catch (error) {
            if (error instanceof CliError)
                throw error;
            throw new ManagementTransportError("Capture body was interrupted. Resume the same export to retry.");
        }
        finally {
            clearTimeout(bodyTimeout);
            reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        chunks.length = 0;
        return consume(bytes);
    });
}
export async function exportDay(storage: MigrationStorage, run: Run, date: string, session: ManagementOptions, fetcher: typeof fetch = fetch, explicitWindow?: {
    from: string;
    to: string;
}, verifyAll = true, progress?: (event: CaptureProgress) => void, controls: { concurrency?: string | number; retries?: string | number } = {}) {
    requireSessionScope(session, run);
    const window = explicitWindow ?? utcDay(date);
    const base = storage.runPath(run.runId);
    const statePath = path.join(base, "exports", `${date}.json`);
    type State = {
        scope: Scope;
        date: string;
        canonical: z.infer<typeof pageSchema>["canonical_scope"] | null;
        cursor: string | null;
        complete: boolean;
        rows: CaptureIndex["rows"];
        gaps: CaptureIndex["gaps"];
    };
    let state: State;
    try {
        state = JSON.parse((await storage.read(statePath)).toString("utf8")) as State;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        state = { scope: run.scope, date, canonical: null, cursor: null, complete: false, rows: [], gaps: [] };
    }
    state = z.object({ scope: captureIndexSchema.shape.scope, date: z.string(), canonical: pageSchema.shape.canonical_scope.nullable(), cursor: z.string().nullable(), complete: z.boolean(), rows: captureIndexSchema.shape.rows, gaps: captureIndexSchema.shape.gaps }).parse(state);
    if (JSON.stringify(state.scope) !== JSON.stringify(run.scope) || state.date !== date || (state.canonical && (state.canonical.from !== window.from || state.canonical.to !== window.to)))
        throw new CliError("Export checkpoint does not match the run.");
    if ((state.complete || state.cursor) && !state.canonical) throw new CliError("Export checkpoint is missing its frozen scope.");
    if (state.canonical && (state.canonical.org_id !== run.scope.organization.id || state.canonical.project_id !== run.scope.project.id || state.canonical.workload_id !== run.scope.workload.id)) throw new CliError("Export checkpoint has an invalid scope.");
    const cursors = new Set<string>();
    const seen = new Set([...state.rows, ...state.gaps].map(r => r.requestId));
    if (seen.size !== state.rows.length + state.gaps.length) throw new CliError("Export checkpoint repeats a capture request.");
    let saved = state.rows.length, bytesSaved = state.rows.reduce((sum, row) => sum + row.bytes, 0), unavailable = state.gaps.length, lastProgress = 0;
    const emit = (phase: CaptureProgress["phase"], force = false) => {
        if (force || Date.now() - lastProgress >= 1000) {
            progress?.({ phase, date: window.from.slice(0, 10), saved, bytes: bytesSaved, unavailable });
            lastProgress = Date.now();
        }
    };
    emit("download", true);
    const budget = new BufferBudget(BUFFER_BYTES), metadata = new MetadataBudget();
    const workers = boundedInteger(controls.concurrency, "Concurrency", 1, 16, DOWNLOAD_WORKERS), retries = boundedInteger(controls.retries, "Retries", 0, 5, 0);
    for (const row of state.rows) metadata.add(row);
    for (const gap of state.gaps) metadata.add(gap);
    if (state.rows.length) await verifyRows(storage, run, state.rows);
    while (!state.complete) {
        const page = await withRetry(() => requestManagementJson(session, { path: `${capturePath(run.scope)}/export`, method: "POST", action: "Capture export", maxResponseBytes: MAX_METADATA_PAGE_BYTES,
            responseFailureMessages: { 501: "Indexed customer capture export is unavailable on the server. Preserve this run. Use captures export for an explicitly filtered request-log selection, or import an authorized private export; neither proves complete indexed coverage." },
            body: { ...window, ...(state.cursor ? { cursor: state.cursor, ingestion_cutoff: state.canonical!.ingestion_cutoff } : {}) } }, pageSchema), retries);
        const s = page.canonical_scope;
        if (s.org_id !== run.scope.organization.id || s.project_id !== run.scope.project.id || s.workload_id !== run.scope.workload.id || s.from !== window.from || s.to !== window.to || !Number.isFinite(Date.parse(s.ingestion_cutoff)) || Date.parse(s.ingestion_cutoff) < Date.parse(window.to) || Date.parse(s.ingestion_cutoff) > Date.now() + 60000 || (state.canonical && JSON.stringify(s) !== JSON.stringify(state.canonical)))
            throw new CliError("Export page changed its exact scope or frozen time window.");
        state.canonical = s;
        for (const ref of page.captures) {
            metadata.add({ requestId: ref.request_id, key: ref.capture_key, at: ref.captured_at });
            validateKey(ref.capture_key, ref.request_id, run.scope);
            const at = Date.parse(ref.captured_at);
            if (!Number.isFinite(at) || at < Date.parse(window.from) || at >= Date.parse(window.to))
                throw new CliError("Capture reference is outside the requested UTC day.");
            if (seen.has(ref.request_id))
                throw new CliError("Export page repeats a capture request.");
            seen.add(ref.request_id);
        }
        if (page.next_cursor && (page.next_cursor === state.cursor || cursors.has(page.next_cursor)))
            throw new CliError("Export repeated a continuation cursor.");
        const downloaded = await concurrent(page.captures, workers, ref => withRetry(() => download(ref.url, fetcher, budget, async bytes => {
            if (!bytes) { unavailable++; emit("download"); return { gap: { code: "capture_object_unavailable", requestId: ref.request_id } }; }
            decodeCapture(bytes, run.scope, ref.request_id);
            const sha256 = digest(bytes), file = `captures/${sha256}.jsonl`;
            await storage.write(path.join(base, file), bytes);
            saved++; bytesSaved += bytes.length; emit("download");
            return { row: { requestId: ref.request_id, file, bytes: bytes.length, sha256 } };
        }), retries));
        for (const result of downloaded) {
            if (result.row) state.rows.push(result.row);
            if (result.gap) state.gaps.push(result.gap);
        }
        if (page.next_cursor)
            cursors.add(page.next_cursor);
        state.cursor = page.next_cursor;
        state.complete = page.next_cursor === null;
        await storage.writeJson(statePath, state);
    }
    let prior: CaptureIndex | null = null;
    try {
        prior = await readIndex(storage, run);
    }
    catch (error) {
        // Only absence is optional. Validate an existing index even when extending a run.
        try {
            await storage.read(path.join(base, "captures.json"));
            throw error;
        }
        catch (missing) {
            if ((missing as NodeJS.ErrnoException).code !== "ENOENT")
                throw missing;
        }
    }
    const rows = new Map((prior?.rows ?? []).map((row) => [row.requestId, row]));
    for (const row of state.rows) {
        const old = rows.get(row.requestId);
        if (old && old.sha256 !== row.sha256)
            throw new CliError("A request's capture changed between exports.");
        rows.set(row.requestId, row);
    }
    const gaps = new Map([...(prior?.gaps ?? []), ...state.gaps].map((gap) => [JSON.stringify([gap.code, gap.requestId ?? null]), gap]));
    const index = captureIndexSchema.parse({ schemaVersion: 1, scope: run.scope, provenance: "hosted_export", rows: [...rows.values()], gaps: [...gaps.values()] });
    await storage.writeJson(path.join(base, "captures.json"), index);
    emit("verify", true);
    if (verifyAll) await verifyCaptures(storage, run);
    else await verifyRows(storage, run, state.rows);
    return { requested: state.rows.length + state.gaps.length, verified: state.rows.length, unavailable: state.gaps.length, date, completeForDay: state.gaps.length === 0, fullLifetime: false };
}
export async function exportWindow(storage: MigrationStorage, run: Run, session: ManagementOptions, fetcher: typeof fetch = fetch, progress?: (event: CaptureProgress) => void) {
    requireSessionScope(session, run);
    if (!run.captureWindow) throw new CliError("This run has no saved capture window.");
    const window = selectCaptureWindow({ from: run.captureWindow.from.slice(0, 10), to: run.captureWindow.to.slice(0, 10) })!;
    if (JSON.stringify(window) !== JSON.stringify(run.captureWindow)) throw new CliError("The saved capture window is invalid.");
    const started = Date.now(), days = [];
    for (let start = Date.parse(window.from); start < Date.parse(window.to); start += 86400000) {
        days.push(await exportDay(storage, run, new Date(start).toISOString().slice(0, 10), session, fetcher, undefined, false, progress));
    }
    const { index, sourceDigest } = await verifyCaptures(storage, run);
    if (index.rows.length !== days.reduce((sum, day) => sum + day.verified, 0)) throw new CliError("The capture index does not match the requested export days.");
    const result = { schemaVersion: 1, sourceDigest, inventoryDigest: null, window,
        indexedRequests: days.reduce((sum, day) => sum + day.requested, 0), verified: index.rows.length,
        bytes: index.rows.reduce((sum, row) => sum + row.bytes, 0), days,
        completeForWindow: days.every(day => day.completeForDay) && index.gaps.length === 0,
        completeForInventory: null, snapshotIsolation: false, elapsedMs: Date.now() - started,
        downloadConcurrency: DOWNLOAD_WORKERS };
    await storage.writeJson(path.join(storage.runPath(run.runId), "export-coverage.json"), result);
    return result;
}
export async function exportInventory(storage: MigrationStorage, run: Run, session: ManagementOptions, fetcher: typeof fetch = fetch, progress?: (event: CaptureProgress) => void) {
    requireSessionScope(session, run);
    const file = path.join(storage.runPath(run.runId), "inventory.json");
    let inventory: {
        scope: Scope;
        observedAt: string;
        exhausted: boolean;
        skippedMalformed: number;
        rows: z.infer<typeof listingSchema>["captures"];
    };
    try {
        inventory = JSON.parse((await storage.read(file)).toString("utf8"));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        await inventoryCaptures(storage, run, session);
        inventory = JSON.parse((await storage.read(file)).toString("utf8"));
    }
    inventory = z.object({ scope: captureIndexSchema.shape.scope, observedAt: z.string().datetime(), exhausted: z.literal(true), skippedMalformed: z.number().int().nonnegative(), rows: listingSchema.shape.captures }).parse(inventory);
    if (JSON.stringify(inventory.scope) !== JSON.stringify(run.scope))
        throw new CliError("Capture inventory belongs to another scope.");
    const cutoff = Date.parse(inventory.observedAt);
    const dates = new Set<string>();
    for (const row of inventory.rows) {
        validateKey(row.key, row.request_id, run.scope);
        const match = /\/(\d{4})[-/](\d{2})[-/](\d{2})\//.exec(row.key);
        if (!match)
            throw new CliError("Full inventory export requires date-partitioned capture references. Import a verified private export for other layouts.");
        dates.add(`${match[1]}-${match[2]}-${match[3]}`);
    }
    if (!dates.size) {
        await storage.writeJson(path.join(storage.runPath(run.runId), "captures.json"), { schemaVersion: 1, scope: run.scope, provenance: "hosted_export", rows: [], gaps: [] });
    }
    for (const date of [...dates].sort()) {
        const start = Date.parse(`${date}T00:00:00.000Z`);
        if (!Number.isFinite(start) || start > cutoff || new Date(start).toISOString().slice(0, 10) !== date)
            throw new CliError("Capture inventory contains an invalid date partition.");
        if (start + 86400000 <= cutoff)
            await exportDay(storage, run, date, session, fetcher, undefined, false, progress);
        else {
            const window = { from: new Date(cutoff - 86400000).toISOString(), to: new Date(cutoff).toISOString() };
            await exportDay(storage, run, `through-${digest(inventory.observedAt).slice(0, 16)}`, session, fetcher, window, false, progress);
        }
    }
    const { index, sourceDigest } = await verifyCaptures(storage, run);
    const have = new Set(index.rows.map((r) => r.requestId));
    const missing = inventory.rows.filter((r) => !have.has(r.request_id)).map((r) => r.request_id);
    const indexed = new Map(index.rows.map((row) => [row.requestId, row]));
    const sizeMismatches = inventory.rows.filter((row) => indexed.has(row.request_id) && indexed.get(row.request_id)!.bytes !== row.size)
        .map((row) => ({ requestId: row.request_id, expectedBytes: row.size, actualBytes: indexed.get(row.request_id)!.bytes }));
    const result = { schemaVersion: 1, sourceDigest, sizeMismatches, inventoryDigest: digest(await storage.read(file)), inventoryRequests: inventory.rows.length, verified: index.rows.length, missing, skippedMalformed: inventory.skippedMalformed,
        completeForInventory: missing.length === 0 && sizeMismatches.length === 0 && inventory.skippedMalformed === 0 && index.gaps.length === 0, observedAt: inventory.observedAt, snapshotIsolation: false };
    await storage.writeJson(path.join(storage.runPath(run.runId), "export-coverage.json"), result);
    return result;
}
