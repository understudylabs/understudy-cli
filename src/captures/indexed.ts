import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CliError } from "../errors.js";
import { requestManagementJson, defaultManagementUrl } from "../management/client.js";
import { exportDay, readIndex } from "../migrations/captures.js";
import { runSchema, type Run } from "../migrations/contracts.js";
import { MigrationStorage } from "../migrations/storage.js";
import type { RequestScope, RequestsOptions } from "../requests/service.js";
import { downloadOptions, MAX_METADATA_PAGE_BYTES, type DownloadOptions } from "./options.js";
import { workloadDay } from "./search.js";

export async function exportIndexedDay(scope: RequestScope, input: DownloadOptions & { date?: string; last?: string; environment?: string }, options: RequestsOptions) {
  const controls = downloadOptions(input);
  if (!controls.includePayload) throw new CliError("Indexed workload-day export requires --include-payload --yes.");
  if (!scope.project || !scope.workload) throw new CliError("Indexed workload-day export requires a project and workload.");
  if (input.resume === false) throw new CliError("Indexed workload-day export preserves its frozen source and always resumes; choose another output directory to start over.");
  if (input.environment !== undefined && input.environment !== "production") throw new CliError("Indexed workload-day export supports the production environment only.");
  if (input.downloadId && (input.out || input.output)) throw new CliError("Choose --download-id or --out.");
  const id = input.downloadId ?? `download-${randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id) || id.trim() !== id) throw new CliError("Invalid download id.");
  const standard = new MigrationStorage(options.cwd);
  const directory = input.out || input.output ? path.resolve(standard.project, (input.out ?? input.output)!) : path.join(standard.root, "downloads", id);
  class IndexedStorage extends MigrationStorage { override runPath(_runId: string) { return directory; } }
  const storage = new IndexedStorage(options.cwd);
  const artifact = path.join(directory, "run.json");
  const serviceOrigin = new URL(scope.session.baseUrl ?? defaultManagementUrl).origin;
  return storage.locked(id, async () => {
    try { await storage.read(path.join(directory, "manifest.json"), MAX_METADATA_PAGE_BYTES); throw new CliError("This directory contains a customer capture download. Choose another directory for indexed export."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let run: Run;
    try {
      run = runSchema.parse(JSON.parse((await storage.read(artifact, MAX_METADATA_PAGE_BYTES)).toString("utf8")));
      const source = z.object({ serviceOrigin: z.string() }).parse(await storage.json(path.join(directory, "source.json")));
      if (source.serviceOrigin !== serviceOrigin) throw new CliError("The saved indexed export belongs to another service origin.");
      if (run.scope.organization.id !== scope.session.organizationId || run.scope.project.id !== scope.project!.id || run.scope.workload.id !== scope.workload!.id || !run.captureWindow) throw new CliError("The saved indexed export belongs to another scope or has no frozen window.");
      if (input.date && run.captureWindow.from !== workloadDay({ date: input.date }).from) throw new CliError("The selected date differs from the saved indexed export.");
      if (input.last && input.last !== "1d") throw new CliError("Indexed capture export supports --last 1d.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const window = workloadDay(input);
      const response = await requestManagementJson(scope.session, { path: `/admin/v1/orgs/${encodeURIComponent(scope.session.organizationId)}/projects/${encodeURIComponent(scope.project!.id)}/workloads/${encodeURIComponent(scope.workload!.id)}`, action: "Indexed export workload", maxResponseBytes: MAX_METADATA_PAGE_BYTES }, z.object({ id: z.string(), project_id: z.string(), capture_enabled: z.boolean() }));
      if (response.id !== scope.workload!.id || response.project_id !== scope.project!.id) throw new CliError("The indexed export workload crossed its selected scope.");
      run = { schemaVersion: 1, runId: id, createdAt: new Date().toISOString(), mode: "mapping_only", captureWindow: window,
        scope: { organization: { id: scope.session.organizationId }, project: scope.project!, workload: { id: scope.workload!.id, name: scope.workload!.name, captureEnabled: response.capture_enabled } } };
      await storage.writeJson(path.join(directory, "source.json"), { serviceOrigin });
      await storage.writeJson(artifact, run);
    }
    const result = await exportDay(storage, run, run.captureWindow!.from.slice(0, 10), scope.session, options.fetchImplementation, run.captureWindow, true, undefined, controls);
    const index = await readIndex(storage, run);
    const importIndex = path.join(directory, "import-index.jsonl");
    await storage.write(importIndex, index.rows.map(row => JSON.stringify({ request_id: row.requestId, file: row.file, size: row.bytes, content_sha256: row.sha256 })).join("\n") + (index.rows.length ? "\n" : ""));
    await storage.writeJson(path.join(directory, "scope.json"), run.scope);
    return { ...result, downloadId: run.runId, directory, artifact, importIndex, scope: run.scope, window: run.captureWindow, source: "indexed-workload-window", integrity: "Saved raw object bytes are checked by scope, size, and SHA-256. This is distinct from request-log snapshot export." };
  });
}
