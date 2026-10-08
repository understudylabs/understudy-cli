import path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

import { setApplicationContext } from "../context/service.js";
import type { ContextStore } from "../context/storage.js";
import { CliError } from "../errors.js";
import type { InferenceCredentialStore } from "../inference/credentials.js";
import { defaultManagementUrl, revokeApplicationCredential } from "../management/client.js";
import { verifyManagementIdentity } from "../management/session.js";
import { createPrivateJsonStore, type PrivateJsonStore } from "../storage/private-json.js";
import type { CredentialStore } from "./credentials.js";

const pendingSchema = z.object({
  version: z.literal(1),
  serviceUrl: z.string().url(),
  completeUrl: z.string().url(),
  claimToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
}).strict();
export type PendingEmailLogin = z.infer<typeof pendingSchema>;
export type PendingEmailStore = PrivateJsonStore<PendingEmailLogin>;

export function createPendingEmailStore(options: { directory?: string } = {}): PendingEmailStore {
  return createPrivateJsonStore({ directory: options.directory ?? path.join(homedir(), ".understudy"),
    fileName: "email-login-pending.json", label: "pending sign-in", schema: pendingSchema });
}

interface EmailLoginOptions {
  store: CredentialStore;
  pendingStore: PendingEmailStore;
  inferenceStore: InferenceCredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  contextStore?: ContextStore;
  cwd?: string;
}

const discoverySchema = z.object({ agent_auth: z.object({
  register_uri: z.string().url(), claim_uri: z.string().url().optional(),
}) });
const registrationSchema = z.object({
  claim_token: z.string().min(1), claim_url: z.string().min(1).optional(),
  claim_token_expires: z.string().datetime({ offset: true }).optional(),
});
const claimSchema = z.object({
  status: z.literal("claimed"), credential_type: z.literal("api_key"),
  credential: z.string().min(1), org_id: z.string().min(1),
  api_key_id: z.string().min(1), gateway_url: z.string().url(),
  default_project: z.object({ id: z.string().min(1).optional(), slug: z.string().min(1), name: z.string().optional() }).optional(),
});

export async function beginEmailLogin(options: EmailLoginOptions, email: string): Promise<{ pending: true; expiresAt: string }> {
  const parsedEmail = z.string().trim().email().max(254).safeParse(email);
  if (!parsedEmail.success) throw new CliError("Provide a valid email address.");
  const now = (options.now ?? Date.now)();
  const prior = await options.pendingStore.read();
  if (prior && prior.expiresAt > now) {
    throw new CliError("An email sign-in is pending. Complete it with `understudy login --code <code>`, or clear it with `understudy auth clear` before requesting another code.");
  }
  const serviceUrl = trustedService(options.baseUrl ?? defaultManagementUrl);
  const discovery = await emailRequest(options, `${serviceUrl}/.well-known/oauth-authorization-server`, discoverySchema);
  const registerUrl = trustedEndpoint(discovery.agent_auth.register_uri, serviceUrl);
  const claimBase = discovery.agent_auth.claim_uri === undefined ? `${serviceUrl}/agent/auth/claim` : trustedEndpoint(discovery.agent_auth.claim_uri, serviceUrl);
  const registration = await emailRequest(options, registerUrl, registrationSchema, {
    type: "identity_assertion", assertion_type: "verified_email", assertion: parsedEmail.data, requested_credential_type: "api_key",
  });
  const completeUrl = trustedEndpoint(registration.claim_url ?? `${claimBase.replace(/\/$/, "")}/complete`, serviceUrl);
  const expiresAt = Math.min(now + 10 * 60_000, registration.claim_token_expires ? Date.parse(registration.claim_token_expires) : Infinity);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new CliError("The sign-in service returned an expired claim. Request a new code.");
  await options.pendingStore.write({ version: 1, serviceUrl, completeUrl, claimToken: registration.claim_token, expiresAt });
  return { pending: true, expiresAt: new Date(expiresAt).toISOString() };
}

export interface EmailLoginResult {
  authenticated: true;
  method: "organization_key";
  organizationId: string;
  inferenceReady: boolean;
  project?: { id: string; slug: string; name: string };
}

export async function completeEmailLogin(options: EmailLoginOptions, code: string): Promise<EmailLoginResult> {
  if (!/^[0-9]{6}$/.test(code.trim())) throw new CliError("The sign-in code must contain six digits.");
  const pending = await options.pendingStore.read();
  if (!pending) throw new CliError("No email sign-in is pending. Run `understudy login --email <email> --send-code`.");
  if (pending.expiresAt <= (options.now ?? Date.now)()) {
    await options.pendingStore.clear();
    throw new CliError("The email sign-in expired. Request a new code with `understudy login --email <email> --send-code`.");
  }
  const serviceUrl = trustedService(options.baseUrl ?? defaultManagementUrl);
  if (trustedService(pending.serviceUrl) !== serviceUrl) throw new CliError("Pending sign-in belongs to another service. Clear it and sign in again.");
  const completeUrl = trustedEndpoint(pending.completeUrl, serviceUrl);
  const claim = await emailRequest(options, completeUrl, claimSchema, { claim_token: pending.claimToken, code: code.trim() }, "verification");
  if (trustedService(claim.gateway_url) !== serviceUrl) throw new CliError("The sign-in service returned credentials for an unexpected service.");

  // Save the one-time credential before any verification request. A temporary
  // service outage must not discard the only recoverable copy of the key.
  try {
    await options.store.write({ version: 1, method: "organization_key", apiKey: claim.credential,
      organizationId: claim.org_id, keyId: claim.api_key_id, serviceUrl });
  } catch {
    let revoked = false;
    try {
      await revokeApplicationCredential({ accessToken: claim.credential, organizationId: claim.org_id,
        credentialClass: "organization_key", keyId: claim.api_key_id, baseUrl: serviceUrl,
        fetchImplementation: options.fetchImplementation });
      revoked = true;
    } catch { /* The sanitized error below states the unresolved cleanup. */ }
    let pendingCleared = false;
    try { await options.pendingStore.clear(); pendingCleared = true; }
    catch { /* A spent claim must never be described as retryable. */ }
    throw new CliError(`A sign-in credential was issued but could not be stored. ${revoked
      ? "It was revoked. Fix private storage before requesting a new sign-in."
      : "It could not be revoked. Revoke the newly issued key in the Understudy dashboard, then fix private storage before requesting a new sign-in."} ${pendingCleared
      ? "The spent pending claim was cleared."
      : "The spent pending claim could not be cleared; clear local authentication after fixing storage. Do not retry this code."}`);
  }
  await options.pendingStore.clear();
  const inferenceReady = await options.inferenceStore.withSetupLock(async () => {
    const existing = await options.inferenceStore.read();
    if (existing) {
      return existing.organizationId === claim.org_id && existing.inferenceUrl.replace(/\/+$/, "") === serviceUrl;
    }
    await options.inferenceStore.write({ version: 1, organizationId: claim.org_id, keyId: claim.api_key_id,
      apiKey: claim.credential, inferenceUrl: serviceUrl });
    return true;
  });
  await verifyManagementIdentity({ accessToken: claim.credential, organizationId: claim.org_id,
    credentialClass: "organization_key", baseUrl: serviceUrl, fetchImplementation: options.fetchImplementation });
  let project: EmailLoginResult["project"];
  if (claim.default_project) {
    try {
      // Resolve against the just-issued identity even if another invocation
      // replaces active credentials while this sign-in is completing.
      const context = await setApplicationContext({ ...options, baseUrl: serviceUrl, store: {
        ...options.store,
        read: async () => ({ version: 1, method: "organization_key", apiKey: claim.credential,
          organizationId: claim.org_id, keyId: claim.api_key_id, serviceUrl }),
      } }, { org: claim.org_id, project: claim.default_project.id ?? claim.default_project.slug });
      project = context.project;
    } catch {
      throw new CliError("Signed in, but the default project could not be verified or saved. Authentication was preserved. Use `context set --project <selector>` to configure this directory; do not request another sign-in.");
    }
  }
  return { authenticated: true, method: "organization_key", organizationId: claim.org_id, inferenceReady,
    ...(project ? { project } : {}) };
}

function trustedService(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError("The authentication service URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new CliError("Authentication requires an HTTPS service origin without credentials or URL parameters.");
  }
  return url.origin;
}

function trustedEndpoint(value: string, serviceUrl: string): string {
  let url: URL;
  try { url = new URL(value, `${serviceUrl}/`); } catch { throw new CliError("Authentication discovery returned an invalid endpoint."); }
  if (url.origin !== serviceUrl || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new CliError("Authentication discovery returned an untrusted endpoint.");
  }
  return url.href;
}

async function emailRequest<T>(options: EmailLoginOptions, url: string, schema: z.ZodType<T>, body?: unknown, phase: "request" | "verification" = "request"): Promise<T> {
  let response: Response;
  try {
    response = await (options.fetchImplementation ?? fetch)(url, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new CliError("The sign-in service did not return a response. The outcome may be unknown; inspect authentication status before retrying.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const requestId = response.headers.get("x-understudy-request-id");
    const correlation = requestId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)
      ? ` Request ID: ${requestId}.` : "";
    const recovery = phase === "verification" && (response.status === 401 || response.status === 403)
      ? " If the latest code is still rejected, use browser sign-in with `understudy login` instead of repeatedly requesting codes."
      : " Check `understudy auth status` before retrying.";
    throw new CliError(`Email sign-in failed (HTTP ${response.status}). Any existing pending sign-in was retained.${recovery}${correlation}`);
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65_536) throw new Error("oversized");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new CliError("The sign-in service returned an invalid response. Credential values and response bodies are not displayed.");
  }
}
