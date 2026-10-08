import { z } from "zod";

import { CliError } from "../errors.js";
import {
  requestManagementJson,
  type ManagementOptions,
} from "./client.js";

const projectSlugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

const projectResponseSchema = z
  .object({
    id: z.string().min(1),
    org_id: z.string().min(1),
    slug: z.string().regex(projectSlugPattern),
    name: z.string().min(1).max(120),
  })
  .passthrough();

const projectsResponseSchema = z
  .object({
    projects: z.array(projectResponseSchema),
    cursor: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export interface Project {
  id: string;
  slug: string;
  name: string;
}

export interface CreateProjectInput {
  slug: string;
  name?: string;
}

export function validateProjectSlug(slug: string): void {
  if (!projectSlugPattern.test(slug)) {
    throw new CliError(
      "Project slugs must be 2-63 lowercase letters, numbers, or hyphens, and must start with a letter or number.",
    );
  }
}

export function validateProjectName(name: string): void {
  if (name.length < 1 || name.length > 120) {
    throw new CliError("Project names must be between 1 and 120 characters.");
  }
}

export async function listManagementProjects(
  options: ManagementOptions,
): Promise<Project[]> {
  const organizationId = encodeURIComponent(options.organizationId);
  const projects: Project[] = [];
  const seenCursors = new Set<string>();
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  let cursor: string | null = null;

  do {
    const query: string = cursor
      ? `?cursor=${encodeURIComponent(cursor)}`
      : "";
    const response: z.infer<typeof projectsResponseSchema> =
      await requestManagementJson(
        options,
        {
          path: `/admin/v1/orgs/${organizationId}/projects${query}`,
          action: "Project listing",
          invalidResponseMessage:
            "Understudy returned an invalid project list. Try again shortly.",
        },
        projectsResponseSchema,
      );
    if (
      response.projects.some(
        (project) => project.org_id !== options.organizationId,
      )
    ) {
      throw invalidProjectList();
    }
    for (const project of response.projects) {
      if (seenIds.has(project.id) || seenSlugs.has(project.slug)) throw invalidProjectList();
      seenIds.add(project.id);
      seenSlugs.add(project.slug);
    }
    projects.push(...response.projects.map(normalizeProject));

    cursor = response.cursor ?? null;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw invalidProjectList();
      }
      seenCursors.add(cursor);
    }
  } while (cursor);

  return projects;
}

export async function resolveManagementProject(options: ManagementOptions, selector: string): Promise<Project> {
  if (!selector.trim() || selector.length > 255) throw new CliError("Use an exact project slug or id.");
  const projects = await listManagementProjects(options);
  const matches = projects.filter((project) => project.id === selector || project.slug === selector);
  if (matches.length > 1) throw invalidProjectList();
  if (!matches[0]) throw new CliError("Project was not found. Use an exact project slug or id.");
  return matches[0];
}

export async function updateManagementProject(options: ManagementOptions, selector: string, name: string): Promise<Project> {
  validateProjectName(name);
  const project = await resolveManagementProject(options, selector);
  const message = "Project update outcome is unknown. Show the project before retrying.";
  const response = await requestManagementJson(options, {
    path: `${projectsPath(options)}/${encodeURIComponent(project.slug)}`,
    action: "Project update", method: "PATCH", body: { name },
    transportFailureMessage: message, responseFailureMessage: message, invalidResponseMessage: message,
  }, projectResponseSchema);
  if (response.org_id !== options.organizationId || response.id !== project.id || response.slug !== project.slug || response.name !== name) {
    throw new CliError(message);
  }
  return normalizeProject(response);
}

export interface DeletedProject { id: string; slug: string; deleted: true }

export async function deleteManagementProject(options: ManagementOptions, selector: string): Promise<DeletedProject> {
  const project = await resolveManagementProject(options, selector);
  const message = "Project deletion outcome is unknown. List projects before retrying.";
  const response = await requestManagementJson(options, {
    path: `${projectsPath(options)}/${encodeURIComponent(project.slug)}`,
    action: "Project deletion", method: "DELETE",
    transportFailureMessage: message, responseFailureMessage: message, invalidResponseMessage: message,
  }, z.object({ id: z.string().min(1), slug: z.string(), deleted: z.literal(true) }));
  if (response.id !== project.id || response.slug !== project.slug) throw new CliError(message);
  return response;
}

export async function ensureDefaultManagementProject(options: ManagementOptions): Promise<Project> {
  const message = "Default project provisioning outcome is unknown. List projects before retrying.";
  const response = await requestManagementJson(options, {
    path: `${projectsPath(options)}/default`, action: "Default project provisioning", method: "POST",
    transportFailureMessage: message, responseFailureMessage: message, invalidResponseMessage: message,
  }, projectResponseSchema.omit({ org_id: true }));
  if (response.slug !== "rehearsal") throw new CliError(message);
  // This endpoint omits org_id, so confirm the returned identity in the scoped list.
  let projects: Project[];
  try { projects = await listManagementProjects(options); } catch { throw new CliError(message); }
  const project = projects.find((entry) => entry.id === response.id && entry.slug === response.slug);
  if (!project) throw new CliError(message);
  return project;
}

function projectsPath(options: ManagementOptions): string {
  return `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/projects`;
}

export async function createManagementProject(
  options: ManagementOptions,
  input: CreateProjectInput,
): Promise<Project> {
  validateProjectSlug(input.slug);
  const name = input.name ?? input.slug;
  validateProjectName(name);
  const outcomeUnknownMessage =
    "Project creation may have succeeded, so the outcome is unknown. Run `understudy projects list` before retrying.";
  const invalidOutcomeMessage =
    "Understudy returned an invalid project creation response, so the outcome is unknown. Run `understudy projects list` before retrying.";
  const response = await requestManagementJson(
    options,
    {
      path: `/admin/v1/orgs/${encodeURIComponent(options.organizationId)}/projects`,
      action: "Project creation",
      method: "POST",
      body: { slug: input.slug, name },
      transportFailureMessage: outcomeUnknownMessage,
      responseFailureMessage: outcomeUnknownMessage,
      invalidResponseMessage: invalidOutcomeMessage,
    },
    projectResponseSchema,
  );
  if (
    response.org_id !== options.organizationId ||
    response.slug !== input.slug ||
    response.name !== name
  ) {
    throw new CliError(invalidOutcomeMessage);
  }
  return normalizeProject(response);
}

function invalidProjectList(): CliError {
  return new CliError(
    "Understudy returned an invalid project list. Try again shortly.",
  );
}

function normalizeProject(
  project: z.infer<typeof projectResponseSchema>,
): Project {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
  };
}
