import type { CredentialStore } from "../auth/credentials.js";
import { resolveManagementSession } from "../management/session.js";
import { defaultManagementUrl } from "../management/client.js";
import { CliError } from "../errors.js";
import {
  testInference,
  type InferenceApi,
  type InferenceTestResult,
} from "../inference/client.js";
import type { InferenceCredentialStore } from "../inference/credentials.js";
import { matchesInferenceService } from "../inference/scope.js";

interface TestOptions {
  authStore: CredentialStore;
  inferenceStore: InferenceCredentialStore;
  api: InferenceApi;
  project: string;
  workload: string;
  model: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

export async function runTest(options: TestOptions): Promise<InferenceTestResult> {
  const session = await resolveManagementSession({
    store: options.authStore,
    baseUrl: options.baseUrl,
    fetchImplementation: options.fetchImplementation,
  });
  const organizationId = session.organizationId;
  const credential = await options.inferenceStore.read();
  if (!credential) {
    throw new CliError("Understudy is not set up. Run `understudy setup`.");
  }
  if (credential.organizationId !== organizationId) {
    throw new CliError(
      "Stored Understudy access belongs to another organization. Sign in with that organization.",
    );
  }
  if (!matchesInferenceService(credential, session.baseUrl ?? defaultManagementUrl)) {
    throw new CliError("Stored Understudy access belongs to another service. Run `understudy setup --replace` to configure access for the active service before sending inference.");
  }
  return testInference({
    credential,
    api: options.api,
    project: options.project,
    workload: options.workload,
    model: options.model,
    fetchImplementation: options.fetchImplementation,
    now: options.now,
  });
}
