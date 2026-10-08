import { z } from "zod";

import { resolveManagementScope, type ManagementScopeOptions } from "../context/service.js";
import {
  requestManagementJson,
  type ManagementOptions,
} from "../management/client.js";
import type { Project } from "../management/projects.js";
import { CliError } from "../errors.js";

const workloadNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const workloadSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  name: z.string().regex(workloadNamePattern),
  capture_enabled: z.boolean(),
  capture_sample_rate: z.number().min(0).max(1).nullable().optional().default(null),
  route_deployment_id: z.string().min(1).nullable(),
  route_model_id: z.string().min(1).nullable().optional().default(null),
  route_traffic_pct: z.number().int().min(0).max(100).optional().default(0),
  is_default: z.boolean(),
  created_at: z.string().min(1),
});

const workloadListSchema = z.object({
  workloads: z.array(workloadSchema),
  cursor: z.string().min(1).nullable().optional(),
});

type WorkloadRecord = z.infer<typeof workloadSchema>;

export interface WorkloadProject {
  id: string;
  slug: string;
  name: string;
}

export interface WorkloadView {
  id: string;
  projectId: string;
  name: string;
  captureEnabled: boolean;
  captureSampleRate: number | null;
  routeKind: "none" | "model" | "deployment";
  routeModelId: string | null;
  routeTrafficPercent: number;
  isDefault: boolean;
  createdAt: string;
}

export interface WorkloadListResult {
  project: WorkloadProject;
  workloads: WorkloadView[];
}

export interface WorkloadResult {
  project: WorkloadProject;
  workload: WorkloadView;
}

export interface CreateWorkloadInput {
  project?: string;
  name: string;
  capture?: boolean;
}

export interface ShowWorkloadInput {
  project?: string;
  workload: string;
}

export interface UpdateWorkloadInput extends ShowWorkloadInput {
  name?: string;
  capture?: boolean;
  captureSampleRate?: number;
}

export interface RouteWorkloadInput extends ShowWorkloadInput {
  modelId?: string;
  trafficPercent?: number;
  clear?: boolean;
  capture?: boolean;
}

export interface WorkloadsService {
  list(project?: string): Promise<WorkloadListResult>;
  create(input: CreateWorkloadInput): Promise<WorkloadResult>;
  show(input: ShowWorkloadInput): Promise<WorkloadResult>;
  update(input: UpdateWorkloadInput): Promise<WorkloadResult>;
  route(input: RouteWorkloadInput): Promise<WorkloadResult>;
}

type WorkloadsServiceOptions = ManagementScopeOptions;

const createOutcomeUnknownMessage =
  "Workload creation may have succeeded, so the outcome is unknown. List workloads before retrying.";
const updateOutcomeUnknownMessage =
  "The workload update may have succeeded, so the outcome is unknown. Show the workload before retrying.";

export function createWorkloadsService(
  options: WorkloadsServiceOptions,
): WorkloadsService {
  const projectScope = async (selector?: string) => {
    if (selector !== undefined) validateSelector(selector, "project");
    const scope = await resolveManagementScope(options, { project: selector, requireProject: true,
      ignoreDefaults: selector !== undefined, ignoreWorkloadDefault: true });
    return { currentSession: scope.session, project: scope.project! };
  };

  return {
    async list(projectSelector) {
      const { currentSession, project } = await projectScope(projectSelector);
      const workloads = await loadWorkloads(currentSession, project);
      return {
        project: normalizeProject(project),
        workloads: workloads.map(normalizeWorkload),
      };
    },

    async create(input) {
      if (input.project !== undefined) validateSelector(input.project, "project");
      validateWorkloadName(input.name);
      const { currentSession, project } = await projectScope(input.project);
      const captureEnabled = input.capture ?? false;
      const workload = await requestManagementJson(
        currentSession,
        {
          path: workloadsPath(currentSession.organizationId, project.id),
          action: "Workload creation",
          method: "POST",
          body: {
            name: input.name,
            capture_enabled: captureEnabled,
          },
          transportFailureMessage: createOutcomeUnknownMessage,
          responseFailureMessage: createOutcomeUnknownMessage,
          invalidResponseMessage: createOutcomeUnknownMessage,
        },
        workloadSchema,
      );
      requireWorkloadScope(workload, project.id, createOutcomeUnknownMessage);
      requireWorkloadChanges(
        workload,
        { name: input.name, capture_enabled: captureEnabled },
        createOutcomeUnknownMessage,
      );
      return {
        project: normalizeProject(project),
        workload: normalizeWorkload(workload),
      };
    },

    async show(input) {
      if (input.project !== undefined) validateSelector(input.project, "project");
      validateSelector(input.workload, "workload");
      const { currentSession, project } = await projectScope(input.project);
      const workloads = await loadWorkloads(currentSession, project);
      const matched = resolveWorkload(workloads, input.workload, project.slug);
      return {
        project: normalizeProject(project),
        workload: normalizeWorkload(matched),
      };
    },

    async update(input) {
      if (input.name === undefined && input.capture === undefined && input.captureSampleRate === undefined) {
        throw new CliError(
          "Provide at least one workload change with --name, --capture on|off, or --capture-sample-rate.",
        );
      }
      if (input.project !== undefined) validateSelector(input.project, "project");
      validateSelector(input.workload, "workload");
      if (input.name !== undefined) validateWorkloadName(input.name);
      if (input.captureSampleRate !== undefined) validateCaptureSampleRate(input.captureSampleRate);

      const { currentSession, project } = await projectScope(input.project);
      const workloads = await loadWorkloads(currentSession, project);
      const matched = resolveWorkload(workloads, input.workload, project.slug);
      const body: { name?: string; capture_enabled?: boolean; capture_sample_rate?: number } = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.capture !== undefined) body.capture_enabled = input.capture;
      if (input.captureSampleRate !== undefined) body.capture_sample_rate = input.captureSampleRate;

      const workload = await requestManagementJson(
        currentSession,
        {
          path: workloadPath(
            currentSession.organizationId,
            project.id,
            matched.id,
          ),
          action: "Workload update",
          method: "PATCH",
          body,
          transportFailureMessage: updateOutcomeUnknownMessage,
          responseFailureMessage: updateOutcomeUnknownMessage,
          invalidResponseMessage: updateOutcomeUnknownMessage,
        },
        workloadSchema,
      );
      requireWorkloadScope(
        workload,
        project.id,
        updateOutcomeUnknownMessage,
        matched.id,
      );
      requireWorkloadChanges(workload, body, updateOutcomeUnknownMessage);
      return {
        project: normalizeProject(project),
        workload: normalizeWorkload(workload),
      };
    },

    async route(input) {
      validateSelector(input.workload, "workload");
      if (input.clear ? input.modelId !== undefined || input.trafficPercent !== undefined : !input.modelId) {
        throw new CliError("Use --model-id with optional --traffic-pct, or --clear by itself.");
      }
      if (input.modelId !== undefined && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(input.modelId)) {
        throw new CliError("Provide a valid model id.");
      }
      const trafficPercent = input.clear ? 0 : input.trafficPercent ?? 10;
      validateTrafficPercent(trafficPercent);
      const { currentSession, project } = await projectScope(input.project);
      const matched = resolveWorkload(await loadWorkloads(currentSession, project), input.workload, project.slug);
      const failure = "The workload route may have changed, so the outcome is unknown. Show the workload before retrying.";
      const result = await requestManagementJson(currentSession, {
        path: `${workloadPath(currentSession.organizationId, project.id, matched.id)}/route`,
        action: "Workload route update", method: "PUT",
        body: { model_id: input.clear ? null : input.modelId,
          ...(!input.clear ? { route_traffic_pct: trafficPercent } : {}),
          ...(input.capture === undefined ? {} : { capture_enabled: input.capture }) },
        transportFailureMessage: failure, responseFailureMessage: failure, invalidResponseMessage: failure,
      }, z.object({ workload: workloadSchema, model: z.object({ id: z.string().min(1) }).nullable() }));
      requireWorkloadScope(result.workload, project.id, failure, matched.id);
      if (result.workload.route_deployment_id !== null || result.workload.route_model_id !== (input.clear ? null : input.modelId)
        || result.workload.route_traffic_pct !== trafficPercent || result.model?.id !== (input.clear ? undefined : input.modelId)
        || (input.capture !== undefined && result.workload.capture_enabled !== input.capture)) throw new CliError(failure);
      return { project: normalizeProject(project), workload: normalizeWorkload(result.workload) };
    },
  };
}

export function validateTrafficPercent(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new CliError("Traffic percentage must be an integer between 0 and 100.");
}

async function loadWorkloads(
  session: ManagementOptions,
  project: Project,
): Promise<WorkloadRecord[]> {
  const workloads: WorkloadRecord[] = [];
  const seenCursors = new Set<string>();
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  let cursor: string | null = null;
  do {
    const response: z.infer<typeof workloadListSchema> = await requestManagementJson(
      session,
      {
        path: workloadsPath(session.organizationId, project.id) + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
        action: "List workloads",
      },
      workloadListSchema,
    );
    if (response.workloads.some((workload) => workload.project_id !== project.id)) {
      throw new CliError("Understudy returned an invalid workload listing. Try again shortly.");
    }
    for (const workload of response.workloads) {
      if (seenIds.has(workload.id) || seenNames.has(workload.name)) throw invalidWorkloadListing();
      seenIds.add(workload.id);
      seenNames.add(workload.name);
    }
    workloads.push(...response.workloads);
    cursor = response.cursor ?? null;
    if (cursor) {
      if (seenCursors.has(cursor)) throw invalidWorkloadListing();
      seenCursors.add(cursor);
    }
  } while (cursor);
  return workloads;
}

function resolveWorkload(
  workloads: readonly WorkloadRecord[],
  selector: string,
  projectSlug: string,
): WorkloadRecord {
  const matches = workloads.filter(
    (workload) => workload.id === selector || workload.name === selector,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw invalidWorkloadListing();

  throw new CliError(
    `No workload matched that exact id or name in project ${projectSlug}.`,
  );
}

function requireWorkloadScope(
  workload: WorkloadRecord,
  projectId: string,
  failureMessage: string,
  workloadId?: string,
): void {
  if (
    workload.project_id !== projectId ||
    (workloadId !== undefined && workload.id !== workloadId)
  ) {
    throw new CliError(failureMessage);
  }
}

function requireWorkloadChanges(
  workload: WorkloadRecord,
  expected: { name?: string; capture_enabled?: boolean; capture_sample_rate?: number },
  failureMessage: string,
): void {
  if (
    (expected.name !== undefined && workload.name !== expected.name) ||
    (expected.capture_enabled !== undefined &&
      workload.capture_enabled !== expected.capture_enabled) ||
    (expected.capture_sample_rate !== undefined && workload.capture_sample_rate !== expected.capture_sample_rate)
  ) {
    throw new CliError(failureMessage);
  }
}

export function validateCaptureSampleRate(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CliError("Capture sample rate must be a number between 0 and 1.");
  }
}

function invalidWorkloadListing(): CliError {
  return new CliError(
    "Understudy returned an ambiguous workload listing. Try again shortly.",
  );
}

function validateSelector(value: string, label: string): void {
  if (value.length < 1 || value.length > 255) {
    throw new CliError(`The ${label} selector must be between 1 and 255 characters.`);
  }
}

function validateWorkloadName(name: string): void {
  if (!workloadNamePattern.test(name)) {
    throw new CliError(
      "Workload names must start with a lowercase letter or number and contain only lowercase letters, numbers, underscores, or hyphens.",
    );
  }
}

function workloadsPath(organizationId: string, projectId: string): string {
  return `/admin/v1/orgs/${encodeURIComponent(
    organizationId,
  )}/projects/${encodeURIComponent(projectId)}/workloads`;
}

function workloadPath(
  organizationId: string,
  projectId: string,
  workloadId: string,
): string {
  return `${workloadsPath(organizationId, projectId)}/${encodeURIComponent(
    workloadId,
  )}`;
}

function normalizeProject(project: Project): WorkloadProject {
  return { id: project.id, slug: project.slug, name: project.name };
}

function normalizeWorkload(workload: WorkloadRecord): WorkloadView {
  const routeKind = workload.route_deployment_id
    ? "deployment"
    : workload.route_model_id
      ? "model"
      : "none";
  return {
    id: workload.id,
    projectId: workload.project_id,
    name: workload.name,
    captureEnabled: workload.capture_enabled,
    captureSampleRate: workload.capture_sample_rate,
    routeKind,
    routeModelId: workload.route_model_id,
    routeTrafficPercent:
      routeKind === "none" ? 0 : workload.route_traffic_pct,
    isDefault: workload.is_default,
    createdAt: workload.created_at,
  };
}
