import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { CliError } from "../errors.js";
import { createPrivateJsonStore, type PrivateJsonStore } from "../storage/private-json.js";

const storedKeySchema = z.object({
  version: z.literal(1),
  organizationId: z.string().min(1),
  keyId: z.string().min(1),
  serviceUrl: z.string().url(),
  value: z.string().min(1),
}).strict();

export type StoredKey = z.infer<typeof storedKeySchema>;
export type KeyStoreFactory = (reference: string) => PrivateJsonStore<StoredKey>;

export function keyCredentialReference(serviceUrl: string, organizationId: string, keyId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([new URL(serviceUrl).origin, organizationId, keyId])).digest("hex");
  return `key:${digest}`;
}

export function createKeyStore(reference: string, directory = path.join(homedir(), ".understudy")): PrivateJsonStore<StoredKey> {
  if (!/^key:[a-f0-9]{64}$/.test(reference)) throw new CliError("Invalid private key reference.");
  return createPrivateJsonStore({ directory, fileName: `managed-${reference.replace(":", "-")}.json`, label: "managed API key", schema: storedKeySchema });
}

export async function readKeyCredential(reference: string, factory: KeyStoreFactory = createKeyStore): Promise<StoredKey> {
  const stored = await factory(reference).read();
  if (!stored || keyCredentialReference(stored.serviceUrl, stored.organizationId, stored.keyId) !== reference) {
    throw new CliError("The private key reference is missing or does not match its stored identity.");
  }
  return stored;
}
