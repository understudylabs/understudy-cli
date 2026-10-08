import type { CredentialStore } from "../auth/credentials.js";
import {
  getOAuthOrganizationId,
  getValidAccessToken,
} from "../auth/service.js";
import { z } from "zod";
import { CliError } from "../errors.js";
import { defaultManagementUrl, requestManagementJson, type ManagementOptions } from "./client.js";

export interface ManagementSessionOptions {
  store: CredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

export interface ManagementSession extends ManagementOptions {
  credentialClass: "oauth" | "organization_key";
  credentialId?: string;
}

export async function resolveManagementSession(
  options: ManagementSessionOptions,
): Promise<ManagementSession> {
  const stored = await options.store.read();
  if (stored?.method === "organization_key") {
    const service = new URL(stored.serviceUrl);
    const target = new URL(options.baseUrl ?? defaultManagementUrl);
    if (service.origin !== target.origin || service.username || service.password ||
      service.search || service.hash || service.pathname !== "/") {
      throw new CliError("Stored authentication belongs to another Understudy service. Sign in again.");
    }
    const session: ManagementSession = {
      accessToken: stored.apiKey,
      organizationId: stored.organizationId,
      credentialClass: "organization_key",
      credentialId: stored.keyId,
      baseUrl: options.baseUrl,
      fetchImplementation: options.fetchImplementation,
    };
    await verifyManagementIdentity(session);
    return session;
  }
  const accessToken = await getValidAccessToken({
    store: {
      read: async () => stored,
      write: (value) => options.store.write(value),
      clear: () => options.store.clear(),
    },
    fetchImplementation: options.fetchImplementation,
  });
  return {
    accessToken,
    organizationId: getOAuthOrganizationId(accessToken),
    credentialClass: "oauth",
    baseUrl: options.baseUrl,
    fetchImplementation: options.fetchImplementation,
  };
}

export async function verifyManagementIdentity(session: ManagementOptions): Promise<void> {
  const response = await requestManagementJson(session, {
    path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/snapshot`,
    action: "Verify authentication",
  }, z.object({ org_id: z.string().min(1) }));
  if (response.org_id !== session.organizationId) {
    throw new CliError("Understudy authentication returned a different organization.");
  }
}
