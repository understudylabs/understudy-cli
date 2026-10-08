import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { createPrivateJsonStore, type PrivateJsonStore } from "../storage/private-json.js";

const savedContextSchema = z.object({
  organizationId: z.string().min(1),
  project: z.object({ id: z.string().min(1), slug: z.string().min(1), name: z.string().min(1) }).strict(),
  workload: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict().optional(),
}).strict();
const contextStateSchema = z.object({
  version: z.literal(1),
  applications: z.record(z.string().regex(/^[a-f0-9]{64}$/), savedContextSchema),
}).strict();

export type SavedContext = z.infer<typeof savedContextSchema>;
export type ContextState = z.infer<typeof contextStateSchema>;
export type ContextStore = PrivateJsonStore<ContextState>;

export function createContextStore(options: { directory?: string } = {}): ContextStore {
  return createPrivateJsonStore({
    directory: options.directory ?? path.join(homedir(), ".understudy"),
    fileName: "contexts.json", label: "application context", schema: contextStateSchema,
  });
}

export async function applicationContextKey(cwd = process.cwd()): Promise<string> {
  return createHash("sha256").update(await realpath(cwd)).digest("hex");
}
