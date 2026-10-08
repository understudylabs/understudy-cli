import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { setApplicationContext } from "../context/service.js";
import type { SavedContext } from "../context/storage.js";

import {
  validateProjectName,
  validateProjectSlug,
  type Project,
} from "../management/projects.js";
import { formatOutput } from "../output.js";
import { createProjectsService } from "../projects/service.js";
import { CliError } from "../errors.js";
import type { DeletedProject } from "../management/projects.js";

export interface ProjectsCommandDependencies {
  list(): Promise<Project[]>;
  create(input: { slug: string; name?: string }): Promise<Project>;
  show(project: string): Promise<Project>;
  update(input: { project: string; name: string }): Promise<Project>;
  delete(input: { project: string; confirm?: boolean }): Promise<DeletedProject>;
  ensureDefault(): Promise<Project>;
  switch?(project: string, org?: string): Promise<SavedContext>;
  output(message: string): void;
}

export function createProjectsCommandDependencies(): ProjectsCommandDependencies {
  const service = createProjectsService();
  return {
    list: () => service.list(),
    create: (input) => service.create(input),
    show: (project) => service.show(project),
    update: (input) => service.update(input),
    delete: (input) => service.delete(input),
    ensureDefault: () => service.ensureDefault(),
    switch: (project, org) => setApplicationContext({ store: createCredentialStore() }, { project, org }),
    output: (message) => process.stdout.write(`${message}\n`),
  };
}

export function addProjectsCommands(
  program: Command,
  dependencies: ProjectsCommandDependencies =
    createProjectsCommandDependencies(),
): void {
  const projects = program
    .command("projects")
    .description("Inspect and manage Understudy projects.");

  projects
    .command("list")
    .description("List projects in the authenticated organization.")
    .action(async function (this: Command) {
      const result = await dependencies.list();
      dependencies.output(
        formatOutput(
          this,
          { projects: result },
          result.length === 0
            ? "No projects found."
            : projectTable(result),
        ),
      );
    });

  projects
    .command("create <slug>")
    .description("Create a project in the authenticated organization.")
    .option("--name <name>", "Human-readable project name.")
    .action(async function (
      this: Command,
      slug: string,
      options: { name?: string },
    ) {
      validateProjectSlug(slug);
      if (options.name !== undefined) validateProjectName(options.name);
      const result = await dependencies.create({
        slug,
        ...(options.name === undefined ? {} : { name: options.name }),
      });
      dependencies.output(
        formatOutput(
          this,
          result,
          `Created project ${result.slug} (${result.id}).`,
        ),
      );
    });

  projects.command("switch <project>")
    .alias("use")
    .description("Verify a project and save it as this directory's context, clearing the old workload default.")
    .option("--org <id>", "Assert the signed-in organization; does not switch identity.")
    .action(async function (this: Command, project: string, options: { org?: string }) {
      if (!dependencies.switch) throw new CliError("Project context selection is unavailable.");
      const result = await dependencies.switch(project, options.org);
      dependencies.output(formatOutput(this, result, `Selected project ${result.project.slug} for this directory.`));
    });

  projects.command("show <project>")
    .description("Show a project by exact slug or id.")
    .action(async function (this: Command, project: string) {
      const result = await dependencies.show(project);
      dependencies.output(formatOutput(this, result, projectTable([result])));
    });

  projects.command("update <project>")
    .description("Change a project's display name; its slug remains fixed.")
    .requiredOption("--name <name>", "New project name.")
    .action(async function (this: Command, project: string, options: { name: string }) {
      validateProjectName(options.name);
      const result = await dependencies.update({ project, name: options.name });
      dependencies.output(formatOutput(this, result, `Updated project ${result.slug} (${result.id}).`));
    });

  projects.command("delete <project>")
    .description("Soft-delete a project in the authenticated organization.")
    .option("--confirm", "Confirm deletion of this project.")
    .action(async function (this: Command, project: string, options: { confirm?: boolean }) {
      if (options.confirm !== true) throw new CliError("Project deletion requires --confirm.");
      const result = await dependencies.delete({ project, confirm: true });
      dependencies.output(formatOutput(this, result, `Deleted project ${result.slug} (${result.id}).`));
    });

  projects.command("ensure-default")
    .description("Ensure the canonical rehearsal project and default workload exist.")
    .action(async function (this: Command) {
      const result = await dependencies.ensureDefault();
      dependencies.output(formatOutput(this, result, `Default project ${result.slug} (${result.id}) is ready.`));
    });
}

function projectTable(projects: readonly Project[]): string[] {
  const rows = projects.map((project) => [
    project.slug,
    project.name,
    project.id,
  ]);
  const headers = ["SLUG", "NAME", "ID"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (row: readonly string[]) =>
    row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  return [formatRow(headers), ...rows.map(formatRow)];
}
