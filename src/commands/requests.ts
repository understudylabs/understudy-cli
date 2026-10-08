import { Command } from "commander";
import { formatOutput } from "../output.js";
import { addRequestFilterOptions } from "../requests/filters.js";
import { createRequestsService, type RequestsService } from "../requests/service.js";
export { addRequestFilterOptions } from "../requests/filters.js";
export function addRequestIdentityOptions(command: Command): Command {
  command.option("--org <id>", "Require the authenticated organization.").option("--project <selector>", "Require an exact project.").option("--workload <selector>", "Require an exact workload within the project.").option("--environment <name>", "Request environment or all (default: all).").option("--include-rejection-details", "Include recorded rejection diagnostics.");
  return command;
}
export function addRequestsCommands(program: Command, service: RequestsService = createRequestsService(), output = (message: string) => process.stdout.write(`${message}\n`)): void {
  const emit = (command: Command, result: unknown) => output(formatOutput(command, result, JSON.stringify(result, null, 2).split("\n")));
  const requests = program.command("requests").description("Inspect authenticated request metadata.");
  addRequestFilterOptions(requests.command("list").description("List request metadata from a fixed, filtered snapshot."))
    .action(async function(this: Command, options) { emit(this, await service.list(options)); });
  addRequestIdentityOptions(requests.command("show <id>").description("Look up one exact request; captured bodies are a separate operation."))
    .action(async function(this: Command, id, options) { emit(this, await service.show(id, options)); });
}
