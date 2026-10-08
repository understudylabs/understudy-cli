import { z } from "zod";

import { CliError } from "../errors.js";
import { requestManagementJson } from "../management/client.js";
import { listManagementProjects, type Project } from "../management/projects.js";
import { resolveManagementSession, type ManagementSession, type ManagementSessionOptions } from "../management/session.js";
import { applicationContextKey, createContextStore, type ContextStore, type SavedContext } from "./storage.js";

export interface ManagementScopeOptions extends ManagementSessionOptions {
  contextStore?: ContextStore;
  cwd?: string;
}

export interface ScopeSelectors {
  org?: string;
  project?: string;
  workload?: string;
  requireProject?: boolean;
  requireWorkload?: boolean;
  useDefaults?: boolean;
  ignoreDefaults?: boolean;
  ignoreWorkloadDefault?: boolean;
}

export interface ResolvedScope {
  session: ManagementSession;
  project?: Project;
  workload?: { id: string; name: string; projectId: string };
}

const workloadPageSchema = z.object({
  workloads: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), project_id: z.string().min(1) })),
  cursor: z.string().min(1).nullable().optional(),
});

export async function readApplicationContext(options: Pick<ManagementScopeOptions, "contextStore" | "cwd"> = {}): Promise<SavedContext | null> {
  const state = await (options.contextStore ?? createContextStore()).read();
  if (!state) return null;
  return state.applications[await applicationContextKey(options.cwd)] ?? null;
}

export async function resolveManagementScope(options: ManagementScopeOptions, selectors: ScopeSelectors = {}): Promise<ResolvedScope> {
  for (const selector of [selectors.org, selectors.project, selectors.workload]) {
    if (selector !== undefined && (!selector.trim() || selector.length > 255)) {
      throw new CliError("Scope selectors must contain between 1 and 255 characters.");
    }
  }
  const session = await resolveManagementSession(options);
  if (selectors.org !== undefined && selectors.org !== session.organizationId) {
    throw new CliError("The selected organization does not match the authenticated organization. Sign in with the intended organization.");
  }
  const saved = selectors.ignoreDefaults || selectors.useDefaults === false ? null : await readApplicationContext(options);
  if (saved && saved.organizationId !== session.organizationId) {
    throw new CliError("Saved context belongs to another organization. Run `understudy context clear` or set context for the signed-in organization.");
  }
  const projectSelector = selectors.project ?? saved?.project.id;
  if (!projectSelector) {
    if (selectors.requireProject || selectors.requireWorkload || selectors.workload) {
      throw new CliError("Select a project with --project or `understudy context set --project`.");
    }
    return { session };
  }
  const projects = await listManagementProjects(session);
  const candidates = projects.filter((project) => project.id === projectSelector || project.slug === projectSelector || project.name === projectSelector);
  if (candidates.length !== 1) {
    throw new CliError(candidates.length ? "The project selector is ambiguous." : "The selected project was not found in the authenticated organization.");
  }
  const project = candidates[0]!;
  const workloadSelector = selectors.workload ?? (!selectors.ignoreWorkloadDefault && saved?.project.id === project.id ? saved.workload?.id : undefined);
  if (!workloadSelector) {
    if (selectors.requireWorkload) throw new CliError("Select a workload with --workload or `understudy context set --workload`.");
    return { session, project };
  }
  const workloads: Array<{ id: string; name: string; project_id: string }> = [];
  const seen = new Set<string>();
  const seenIds = new Set<string>(), seenNames = new Set<string>();
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const page: z.infer<typeof workloadPageSchema> = await requestManagementJson(session, {
      path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/projects/${encodeURIComponent(project.id)}/workloads${query}`,
      action: "Resolve workload scope",
    }, workloadPageSchema);
    if (page.workloads.some((workload) => workload.project_id !== project.id)) {
      throw new CliError("Understudy returned a workload outside the selected project.");
    }
    for (const workload of page.workloads) {
      if (seenIds.has(workload.id) || seenNames.has(workload.name)) {
        throw new CliError("Understudy returned a workload listing with repeated ids or names.");
      }
      seenIds.add(workload.id);
      seenNames.add(workload.name);
    }
    workloads.push(...page.workloads);
    cursor = page.cursor ?? null;
    if (cursor) {
      if (seen.has(cursor)) throw new CliError("Understudy repeated a workload cursor.");
      seen.add(cursor);
    }
  } while (cursor !== null);
  const matches = workloads.filter((workload) => workload.id === workloadSelector || workload.name === workloadSelector);
  if (matches.length !== 1) throw new CliError(matches.length ? "The workload selector is ambiguous." : "The selected workload was not found in the selected project.");
  return { session, project, workload: { id: matches[0]!.id, name: matches[0]!.name, projectId: project.id } };
}

export async function setApplicationContext(options: ManagementScopeOptions, selectors: Pick<ScopeSelectors, "org" | "project" | "workload">): Promise<SavedContext> {
  if (selectors.project === undefined && selectors.workload === undefined) {
    throw new CliError("Provide --project and/or --workload to set context.");
  }
  // An explicit project starts a new selection, even when replacing a stale
  // saved context from a previous identity.
  const scope = await resolveManagementScope(options, { ...selectors, requireProject: true, ignoreDefaults: selectors.project !== undefined });
  const saved: SavedContext = {
    organizationId: scope.session.organizationId,
    project: scope.project!,
    ...(scope.workload ? { workload: { id: scope.workload.id, name: scope.workload.name } } : {}),
  };
  const store = options.contextStore ?? createContextStore();
  const state = await store.read() ?? { version: 1 as const, applications: {} };
  state.applications[await applicationContextKey(options.cwd)] = saved;
  await store.write(state);
  return saved;
}

export async function clearApplicationContext(options: Pick<ManagementScopeOptions, "contextStore" | "cwd"> = {}): Promise<void> {
  const store = options.contextStore ?? createContextStore();
  const state = await store.read();
  if (!state) return;
  delete state.applications[await applicationContextKey(options.cwd)];
  await store.write(state);
}
