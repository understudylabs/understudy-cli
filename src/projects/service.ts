import {
  createCredentialStore,
  type CredentialStore,
} from "../auth/credentials.js";
import {
  createManagementProject,
  deleteManagementProject,
  ensureDefaultManagementProject,
  listManagementProjects,
  resolveManagementProject,
  updateManagementProject,
  validateProjectName,
  validateProjectSlug,
  type CreateProjectInput,
  type Project,
  type DeletedProject,
} from "../management/projects.js";
import { resolveManagementSession } from "../management/session.js";
import { CliError } from "../errors.js";

interface ProjectsServiceOptions {
  authStore?: CredentialStore;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

export interface ProjectsService {
  list(): Promise<Project[]>;
  create(input: CreateProjectInput): Promise<Project>;
  show(project: string): Promise<Project>;
  update(input: { project: string; name: string }): Promise<Project>;
  delete(input: { project: string; confirm?: boolean }): Promise<DeletedProject>;
  ensureDefault(): Promise<Project>;
}

export function createProjectsService(
  options: ProjectsServiceOptions = {},
): ProjectsService {
  const authStore = options.authStore ?? createCredentialStore();
  const sessionOptions = {
    store: authStore,
    baseUrl: options.baseUrl,
    fetchImplementation: options.fetchImplementation,
  };

  return {
    async list() {
      const session = await resolveManagementSession(sessionOptions);
      return listManagementProjects(session);
    },

    async create(input) {
      validateProjectSlug(input.slug);
      validateProjectName(input.name ?? input.slug);
      const session = await resolveManagementSession(sessionOptions);
      return createManagementProject(session, input);
    },
    async show(project) {
      return resolveManagementProject(await resolveManagementSession(sessionOptions), project);
    },
    async update(input) {
      validateProjectName(input.name);
      return updateManagementProject(await resolveManagementSession(sessionOptions), input.project, input.name);
    },
    async delete(input) {
      if (input.confirm !== true) throw new CliError("Project deletion requires --confirm.");
      return deleteManagementProject(await resolveManagementSession(sessionOptions), input.project);
    },
    async ensureDefault() {
      return ensureDefaultManagementProject(await resolveManagementSession(sessionOptions));
    },
  };
}
