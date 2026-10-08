import type { CredentialStore } from "../auth/credentials.js";
import { resolveManagementSession } from "../management/session.js";
import {
  createApplicationCredential,
  defaultManagementUrl,
  revokeApplicationCredential,
} from "../management/client.js";
import { CliError } from "../errors.js";
import type { InferenceCredentialStore } from "./credentials.js";

export type InferenceSetupResult = {
  status: "created" | "existing" | "replaced";
};

interface InferenceSetupOptions {
  authStore: CredentialStore;
  inferenceStore: InferenceCredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  replace?: boolean;
}

export async function setupInference(
  options: InferenceSetupOptions,
): Promise<InferenceSetupResult> {
  const session = await resolveManagementSession({
    store: options.authStore,
    baseUrl: options.baseUrl,
    fetchImplementation: options.fetchImplementation,
  });
  const { accessToken, organizationId } = session;
  return options.inferenceStore.withSetupLock(async () => {
    const existing = await options.inferenceStore.read();

    if (existing) {
      if (existing.organizationId !== organizationId) {
        throw new CliError(
          "Understudy is already set up for another organization.",
        );
      }
      if (!options.replace) return { status: "existing" };
    }

    if (!existing && session.credentialClass === "organization_key" && session.credentialId && !options.replace) {
      await options.inferenceStore.write({ version: 1, organizationId, keyId: session.credentialId,
        apiKey: session.accessToken, inferenceUrl: options.baseUrl ?? defaultManagementUrl });
      return { status: "created" };
    }

    const inferenceUrl = (options.baseUrl ?? defaultManagementUrl).replace(
      /\/+$/,
      "",
    );
    const existingUsesCurrentService =
      !existing || existing.inferenceUrl.replace(/\/+$/, "") === inferenceUrl;
    const created = await createApplicationCredential({
      credentialClass: session.credentialClass,
      accessToken,
      organizationId,
      baseUrl: inferenceUrl,
      fetchImplementation: options.fetchImplementation,
    });
    if (
      existing &&
      existingUsesCurrentService &&
      created.keyId === existing.keyId
    ) {
      throw new CliError(
        "Understudy returned an invalid replacement response, so the outcome is unknown. Check the dashboard before retrying.",
      );
    }

    try {
      await options.inferenceStore.write({
        version: 1,
        organizationId,
        keyId: created.keyId,
        apiKey: created.value,
        inferenceUrl,
      });
    } catch {
      try {
        await revokeApplicationCredential({
          credentialClass: session.credentialClass,
          accessToken,
          organizationId,
          keyId: created.keyId,
          baseUrl: inferenceUrl,
          fetchImplementation: options.fetchImplementation,
        });
      } catch {
        throw new CliError(
          "An inference credential was created but could not be stored or cleaned up. Revoke it in the Understudy dashboard before retrying.",
        );
      }
      throw new CliError(
        "The inference credential could not be stored, so it was revoked. Fix local storage and retry.",
      );
    }

    if (existing && !(session.credentialClass === "organization_key" && session.credentialId === existing.keyId)) {
      if (!existingUsesCurrentService) {
        throw new CliError(
          "Understudy access was replaced, but the prior credential belongs to a different Understudy service. Revoke it in that service's dashboard.",
        );
      }
      try {
        await revokeApplicationCredential({
          credentialClass: session.credentialClass,
          accessToken,
          organizationId,
          keyId: existing.keyId,
          baseUrl: inferenceUrl,
          fetchImplementation: options.fetchImplementation,
        });
      } catch {
        throw new CliError(
          "Understudy access was replaced, but the prior credential could not be cleaned up. Revoke it in the Understudy dashboard.",
        );
      }
    }

    return { status: existing ? "replaced" : "created" };
  });
}
