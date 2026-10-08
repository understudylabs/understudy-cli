import { Command } from "commander";
import { CliError } from "../errors.js";
import { ManagementError, ManagementTransportError } from "../management/client.js";
import { MigrationStorage } from "../migrations/storage.js";

export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_METADATA_BYTES = 64 * 1024 * 1024;
export const MAX_METADATA_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_MEMBERS = 100_000;
export interface DownloadOptions {
  output?: string; out?: string; downloadId?: string;
  includePayload?: boolean; yes?: boolean; concurrency?: number | string; retries?: number | string; resume?: boolean;
}
export function boundedInteger(value: number | string | undefined, name: string, minimum: number, maximum: number, fallback: number): number {
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new CliError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new CliError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return parsed;
}
export function downloadOptions(input: DownloadOptions) {
  if (input.includePayload && !input.yes) throw new CliError("Full capture payload output requires --include-payload --yes.");
  if (input.output && input.out && input.output !== input.out) throw new CliError("Choose one output path.");
  return { concurrency: boundedInteger(input.concurrency, "Concurrency", 1, 16, 4), retries: boundedInteger(input.retries, "Retries", 0, 5, 2), includePayload: input.includePayload === true, resume: input.resume !== false };
}
export function captureRequestId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new CliError("Supply a complete capture request id (UUID).");
  return id;
}
export function retryable(error: unknown): boolean {
  return error instanceof ManagementTransportError || (error instanceof ManagementError && ([408, 425, 429].includes(error.status) || (error.status >= 500 && error.status !== 501)));
}
export async function withRetry<T>(operation: () => Promise<T>, retries: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) { if (attempt >= retries || !retryable(error)) throw error; await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)); }
  }
}
export class MetadataBudget {
  private bytes = 0;
  private count = 0;
  add(value: unknown, count = 1): void {
    this.bytes += Buffer.byteLength(JSON.stringify(value)); this.count += count;
    if (this.bytes > MAX_METADATA_BYTES || this.count > MAX_MEMBERS) throw new CliError("Selection exceeds 100000 members or 64 MiB of metadata. Narrow the selection; no sampled result was returned.");
  }
}
export async function readIdFile(storage: MigrationStorage, file: string, normalize: (value: string) => string): Promise<string[]> {
  const bytes = await storage.read(file, 8 * 1024 * 1024);
  const lines = bytes.toString("utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!lines.length || lines.length > MAX_MEMBERS) throw new CliError("An ID file must contain from 1 to 100000 nonempty ID lines.");
  return [...new Set(lines.map(normalize))];
}
export function addDownloadOptions(command: Command): Command {
  return command.option("--out <directory>", "Private output directory inside the application's .understudy state.")
    .option("--download-id <id>", "Stable private download id; reuse it to resume the frozen selection.")
    .option("--concurrency <count>", "Concurrent capture lookups, 1 to 16 (default: 4).")
    .option("--retries <count>", "Retries for transient failures, 0 to 5 (default: 2).")
    .option("--no-resume", "Re-download the same frozen selection instead of reusing verified files.")
    .option("--include-payload", "Include captured request and response bodies in private output.")
    .option("--yes", "Confirm full payload output.");
}
