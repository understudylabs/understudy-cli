import { Command } from "commander";
import { formatOutput } from "../output.js";
import { createCapturesService, type CapturesService } from "../captures/service.js";
import { addRequestFilterOptions } from "../requests/filters.js";
import { addDownloadOptions } from "../captures/options.js";
export function addCaptureScopeOptions(command: Command): Command {
  return command.option("--org <id>", "Require the authenticated organization.").option("--project <selector>", "Exact project id, slug, or name; or saved context.").option("--workload <selector>", "Exact workload id or name within the project.").option("--environment <name>", "Request environment; workload listing defaults to production, project listing to all.");
}
export function addCapturesCommands(program: Command, service: CapturesService = createCapturesService(), output = (message: string) => process.stdout.write(`${message}\n`)): void {
  const captures = program.command("captures").description("Inspect or privately download customer-visible captures.");
  const emit = (command: Command, result: unknown) => output(formatOutput(command, result, JSON.stringify(result, null, 2).split("\n")));
  addCaptureScopeOptions(captures.command("list").description("List stored objects; use requests list for time/model/status filters."))
    .option("--limit <count>", "Page size from 1 to 100.").option("--cursor <cursor>", "Continue the same capture listing.").option("--all", "Traverse every stored-object page, including empty pages.")
    .option("--from <timestamp>", "Indexed timestamp search start; requires --to and a workload.").option("--to <timestamp>", "Exclusive timestamp search end; maximum interval 24 hours.")
    .action(async function(this: Command, options) { emit(this, await service.list(options)); });
  addCaptureScopeOptions(captures.command("get <request-id>").description("Summarize one capture in the selected project/workload."))
    .option("--output <path>", "New owner-only file inside the application's .understudy directory.")
    .option("--out <path>", "Alias for --output.").option("--include-payload", "Include captured request and response bodies.").option("--yes", "Confirm full payload output.")
    .option("--retries <count>", "Retries for transient failures, 0 to 5 (default: 2).")
    .action(async function(this: Command, id, options) { emit(this, await service.get(id, options)); });
  addDownloadOptions(addRequestFilterOptions(captures.command("export [request-id]").description("Export explicit requests, a filtered snapshot, or an indexed workload day."), { pagination: false }))
    .option("--request-ids-file <path>", "Private text file with one explicit request UUID per line.")
    .option("--date <YYYY-MM-DD>", "Indexed production workload export: one completed UTC day; requires a project, workload, and --include-payload --yes.")
    .option("--last <duration>", "Indexed workload export: rolling 1d; production only, frozen when first run.")
    .action(async function(this: Command, id, options) { emit(this, await service.export({ ...options, ...(id ? { requestId: id } : {}) })); });
}
