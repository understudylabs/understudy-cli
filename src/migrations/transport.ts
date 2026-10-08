import { z } from "zod";
import { CliError } from "../errors.js";
import { createInferenceCredentialStore, type InferenceCredential } from "../inference/credentials.js";
import { REQUEST_ENVIRONMENT_HEADER, TEST_REQUEST_ENVIRONMENT } from "../inference/request-environment.js";
import { defaultManagementUrl, requestManagementJson, type ManagementOptions } from "../management/client.js";
import type { Run, Scope } from "./contracts.js";
import { migrationSession, resolveScope, type SessionOptions } from "./scope.js";
import { MigrationStorage } from "./storage.js";
import { endpoints, type Protocol } from "./protocol.js";
import { canonical } from "./interactions.js";
export interface ExecutionOptions extends SessionOptions {
    credential?: () => Promise<Pick<InferenceCredential, "organizationId" | "apiKey" | "inferenceUrl"> | null>;
    environment?: Pick<NodeJS.ProcessEnv, "UNDERSTUDY_API_KEY">;
    target?: { project: string; workload: string };
}
async function replayCredential(target: Scope, session: ManagementOptions, options: ExecutionOptions) {
    if (options.credential) return options.credential();
    const apiKey = (options.environment ?? process.env).UNDERSTUDY_API_KEY;
    if (apiKey !== undefined) {
        if (!/^sk_[A-Za-z0-9_-]+$/.test(apiKey)) throw new CliError("UNDERSTUDY_API_KEY must contain a valid Understudy key.");
        // The server authenticates the key against the exact OAuth-selected scope.
        // A local organization label or a partial key inventory is not proof.
        await resolveScope({ project: target.project.id, workload: target.workload.id, org: target.organization.id }, { ...session, accessToken: apiKey });
        return { organizationId: target.organization.id, apiKey, inferenceUrl: session.baseUrl ?? defaultManagementUrl };
    }
    return createInferenceCredentialStore().read();
}

export async function modelTransport(storage: MigrationStorage, run: Run, model: string, options: ExecutionOptions) {
    const session = await migrationSession(options);
    const target = await resolveScope(options.target ?? { project: run.scope.project.id, workload: run.scope.workload.id, org: run.scope.organization.id }, session);
    const credential = await replayCredential(target, session, options);
    if (!credential || credential.organizationId !== target.organization.id) throw new CliError("Replay needs an existing inference credential for the selected execution organization.");
    const url = new URL(credential.inferenceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new CliError("Replay requires a trusted HTTPS inference base URL.");
    const catalog = await requestManagementJson(session, { path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/models`, action: "Replay model selection" }, z.object({ models: z.array(z.object({ id: z.string(), is_open_weight: z.boolean().optional() })) }));
    if (!catalog.models.some(m => m.id === model)) throw new CliError("Select an available catalog model.");
    return { target, requestEnvironment: TEST_REQUEST_ENVIRONMENT, async send(payload: Record<string, unknown>, protocol: Protocol) {
        const started = performance.now();
        const response = await (options.fetchImplementation ?? fetch)(`${credential.inferenceUrl.replace(/\/$/, "")}${endpoints[protocol]}`, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(180000),
            headers: { "content-type": "application/json", ...(protocol === "messages" ? { "x-api-key": credential.apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${credential.apiKey}` }), "x-understudy-project": target.project.slug, "x-understudy-workload": target.workload.name, [REQUEST_ENVIRONMENT_HEADER]: TEST_REQUEST_ENVIRONMENT },
            body: JSON.stringify(payload),
        });
        return { status: response.status, raw: await boundedBody(response), latencyMs: performance.now() - started,
            requestId: response.headers.get("x-understudy-request-id"), effectiveModel: response.headers.get("x-understudy-effective-model"), requestEnvironment: response.headers.get(REQUEST_ENVIRONMENT_HEADER) };
    } };
}
export function boundedRequest(request: Record<string, unknown>, protocol: Protocol, model: string, limit: number) {
    const { max_tokens, max_completion_tokens, max_output_tokens, ...fields } = request;
    const body = { ...fields, model, stream: true };
    const field = protocol === "messages" ? "max_tokens" : protocol === "responses" ? "max_output_tokens" : request.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
    const requested = request[field];
    return snapshotInput({ ...body, [field]: typeof requested === "number" && requested > 0 ? Math.min(requested, limit) : limit });
}
// Validate and own the same JSON representation used on the wire and in evidence.
export function snapshotInput<T>(value: T): T {
    canonical(value);
    const snapshot = JSON.parse(JSON.stringify(value)) as T;
    canonical(snapshot);
    return snapshot;
}
async function boundedBody(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16 * 1024 * 1024) throw new Error("response_size_limit"); chunks.push(part.value); }
        return Buffer.concat(chunks).toString("utf8");
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
