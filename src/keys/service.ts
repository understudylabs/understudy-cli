import { z } from "zod";

import type { CredentialStore } from "../auth/credentials.js";
import { CliError } from "../errors.js";
import { defaultManagementUrl, requestManagementJson, type ManagementOptions } from "../management/client.js";
import { resolveManagementSession } from "../management/session.js";
import { createKeyStore, keyCredentialReference, type KeyStoreFactory } from "./credentials.js";

const metadataSchema = z.object({
  object: z.literal("api_key"),
  id: z.string().min(1),
  owner: z.object({ type: z.literal("organization"), id: z.string().min(1) }),
  name: z.string(),
  created_at: z.string().optional(),
  last_used_at: z.string().nullable().optional(),
});

export interface KeySummary { id: string; name: string; createdAt: string | null; lastUsedAt: string | null }
export interface KeyListResult {
  keys: KeySummary[];
  completeness: "unknown";
  limitation: string;
}
export interface CreatedKey { key: KeySummary; credentialReference: string; stored: true }
export interface RevokedKey { id: string; revoked: true; localCredentialRemoved: boolean }

interface KeysServiceOptions {
  store: CredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  keyStoreFactory?: KeyStoreFactory;
}

export interface KeysService {
  list(): Promise<KeyListResult>;
  create(input: { name: string }): Promise<CreatedKey>;
  revoke(input: { key: string; confirm?: boolean }): Promise<RevokedKey>;
}

const listLimitation = "The platform returns one key page without a continuation cursor; this list may be incomplete.";
const creationUnknown = "API key creation outcome is unknown. List keys or check the dashboard before retrying; the one-time value cannot be retrieved again.";
const revocationUnknown = "API key revocation outcome is unknown. Check the dashboard before retrying; gateway cache invalidation may still require support.";

export function createKeysService(options: KeysServiceOptions): KeysService {
  const getSession = () => resolveManagementSession(options);
  const keyStore = options.keyStoreFactory ?? createKeyStore;
  return {
    async list() {
      const session = await getSession();
      const keys = await listKeys(session);
      return { keys: keys.map(normalizeKey), completeness: "unknown", limitation: listLimitation };
    },
    async create(input) {
      if (!input.name.trim() || input.name.length > 120) throw new CliError("Key names must contain between 1 and 120 characters.");
      const session = await getSession();
      const response = await requestManagementJson(session, {
        path: keysPath(session), action: "API key creation", method: "POST", body: { name: input.name },
        transportFailureMessage: creationUnknown, responseFailureMessage: creationUnknown, invalidResponseMessage: creationUnknown,
      }, z.object({ value: z.string().min(1), metadata: metadataSchema }));
      if (response.metadata.owner.id !== session.organizationId || response.metadata.name !== input.name) throw new CliError(creationUnknown);
      const serviceUrl = new URL(session.baseUrl ?? defaultManagementUrl).origin;
      const reference = keyCredentialReference(serviceUrl, session.organizationId, response.metadata.id);
      const destination = keyStore(reference);
      let existing;
      try { existing = await destination.read(); } catch {
        throw new CliError("API key was created, but its private storage could not be checked. Check the dashboard before retrying. No secret was printed.");
      }
      if (existing) {
        throw new CliError("The created API key identity already has a private credential reference. Existing storage was preserved; check the dashboard before retrying.");
      }
      try {
        await destination.write({ version: 1, organizationId: session.organizationId, keyId: response.metadata.id, serviceUrl, value: response.value });
      } catch {
        // Only revoke the just-created, ownership-checked key when its value cannot be retained.
        try {
          await revokeKey(session, response.metadata.id);
        } catch {
          throw new CliError(`API key ${response.metadata.id} was created but private storage failed. Cleanup revocation is unconfirmed; revoke it in the dashboard. No secret was printed.`);
        }
        throw new CliError("Private API key storage failed. The newly created key was revoked. No secret was printed.");
      }
      return { key: normalizeKey(response.metadata), credentialReference: reference, stored: true };
    },
    async revoke(input) {
      if (input.confirm !== true) throw new CliError("API key revocation requires --confirm.");
      if (!input.key.trim() || input.key.length > 255) throw new CliError("Use an exact API key id.");
      const session = await getSession();
      const keys = await listKeys(session);
      if (!keys.some((entry) => entry.id === input.key)) {
        throw new CliError("API key was not found in the authenticated organization's returned key page. The platform does not expose pagination; check the dashboard for other keys.");
      }
      const reference = keyCredentialReference(session.baseUrl ?? defaultManagementUrl, session.organizationId, input.key);
      const local = keyStore(reference);
      // Reject corrupt local state before the remote mutation.
      const stored = await local.read();
      if (stored && (stored.organizationId !== session.organizationId || stored.keyId !== input.key || new URL(stored.serviceUrl).origin !== new URL(session.baseUrl ?? defaultManagementUrl).origin)) {
        throw new CliError("The locally stored API key does not match the selected organization and service.");
      }
      await revokeKey(session, input.key);
      try { await local.clear(); } catch {
        throw new CliError("API key was revoked, but its private local credential could not be removed.");
      }
      return { id: input.key, revoked: true, localCredentialRemoved: stored !== null };
    },
  };
}

async function listKeys(session: ManagementOptions): Promise<Array<z.infer<typeof metadataSchema>>> {
  const response = await requestManagementJson(session, { path: keysPath(session), action: "API key listing" }, z.object({ keys: z.array(metadataSchema) }));
  if (response.keys.some((key) => key.owner.id !== session.organizationId) || new Set(response.keys.map((key) => key.id)).size !== response.keys.length) {
    throw new CliError("Understudy returned an invalid API key list.");
  }
  return response.keys;
}

async function revokeKey(session: ManagementOptions, keyId: string): Promise<void> {
  const response = await requestManagementJson(session, {
    path: `${keysPath(session)}/${encodeURIComponent(keyId)}`, action: "API key revocation", method: "DELETE",
    transportFailureMessage: revocationUnknown, responseFailureMessage: revocationUnknown, invalidResponseMessage: revocationUnknown,
  }, z.object({ id: z.string().min(1), revoked: z.literal(true) }));
  if (response.id !== keyId) throw new CliError(revocationUnknown);
}

function keysPath(session: ManagementOptions): string {
  return `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/api_keys`;
}

function normalizeKey(key: z.infer<typeof metadataSchema>): KeySummary {
  return { id: key.id, name: key.name, createdAt: key.created_at ?? null, lastUsedAt: key.last_used_at ?? null };
}
