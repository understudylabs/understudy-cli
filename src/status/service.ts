import { z } from "zod";

import type { CredentialStore } from "../auth/credentials.js";
import { getAuthenticationStatus } from "../auth/service.js";
import { defaultManagementUrl, requestManagementJson } from "../management/client.js";
import { resolveManagementSession } from "../management/session.js";
import { CliError } from "../errors.js";
import { countInferenceModels } from "../inference/client.js";
import type { InferenceCredentialStore } from "../inference/credentials.js";
import { matchesInferenceService } from "../inference/scope.js";

const snapshotSchema = z.object({
  org_id: z.string().min(1),
  project_count: z.number().int().nonnegative(),
});

export interface StatusResult {
  authenticated: boolean;
  ready: boolean;
  organizationId: string | null;
  management: "connected" | "not-checked";
  access: "ready" | "setup-required" | "organization-mismatch" | "service-mismatch";
  projectCount: number | null;
  modelCount: number | null;
}

interface StatusOptions {
  authStore: CredentialStore;
  inferenceStore: InferenceCredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

export async function getStatus(options: StatusOptions): Promise<StatusResult> {
  const authentication = await getAuthenticationStatus(options.authStore);
  if (authentication.method === "none") {
    return {
      authenticated: false,
      ready: false,
      organizationId: null,
      management: "not-checked",
      access: "setup-required",
      projectCount: null,
      modelCount: null,
    };
  }

  const session = await resolveManagementSession({
    store: options.authStore,
    baseUrl: options.baseUrl,
    fetchImplementation: options.fetchImplementation,
  });
  const snapshot = await requestManagementJson(
    session,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/snapshot`,
      action: "Understudy status",
    },
    snapshotSchema,
  );
  if (snapshot.org_id !== session.organizationId) {
    throw new CliError("Understudy status returned the wrong organization.");
  }
  const credential = await options.inferenceStore.read();

  if (!credential) {
    return {
      authenticated: true,
      ready: false,
      organizationId: session.organizationId,
      management: "connected",
      access: "setup-required",
      projectCount: snapshot.project_count,
      modelCount: null,
    };
  }

  if (credential.organizationId !== session.organizationId) {
    return {
      authenticated: true,
      ready: false,
      organizationId: session.organizationId,
      management: "connected",
      access: "organization-mismatch",
      projectCount: snapshot.project_count,
      modelCount: null,
    };
  }

  if (!matchesInferenceService(credential, session.baseUrl ?? defaultManagementUrl)) {
    return {
      authenticated: true,
      ready: false,
      organizationId: session.organizationId,
      management: "connected",
      access: "service-mismatch",
      projectCount: snapshot.project_count,
      modelCount: null,
    };
  }

  const modelCount = await countInferenceModels(
    credential,
    options.fetchImplementation,
  );
  return {
    authenticated: true,
    ready: true,
    organizationId: session.organizationId,
    management: "connected",
    access: "ready",
    projectCount: snapshot.project_count,
    modelCount,
  };
}
