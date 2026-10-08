import { z } from "zod";

import type { CredentialStore } from "../auth/credentials.js";
import { defaultManagementUrl, requestManagementJson } from "../management/client.js";
import { resolveManagementSession } from "../management/session.js";
import { CliError } from "../errors.js";
import { readInferenceModels } from "../inference/client.js";
import type { InferenceCredentialStore } from "../inference/credentials.js";
import { matchesInferenceService } from "../inference/scope.js";

export const routableModelIdPattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

const managementModelSchema = z.object({
  id: z.string().regex(routableModelIdPattern),
  display_name: z.string().min(1),
  is_open_weight: z.boolean().optional(),
});

const modelListResponseSchema = z.object({
  models: z.array(managementModelSchema),
});

const wireShapeSchema = z.enum(["openai-chat", "anthropic-messages"]);
const gatewayModelSchema = z.object({
  id: z.string().regex(routableModelIdPattern),
  display_name: z.string().min(1).optional(),
  is_open_weight: z.boolean().optional(),
  wire_shapes: z.array(wireShapeSchema).refine(shapes => new Set(shapes).size === shapes.length).nullable().optional(),
});
const gatewayModelsSchema = z.object({ data: z.array(gatewayModelSchema) });

export interface ModelSummary {
  id: string;
  displayName: string;
  openWeight: boolean | null;
  wireShapes?: z.infer<typeof wireShapeSchema>[] | null;
}

export interface ModelListResult {
  models: ModelSummary[];
  source?: "gateway_catalog";
  missingCapabilities?: typeof modelCapabilityGap[];
}

// Preserve the diagnostic code without advertising a capability API that does
// not exist. Catalog availability alone does not establish workload compatibility.
export const modelCapabilityGap = {
  code: "missing_capability" as const,
  reason: "The catalog lists available model identities, but does not publish endpoint or tool support, context limits, response formats, reasoning parameters, or pricing.",
  unknownPolicy: "Unavailable metadata must be null or explicitly unknown. Empty supported-value lists mean none only when the authoritative catalog says so.",
};

export const gatewayModelCapabilityGap = {
  ...modelCapabilityGap,
  reason: "The gateway catalog declares active API protocol mappings when available, but does not publish tool support, context limits, response formats, reasoning parameters, pricing, or current serving health.",
};

export interface ModelCatalogSelection {
  gateway?: boolean;
}

interface ListModelsOptions extends ModelCatalogSelection {
  store: CredentialStore;
  inferenceStore?: InferenceCredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

export async function listModels(
  options: ListModelsOptions,
): Promise<ModelListResult> {
  if (options.gateway) return listGatewayModels(options);
  const response = await loadModels(options);
  return {
    missingCapabilities: [modelCapabilityGap],
    models: response.models.map((model) => ({
      id: model.id,
      displayName: model.display_name,
      openWeight: model.is_open_weight ?? null,
    })),
  };
}

async function listGatewayModels(options: ListModelsOptions): Promise<ModelListResult> {
  const session = await resolveManagementSession(options);
  const credential = await options.inferenceStore?.read();
  if (!credential) throw new CliError("Understudy is not set up. Run `understudy setup` before reading the gateway catalog.");
  if (credential.organizationId !== session.organizationId) {
    throw new CliError("Stored Understudy access belongs to another organization. Sign in with that organization.");
  }
  if (!matchesInferenceService(credential, session.baseUrl ?? defaultManagementUrl)) {
    throw new CliError("Stored Understudy access belongs to another service. Configure access for the active service before reading its gateway catalog.");
  }
  const response = gatewayModelsSchema.safeParse(await readInferenceModels(credential, options.fetchImplementation));
  if (!response.success || new Set(response.data.data.map(model => model.id)).size !== response.data.data.length) {
    throw new CliError("Understudy returned an invalid gateway model list. Try again shortly.");
  }
  return {
    source: "gateway_catalog",
    missingCapabilities: [gatewayModelCapabilityGap],
    models: response.data.data.map(model => ({
      id: model.id,
      displayName: model.display_name ?? model.id,
      openWeight: model.is_open_weight ?? null,
      wireShapes: model.wire_shapes ?? null,
    })),
  };
}

async function loadModels(options: ListModelsOptions) {
  const session = await resolveManagementSession({
    store: options.store,
    baseUrl: options.baseUrl,
    fetchImplementation: options.fetchImplementation,
  });
  const response = await requestManagementJson(
    session,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/models`,
      action: "Model listing",
      invalidResponseMessage:
        "Understudy returned an invalid model list. Try again shortly.",
    },
    modelListResponseSchema,
  );
  if (new Set(response.models.map((model) => model.id)).size !== response.models.length) {
    throw new CliError("Understudy returned an invalid model list. Try again shortly.");
  }

  return response;
}

export interface ModelDetailResult {
  model: ModelSummary;
  source: "organization_catalog" | "gateway_catalog";
  inferenceCapabilities: null;
  missingCapabilities: typeof modelCapabilityGap[];
}

export async function showModel(options: ListModelsOptions, modelId: string): Promise<ModelDetailResult> {
  if (!routableModelIdPattern.test(modelId)) throw new CliError("Use an exact model id from `understudy models list`.");
  const result = await listModels(options);
  const entry = result.models.find((model) => model.id === modelId);
  if (!entry) throw new CliError("Model was not found in the authenticated organization's catalog.");
  return { model: entry, source: result.source ?? "organization_catalog", inferenceCapabilities: null,
    missingCapabilities: result.missingCapabilities ?? [modelCapabilityGap] };
}
