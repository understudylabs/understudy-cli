import { z } from "zod";
import { createCredentialStore, type CredentialStore } from "../auth/credentials.js";
import { CliError } from "../errors.js";
import { requestManagementJson, type ManagementOptions } from "../management/client.js";
import { listManagementProjects } from "../management/projects.js";
import { resolveManagementSession } from "../management/session.js";
import type { Scope } from "./contracts.js";
export interface ScopeOptions {
    project: string;
    workload: string;
    org?: string;
}
export interface SessionOptions {
    store?: CredentialStore;
    baseUrl?: string;
    fetchImplementation?: typeof fetch;
}
export async function migrationSession(options: SessionOptions = {}): Promise<ManagementOptions> {
    return resolveManagementSession({ ...options, store: options.store ?? createCredentialStore() });
}
export function validateScopeInput(input: ScopeOptions): void {
    for (const value of [input.project, input.workload, input.org].filter((value) => value !== undefined)) {
        if (!value.trim() || value.length > 255 || /[{}<>\u0000-\u001f]/.test(value))
            throw new CliError("Supply exact project, workload, and organization selectors; template placeholders are not accepted.");
    }
}
export async function resolveScope(input: ScopeOptions, session: ManagementOptions): Promise<Scope> {
    validateScopeInput(input);
    if (input.org && input.org !== session.organizationId)
        throw new CliError("The requested organization does not match the authenticated organization.");
    const matches = (await listManagementProjects(session)).filter((p) => [p.id, p.slug, p.name].includes(input.project));
    if (matches.length !== 1)
        throw new CliError("Project resolution requires exactly one matching id, slug, or name.");
    const project = matches[0]!;
    const response = await requestManagementJson(session, {
        path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/projects/${encodeURIComponent(project.id)}/workloads`, action: "Migration scope resolution",
    }, z.object({ workloads: z.array(z.object({ id: z.string(), project_id: z.string(), name: z.string(), capture_enabled: z.boolean() })) }));
    if (response.workloads.some((w) => w.project_id !== project.id))
        throw new CliError("Workload listing did not match the requested project.");
    const workloads = response.workloads.filter((w) => w.id === input.workload || w.name === input.workload);
    if (workloads.length !== 1)
        throw new CliError("Workload resolution requires exactly one matching id or name in the selected project.");
    const workload = workloads[0]!;
    return { organization: { id: session.organizationId }, project, workload: { id: workload.id, name: workload.name, captureEnabled: workload.capture_enabled } };
}
export function capturePath(scope: Scope): string {
    return `/admin/v1/orgs/${encodeURIComponent(scope.organization.id)}/projects/${encodeURIComponent(scope.project.id)}/workloads/${encodeURIComponent(scope.workload.id)}/captures`;
}
