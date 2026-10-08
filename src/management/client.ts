import { z } from "zod";

import { CliError } from "../errors.js";

export const defaultManagementUrl = "https://api.understudylabs.com";

export interface ManagementOptions {
  accessToken: string;
  organizationId: string;
  credentialClass?: "oauth" | "organization_key";
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

export interface ManagementRequest {
  path: string;
  action: string;
  method?: string;
  body?: unknown;
  transportFailureMessage?: string;
  responseFailureMessage?: string;
  invalidResponseMessage?: string;
  responseFailureMessages?: Partial<Record<number, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class ManagementError extends CliError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class ManagementTransportError extends CliError {}

class ResponseSizeError extends Error {}

const defaultMaxResponseBytes = 16 * 1024 * 1024;

interface RevokeApplicationCredentialOptions extends ManagementOptions {
  keyId: string;
}

const applicationCredentialName = "Understudy CLI";
const invalidSetupResponseMessage =
  "Understudy returned an invalid setup response, so the outcome is unknown. Check the dashboard before retrying.";

const createCredentialResponseSchema = z.object({
  value: z.string().min(1),
  metadata: z.object({
    object: z.literal("api_key"),
    id: z.string().min(1),
    name: z.string().min(1),
    owner: z.object({
      type: z.literal("organization"),
      id: z.string().min(1),
    }),
  }),
});

const revokeCredentialResponseSchema = z.object({
  id: z.string().min(1),
  revoked: z.literal(true),
});

const createOutcomeUnknownMessage =
  "Understudy setup may have created a credential, so the outcome is unknown. Check the dashboard before retrying.";

export async function createApplicationCredential(
  options: ManagementOptions,
): Promise<{ keyId: string; value: string }> {
  const created = await requestManagementJson(
    options,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/api_keys`,
      action: "Understudy setup",
      method: "POST",
      body: { name: applicationCredentialName },
      transportFailureMessage: createOutcomeUnknownMessage,
      responseFailureMessage: createOutcomeUnknownMessage,
      invalidResponseMessage: invalidSetupResponseMessage,
    },
    createCredentialResponseSchema,
  );
  if (
    created.metadata.owner.id !== options.organizationId ||
    created.metadata.name !== applicationCredentialName
  ) {
    throw new CliError(invalidSetupResponseMessage);
  }
  return { keyId: created.metadata.id, value: created.value };
}

export async function revokeApplicationCredential(
  options: RevokeApplicationCredentialOptions,
): Promise<void> {
  const revoked = await requestManagementJson(
    options,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(
        options.organizationId,
      )}/api_keys/${encodeURIComponent(options.keyId)}`,
      action: "Setup credential cleanup",
      method: "DELETE",
      invalidResponseMessage:
        "Understudy returned an invalid cleanup response. Check the dashboard before retrying.",
    },
    revokeCredentialResponseSchema,
  );

  if (revoked.id !== options.keyId) {
    throw new CliError(
      "Understudy returned an invalid cleanup response. Check the dashboard before retrying.",
    );
  }
}

export async function requestManagementJson<T>(
  options: ManagementOptions,
  request: ManagementRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const maxResponseBytes = request.maxResponseBytes ?? defaultMaxResponseBytes;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new CliError("Management response byte limits must be positive integers.");
  }
  const baseUrl = (options.baseUrl ?? defaultManagementUrl).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${request.path}`);
  const orgPrefix = `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/`;
  const customerOrgPrefix = `/customer/v1/orgs/${encodeURIComponent(options.organizationId)}/`;
  const customerPath = url.pathname.startsWith("/customer/v1/");
  if (
    !options.organizationId ||
    !request.path.startsWith("/") || request.path.startsWith("//") ||
    url.origin !== new URL(baseUrl).origin || url.username || url.password ||
    (!url.pathname.startsWith(orgPrefix) && !url.pathname.startsWith(customerOrgPrefix))
  ) {
    throw new CliError("Management requests must remain inside the authenticated organization.");
  }
  if (customerPath && options.credentialClass !== "oauth") {
    throw new CliError("This operation requires browser OAuth. Run `understudy login`.");
  }
  const init: RequestInit = {
    method: request.method ?? "GET",
    ...(request.body === undefined
      ? {}
      : {
          body: JSON.stringify(request.body),
          headers: { "content-type": "application/json" },
        }),
  };
  let response: Response;
  try {
    response = await (options.fetchImplementation ?? fetch)(
      url.href,
      {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${options.accessToken}`,
          ...init.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
      },
    );
  } catch {
    throw new ManagementTransportError(
      request.transportFailureMessage ??
        `${request.action} could not reach Understudy. Try again shortly.`,
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ManagementError(
      request.responseFailureMessages?.[response.status] ?? request.responseFailureMessage ??
        `${request.action} failed (${response.status}). Try again shortly.`,
      response.status,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponse(response, maxResponseBytes);
  } catch (error) {
    if (error instanceof ResponseSizeError) {
      throw new CliError(request.invalidResponseMessage ??
        `${request.action} exceeded the ${maxResponseBytes}-byte response limit.`);
    }
    throw new ManagementTransportError(
      request.transportFailureMessage ?? `${request.action} could not finish reading Understudy's response. Try again shortly.`,
    );
  }

  try {
    return schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch {
    throw new CliError(
      request.invalidResponseMessage ??
        `Understudy returned an invalid response for ${request.action.toLowerCase()}. Try again shortly.`,
    );
  }
}

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseSizeError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new ResponseSizeError();
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
