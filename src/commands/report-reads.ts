import { Command } from "commander";
import { CliError } from "../errors.js";
import { formatOutput } from "../output.js";
import { createReportReads, type ProjectReport, type ReportReadInput, type ScopedReport } from "../report/reads.js";
import { addRequestFilterOptions } from "../requests/filters.js";
import { createRequestsService, type RequestsService } from "../requests/service.js";

export function addReportReadCommands(program: Command, reads = createReportReads(), output = (value: string) => process.stdout.write(`${value}\n`)): void {
  const report = program.commands.find((command) => command.name() === "report");
  if (!report) throw new CliError("Register report commands before report reads.");
  const show = (command: Command, result: ScopedReport, selection: string[] = []) => output(formatOutput(command, result, [
    `Organization ${result.organizationId}`,
    ...(result.projectId ? [`Project ${result.projectId}`] : []),
    ...selection,
    ...JSON.stringify(result.data, null, 2).split("\n"),
  ]));
  addSummary(report);
  addProjectUsage(report);
  for (const kind of ["workload-status", "providers", "cost-breakdown"] as const) {
    const command = report.command(kind).description(`Read project ${kind} within the authenticated organization.`)
      .option("--project <project>", "Project slug or ID, or saved project context.")
      .option("--project-id <id>", "Project ID in the authenticated organization.")
      .option("--org <id>", "Require the active authenticated organization.")
      .option("--window <duration>", kind === "cost-breakdown" ? "Duration up to 30d; default 7d." : "Duration up to 24h.")
      .option("--environment <environment>", `Request environment, or all (default: ${kind === "cost-breakdown" ? "all" : "production"}).`);
    if (kind === "cost-breakdown") command.option("--workload <workload>", "Workload name or ID within the selected project.")
      .option("--workload-id <id>", "Workload ID within the selected project.");
    command.action(async function (this: Command) {
      const input = this.opts<ReportReadInput>();
      input.window ??= report.opts<{window?:string}>().window;
      const result = await reads.project(kind, input);
      show(this, result, projectEnvironmentLines(kind, result));
    });
  }
  report.command("cost <request>").description("Read a call's recorded customer cost using a request or correlation ID.")
    .option("--org <id>", "Require the active authenticated organization.")
    .action(async function(this: Command, request: string) {
      if (report.opts<{window?:string}>().window !== undefined) throw new CliError("A call cost lookup does not accept --window.");
      show(this, await reads.cost(request, this.opts<ReportReadInput>()));
    });

  function projectOptions(command: Command, savedProject = true): Command {
    return command.option("--org <id>", "Require the active authenticated organization.")
      .option("--project <project>", savedProject ? "Project slug or ID, or saved project context." : "Filter to an explicit project slug or ID.")
      .option("--project-id <id>", "Project ID in the authenticated organization.");
  }
  function addSummary(parent: Command): void {
    projectOptions(parent.command("summary").description("Read organization requests, tokens, and estimated customer cost."), false)
      .option("--window <duration>", "Preset window: 24h, 7d, or 30d; default 7d.")
      .option("--from <date>", "Inclusive UTC start date (YYYY-MM-DD).")
      .option("--to <date>", "Inclusive UTC end date (YYYY-MM-DD).")
      .option("--group-by <dimension>", "Group by project, workload, or model; default project.")
      .option("--granularity <interval>", "Bucket by minute, hour, or day.")
      .option("--workload <workload>", "Workload name or ID within the selected project.")
      .option("--workload-id <id>", "Workload ID within the selected project.")
      .option("--exclude-project <project>", "Exclude a project; repeatable.", collect)
      .option("--exclude-project-id <id>", "Exclude a project ID; repeatable.", collect)
      .option("--environment <environment>", "Request environment; default all.")
      .action(async function (this: Command) {
        const input = this.opts<ReportReadInput>();
        const window = input.from !== undefined || input.to !== undefined ? undefined : (input.window ?? parent.opts<{window?: string}>().window ?? "7d").trim();
        show(this, await reads.query("usage", { ...input, window, groupBy: input.groupBy ?? "project", useDefaults: false }));
      });
  }
  function addProjectUsage(parent: Command): void {
    projectOptions(parent.command("usage-summary").description("Read project usage, cache, error, and cost groups."))
      .option("--window <duration>", "Duration up to 30d; default 7d.")
      .option("--group-by <dimensions>", "Comma-separated subset of workload, model, and day; default workload.")
      .option("--environment <environment>", "Request environment; default all.")
      .action(async function (this: Command) {
        const input = this.opts<ReportReadInput>();
        input.window ??= parent.opts<{window?: string}>().window;
        show(this, await reads.projectUsage(input));
      });
  }
}

function projectEnvironmentLines(kind: ProjectReport, result: ScopedReport): string[] {
  const environment = result.request.request_environment;
  if (typeof environment !== "string") return [];
  const lines = [`Request environment ${environment}`];
  const data = result.data as { workloads?: { requests: number }[]; total_requests?: number };
  const empty = kind === "workload-status"
    ? data.workloads?.every(workload => workload.requests === 0)
    : kind === "providers" && data.total_requests === 0;
  if (environment === "production" && empty) {
    lines.push("No production requests in this selection. For test or combined traffic, use --environment test or --environment all.");
  }
  return lines;
}

function collect(value: string, previous: string[] = []): string[] { return [...previous, value]; }

export function addFailureReportCommand(program: Command, service: RequestsService = createRequestsService(), output = (value: string) => process.stdout.write(`${value}\n`)): void {
  const report = program.commands.find((command) => command.name() === "report");
  if (!report) throw new CliError("Register report commands before failure reporting.");
  addRequestFilterOptions(report.command("failures").description("Read aggregate failure context for a filtered request window; diagnosis belongs to a skill."), { pagination: false })
    .action(async function(this: Command) {
      const input = this.opts();
      input.window ??= report.opts<{window?:string}>().window;
      const result = await service.failureContext(input);
      output(formatOutput(this, result, JSON.stringify(result, null, 2).split("\n")));
    });
}
