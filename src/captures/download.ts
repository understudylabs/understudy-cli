import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { z } from "zod";
import { CliError } from "../errors.js";
import { ManagementError } from "../management/client.js";
import { MigrationStorage, digest } from "../migrations/storage.js";
import { downloadOptions, MAX_CAPTURE_BYTES, MAX_METADATA_BYTES, MetadataBudget, retryable, withRetry, type DownloadOptions } from "./options.js";

const memberSchema = z.object({ requestId: z.string().min(1), projectId: z.string().min(1), workloadId: z.string().nullable(), traceId: z.string().nullable() }).strict();
export type CaptureMember = z.infer<typeof memberSchema>;
const entrySchema = memberSchema.extend({ state: z.enum(["available", "unavailable", "failed"]), file: z.string().optional(), bytes: z.number().int().nonnegative().max(MAX_CAPTURE_BYTES).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), httpStatus: z.number().int().optional() }).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(2), kind: z.literal("customer-capture-download"), downloadId: z.string(), status: z.enum(["in_progress", "complete", "complete_with_gaps", "interrupted"]),
  organizationId: z.string(), intent: z.unknown(), selection: z.unknown(), members: z.array(memberSchema).max(100000), selectionSha256: z.string(),
  includePayload: z.boolean(), requested: z.number(), retrieved: z.number(), missing: z.number(), failed: z.number(),
  entries: z.array(entrySchema.nullable()).max(100000), integrity: z.string(), coverage: z.string(), importIndex: z.string().nullable(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function commitment(manifest: Pick<Manifest, "organizationId" | "intent" | "selection" | "members" | "includePayload">) { return digest(canonicalJson(manifest)); }
function identity(manifest: Manifest) { return { organizationId: manifest.organizationId, intent: manifest.intent, selection: manifest.selection, members: manifest.members, includePayload: manifest.includePayload }; }

export async function downloadCaptures(input: {
  storage: MigrationStorage; organizationId: string; intent: unknown; options: DownloadOptions;
  select: () => Promise<{ members: CaptureMember[]; selection: unknown }>;
  fetch: (member: CaptureMember) => Promise<unknown>;
}) {
  const settings = downloadOptions(input.options), { storage } = input;
  const id = input.options.downloadId ?? `download-${randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id) || id.trim() !== id) throw new CliError("Download ids use letters, digits, underscores, and hyphens.");
  if (input.options.downloadId && (input.options.output || input.options.out)) throw new CliError("Choose --download-id or --out, not both.");
  const directory = input.options.output || input.options.out ? path.resolve(storage.project, (input.options.output ?? input.options.out)!) : path.join(storage.root, "downloads", id);
  const artifact = path.join(directory, "manifest.json"), lockPath = path.join(directory, ".lock");
  await storage.check(lockPath, true);
  const lock = await open(lockPath, "wx", 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError("This download is already in use. Inspect an interrupted download before removing its private .lock."); throw error; });
  let manifest: Manifest | undefined;
  try {
    try {
      const parsed = manifestSchema.safeParse(JSON.parse((await storage.read(artifact, 128 * 1024 * 1024)).toString("utf8")));
      if (!parsed.success) throw new CliError("The saved download manifest is invalid or uses an older format. Preserve it and choose a new output directory.");
      manifest = parsed.data;
      if (manifest.organizationId !== input.organizationId || canonicalJson(manifest.intent) !== canonicalJson(input.intent) || manifest.includePayload !== settings.includePayload || commitment(identity(manifest)) !== manifest.selectionSha256) throw new CliError("The saved download scope, selection, or payload mode does not match. Choose a new output directory.");
      if (manifest.requested !== manifest.members.length || manifest.entries.length !== manifest.members.length) throw new CliError("The saved download membership is inconsistent.");
      const seen = new Set<string>();
      for (let index = 0; index < manifest.members.length; index++) {
        const member = manifest.members[index]!, entry = manifest.entries[index];
        if (seen.has(member.requestId)) throw new CliError("The saved download repeats a request."); seen.add(member.requestId);
        if (entry && canonicalJson(member) !== canonicalJson({ requestId: entry.requestId, projectId: entry.projectId, workloadId: entry.workloadId, traceId: entry.traceId })) throw new CliError("The saved capture entry differs from frozen membership.");
        if (entry?.state === "available" && settings.resume) {
          if (!entry.file || !entry.sha256 || entry.bytes === undefined || !new RegExp(`^${settings.includePayload ? "captures" : "summaries"}/[a-f0-9]{64}\\.jsonl$`).test(entry.file) || entry.file !== `${settings.includePayload ? "captures" : "summaries"}/${entry.sha256}.jsonl`) throw new CliError("The saved capture file reference is invalid.");
          const bytes = await storage.read(path.join(directory, entry.file), entry.bytes);
          if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new CliError("Saved capture integrity failed. Preserve the evidence, or use --no-resume to re-download the same frozen selection.");
        }
      }
      if (!settings.resume) manifest.entries = manifest.members.map(() => null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A missing manifest starts a new selection; a missing recorded body must
      // never turn a frozen selection into a fresh remote snapshot.
      if (manifest) throw new CliError("A saved capture is missing. Use --no-resume to re-download the same frozen selection.");
      try { await storage.read(path.join(directory, "run.json"), MAX_METADATA_BYTES); throw new CliError("This directory contains an indexed export. Choose another directory for customer capture downloads."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const selected = await input.select(), budget = new MetadataBudget(), seen = new Set<string>();
      budget.add(selected.selection, 0);
      const members = selected.members.map(member => memberSchema.parse(member));
      for (const member of members) { budget.add(member); if (seen.has(member.requestId)) throw new CliError("Capture selection repeats a request."); seen.add(member.requestId); }
      const frozen = { organizationId: input.organizationId, intent: input.intent, selection: selected.selection, members, includePayload: settings.includePayload };
      manifest = { schemaVersion: 2, kind: "customer-capture-download", downloadId: id, status: "in_progress", ...frozen, selectionSha256: commitment(frozen), requested: members.length, retrieved: 0, missing: 0, failed: 0, entries: members.map(() => null), importIndex: null,
        integrity: "SHA-256 identifies saved customer-visible JSON bytes, not the original forensic storage object.", coverage: "Only the frozen selection was considered. Complete traversal does not prove capture retention or whole-workload coverage." };
    }
    const saved = manifest;
    saved.importIndex = null;
    const staleIndex = path.join(directory, "import-index.jsonl");
    await storage.check(staleIndex); await rm(staleIndex, { force: true });
    let writes: Promise<void> = Promise.resolve(), completedSinceSave = 0, lastSave = 0;
    const checkpoint = (force = false) => {
      completedSinceSave++;
      if (!force && completedSinceSave < 100 && Date.now() - lastSave < 1000) return writes;
      completedSinceSave = 0; lastSave = Date.now();
      saved.retrieved = saved.entries.filter(entry => entry?.state === "available").length;
      saved.missing = saved.entries.filter(entry => entry?.state === "unavailable").length;
      saved.failed = saved.entries.filter(entry => entry?.state === "failed").length;
      const bytes = `${JSON.stringify(saved)}\n`;
      if (Buffer.byteLength(bytes) > 2 * MAX_METADATA_BYTES) throw new CliError("Download manifest exceeded its explicit 128 MiB bound.");
      writes = writes.then(() => storage.write(artifact, bytes)); return writes;
    };
    saved.status = "in_progress"; await checkpoint(true);
    let position = 0, stopped = false, failure: unknown;
    // At most eight 16 MiB bodies are resident even when sixteen workers were
    // requested. Other concurrency settings below that budget are respected.
    await Promise.all(Array.from({ length: Math.min(settings.concurrency, 8, saved.members.length) }, async () => {
      while (!stopped && position < saved.members.length) {
        const index = position++, member = saved.members[index]!;
        if (saved.entries[index]?.state === "available" && settings.resume) continue;
        try {
          const value = await withRetry(() => input.fetch(member), settings.retries);
          const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
          if (bytes.length > MAX_CAPTURE_BYTES) throw new CliError("Capture output exceeds the explicit 16 MiB limit.");
          const sha256 = digest(bytes), file = `${settings.includePayload ? "captures" : "summaries"}/${sha256}.jsonl`;
          await storage.write(path.join(directory, file), bytes);
          saved.entries[index] = { ...member, state: "available", file, bytes: bytes.length, sha256 };
        } catch (error) {
          if (error instanceof ManagementError && [404, 410].includes(error.status)) saved.entries[index] = { ...member, state: "unavailable", httpStatus: error.status };
          else if (retryable(error)) saved.entries[index] = { ...member, state: "failed", ...(error instanceof ManagementError ? { httpStatus: error.status } : {}) };
          else { stopped = true; failure = error; }
        }
        try { await checkpoint(); } catch (error) { stopped = true; failure = error; }
      }
    }));
    if (stopped) {
      saved.status = "interrupted"; await checkpoint(true);
      throw new CliError(`${failure instanceof CliError ? failure.message : "The capture download could not finish."} Partial download evidence is preserved at ${artifact}.`);
    }
    await checkpoint(true);
    const scopes = new Set(saved.members.map(member => canonicalJson([member.projectId, member.workloadId])));
    if (settings.includePayload && scopes.size === 1 && saved.members[0]?.workloadId && saved.retrieved > 0) {
      const index = saved.entries.filter(entry => entry?.state === "available").map(entry => JSON.stringify({ request_id: entry!.requestId, file: entry!.file, size: entry!.bytes, content_sha256: entry!.sha256 })).join("\n") + "\n";
      saved.importIndex = "import-index.jsonl"; await storage.write(path.join(directory, saved.importIndex), index);
    }
    saved.status = saved.missing || saved.failed ? "complete_with_gaps" : "complete"; await checkpoint(true);
    return { schemaVersion: 2, downloadId: saved.downloadId, directory, artifact, status: saved.status, requested: saved.requested, retrieved: saved.retrieved, missing: saved.missing, failed: saved.failed, includePayload: saved.includePayload, coverage: saved.coverage, integrity: saved.integrity, importIndex: saved.importIndex ? path.join(directory, saved.importIndex) : null };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
