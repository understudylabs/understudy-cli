import { Command } from "commander";
import { createCredentialStore } from "../auth/credentials.js";
import { clearApplicationContext, readApplicationContext, setApplicationContext, type ScopeSelectors } from "../context/service.js";
import type { SavedContext } from "../context/storage.js";
import { formatOutput } from "../output.js";

export interface ContextCommandDependencies {
  show(): Promise<SavedContext | null>;
  set(selectors: Pick<ScopeSelectors, "org" | "project" | "workload">): Promise<SavedContext>;
  clear(): Promise<void>;
  output(message: string): void;
}

export function addContextCommands(program: Command, dependencies: ContextCommandDependencies = {
  show: () => readApplicationContext(),
  set: (selectors) => setApplicationContext({ store: createCredentialStore() }, selectors),
  clear: () => clearApplicationContext(),
  output: (message) => process.stdout.write(`${message}\n`),
}): void {
  const context = program.command("context").description("Manage private defaults for this application directory.");
  context.command("show").description("Show stored defaults without authenticating or checking the server.")
    .action(async function (this: Command) {
      const result = await dependencies.show();
      dependencies.output(formatOutput(this, { context: result, verification: "local" }, result ? [
        `Organization ${result.organizationId}`, `Project      ${result.project.slug}`, `Workload     ${result.workload?.name ?? "not selected"}`, "Verification stored defaults; remote commands revalidate scope",
      ] : "No context is stored for this application directory."));
    });
  context.command("set").description("Verify project/workload membership and save application defaults.")
    .option("--org <id>", "Assert the authenticated organization; cannot switch identity.")
    .option("--project <selector>", "Exact project id, slug, or unambiguous name.")
    .option("--workload <name-or-id>", "Exact workload name or id in the project.")
    .action(async function (this: Command, selectors: ScopeSelectors) {
      const result = await dependencies.set(selectors);
      dependencies.output(formatOutput(this, { context: result, verification: "remote" }, `Saved context for project ${result.project.slug}${result.workload ? ` and workload ${result.workload.name}` : ""}.`));
    });
  context.command("clear").description("Remove only this application's stored context.")
    .action(async function (this: Command) {
      await dependencies.clear();
      dependencies.output(formatOutput(this, { cleared: true }, "Application context cleared."));
    });
}
