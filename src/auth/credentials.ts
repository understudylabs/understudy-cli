import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  createPrivateJsonStore,
  type PrivateJsonStore,
} from "../storage/private-json.js";

const credentialsFileName = "oauth-session.json";

const oauthCredentialsSchema = z
  .object({
    version: z.literal(1),
    method: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

const organizationKeySchema = z.object({
  version: z.literal(1),
  method: z.literal("organization_key"),
  apiKey: z.string().min(1),
  organizationId: z.string().min(1),
  keyId: z.string().min(1),
  serviceUrl: z.string().url(),
}).strict();

// Keep the existing filename so upgrades preserve the active identity. The
// discriminant, not the filename, determines which authentication is allowed.
const storedCredentialsSchema = z.discriminatedUnion("method", [
  oauthCredentialsSchema,
  organizationKeySchema,
]);

export type StoredCredentials = z.infer<typeof storedCredentialsSchema>;
export type CredentialStore = PrivateJsonStore<StoredCredentials>;

interface CredentialStoreOptions {
  directory?: string;
}

export function createCredentialStore(
  options: CredentialStoreOptions = {},
): CredentialStore {
  return createPrivateJsonStore({
    directory: path.resolve(
      options.directory ?? path.join(homedir(), ".understudy"),
    ),
    fileName: credentialsFileName,
    label: "authentication",
    schema: storedCredentialsSchema,
  });
}
