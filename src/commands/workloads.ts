import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { CliError } from "../errors.js";
import { formatOutput } from "../output.js";
import {
  createWorkloadsService,
  validateCaptureSampleRate,
  validateTrafficPercent,
  type RouteWorkloadInput,
  type CreateWorkloadInput,
  type ShowWorkloadInput,
  type UpdateWorkloadInput,
  type WorkloadListResult,
  type WorkloadResult,
} from "../workloads/service.js";

export interface WorkloadsCommandDependencies {
  list(project?: string): Promise<WorkloadListResult>;
  create(input: CreateWorkloadInput): Promise<WorkloadResult>;
  show(input: ShowWorkloadInput): Promise<WorkloadResult>;
  update(input: UpdateWorkloadInput): Promise<WorkloadResult>;
  route(input: RouteWorkloadInput): Promise<WorkloadResult>;
  output(message: string): void;
}

export function createWorkloadsCommandDependencies(): WorkloadsCommandDependencies {
  const service = createWorkloadsService({ store: createCredentialStore() });
  return {
    list: (project) => service.list(project),
    create: (input) => service.create(input),
    show: (input) => service.show(input),
    update: (input) => service.update(input),
    route: (input) => service.route(input),
    output: (message) => process.stdout.write(`${message}\n`),
  };
}

export function addWorkloadsCommands(
  program: Command,
  dependencies: WorkloadsCommandDependencies =
    createWorkloadsCommandDependencies(),
): void {
  const workloads = program
    .command("workloads")
    .description("Inspect and configure Understudy workloads.");

  workloads
    .command("list")
    .description("List workloads in a project.")
    .option("--project <selector>", "Exact project id, slug, or name; defaults to saved context.")
    .option("--project-id <id>", "Alias for --project.")
    .action(async function (
      this: Command,
      options: { project?: string; projectId?: string },
    ) {
      const result = await dependencies.list(projectSelector(options));
      dependencies.output(formatWorkloadList(this, result));
    });

  workloads
    .command("create <name>")
    .description("Create a workload with capture disabled by default and show request metadata headers.")
    .option("--project <selector>", "Exact project id, slug, or name; defaults to saved context.")
    .option("--project-id <id>", "Alias for --project.")
    .option("--capture", "Enable capture for the new workload.")
    .option("--no-capture", "Disable capture for the new workload (default).")
    .action(async function (
      this: Command,
      name: string,
      options: { project?: string; projectId?: string; capture?: boolean },
    ) {
      const result = await dependencies.create({
        project: projectSelector(options),
        name,
        capture: options.capture === true,
      });
      dependencies.output(formatWorkloadCreation(this, result));
    });

  workloads
    .command("show")
    .description("Show one workload by exact id or name.")
    .argument("<workload>", "Exact workload id or name.")
    .option("--project <selector>", "Exact project id, slug, or name; defaults to saved context.")
    .option("--project-id <id>", "Alias for --project.")
    .action(async function (
      this: Command,
      workload: string,
      options: { project?: string; projectId?: string },
    ) {
      const result = await dependencies.show({
        project: projectSelector(options),
        workload,
      });
      dependencies.output(formatWorkloadDetail(this, result));
    });

  workloads
    .command("update")
    .description("Update a workload name or capture setting.")
    .argument("<workload>", "Exact workload id or name.")
    .option("--project <selector>", "Exact project id, slug, or name; defaults to saved context.")
    .option("--project-id <id>", "Alias for --project.")
    .option("--name <name>", "New workload name.")
    .option(
      "--capture <on-or-off>",
      "Set capture to on or off.",
      parseCaptureSetting,
    )
    .option("--capture-sample-rate <rate>", "Fraction of calls to capture, from 0 to 1.", parseCaptureSampleRate)
    .action(async function (
      this: Command,
      workload: string,
      options: { project?: string; projectId?: string; name?: string; capture?: boolean; captureSampleRate?: number },
    ) {
      if (options.name === undefined && options.capture === undefined && options.captureSampleRate === undefined) {
        throw new CliError(
          "Provide at least one workload change with --name, --capture on|off, or --capture-sample-rate.",
        );
      }
      const result = await dependencies.update({
        project: projectSelector(options),
        workload,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.capture === undefined
          ? {}
          : { capture: options.capture }),
        ...(options.captureSampleRate === undefined ? {} : { captureSampleRate: options.captureSampleRate }),
      });
      dependencies.output(formatWorkloadMutation(this, "Updated", result));
    });

  workloads.command("route <workload>")
    .description("Set an explicit model traffic route, or clear it. Setting a route enables capture unless --capture off is supplied.")
    .option("--project <selector>", "Exact project id, slug, or name; defaults to saved context.")
    .option("--project-id <id>", "Alias for --project.")
    .option("--model-id <model>", "Public model id to route to.")
    .option("--traffic-pct <percent>", "Integer traffic percentage from 0 to 100 (default 10).", parseTrafficPercent)
    .option("--clear", "Clear the model route; leave capture unchanged unless specified.")
    .option("--capture <on-or-off>", "Explicit capture setting for this route update.", parseCaptureSetting)
    .action(async function (this: Command, workload: string, options: {
      project?: string; projectId?: string; modelId?: string; trafficPct?: number; clear?: boolean; capture?: boolean;
    }) {
      const result = await dependencies.route({ project: projectSelector(options), workload,
        modelId: options.modelId, trafficPercent: options.trafficPct, clear: options.clear, capture: options.capture });
      dependencies.output(formatWorkloadDetail(this, result));
    });
}

function projectSelector(options: { project?: string; projectId?: string }): string | undefined {
  if (options.project !== undefined && options.projectId !== undefined && options.project !== options.projectId) {
    throw new CliError("Use only one project selector: --project or --project-id.");
  }
  return options.project ?? options.projectId;
}

function parseTrafficPercent(value: string): number {
  if (!value.trim()) throw new CliError("Traffic percentage must be an integer between 0 and 100.");
  const percentage = Number(value);
  validateTrafficPercent(percentage);
  return percentage;
}

function parseCaptureSetting(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new CliError("Use --capture on or --capture off.");
}

function parseCaptureSampleRate(value: string): number {
  if (!value.trim()) throw new CliError("Capture sample rate must be a number between 0 and 1.");
  const rate = Number(value);
  validateCaptureSampleRate(rate);
  return rate;
}

function formatWorkloadList(
  command: Command,
  result: WorkloadListResult,
): string {
  const lines =
    result.workloads.length === 0
      ? [`No workloads in project ${result.project.slug}.`]
      : [
          `Workloads in project ${result.project.slug}:`,
          ...result.workloads.map(
            (workload) =>
              `${workload.name} (${workload.id}) - capture ${
                workload.captureEnabled ? "on" : "off"
              }`,
          ),
        ];
  return formatOutput(command, result, lines);
}

function formatWorkloadDetail(
  command: Command,
  result: WorkloadResult,
): string {
  const { workload } = result;
  return formatOutput(command, result, [
    `Workload  ${workload.name}`,
    `ID        ${workload.id}`,
    `Project   ${result.project.slug}`,
    `Capture   ${workload.captureEnabled ? "on" : "off"}`,
    `Sample    ${workload.captureSampleRate === null || workload.captureSampleRate === undefined ? "unknown" : workload.captureSampleRate}`,
    `Routing   ${formatRouting(workload)}`,
    `Default   ${workload.isDefault ? "yes" : "no"}`,
  ]);
}

function formatWorkloadMutation(
  command: Command,
  verb: "Updated",
  result: WorkloadResult,
): string {
  return formatOutput(
    command,
    result,
    `${verb} workload ${result.workload.name} in project ${
      result.project.slug
    }. Capture is ${result.workload.captureEnabled ? "on" : "off"}.`,
  );
}

function formatWorkloadCreation(command: Command, result: WorkloadResult): string {
  const guidance = {
    sessionId: "Strongly recommended for session-level evaluation; required for online model experiments. Reuse it across an execution's calls, tool continuations, and retries; use a new ID for each execution.",
    turnId: "A turn is one application-defined step within a session, such as one user message and the assistant work it triggers. It can span model calls, tool continuations, and retries. A one-shot session has one turn: use the session ID as its turn ID, or omit the turn ID.",
    tags: "App-owned labels such as user_id, account_id, or cohort. Send a flat JSON string map on each relevant call; a tag used to target an experiment must be present on every call in the session.",
  };
  const integration = {
    headers: {
      "x-understudy-project": result.project.slug,
      "x-understudy-workload": result.workload.name,
    },
    perRequestHeaders: {
      sessionId: "x-understudy-session-id",
      turnId: "x-understudy-turn-id",
      tags: "x-understudy-tags",
    },
    guidance,
  };
  return formatOutput(command, { ...result, integration }, [
    `Created workload ${result.workload.name} in project ${result.project.slug}. Capture is ${result.workload.captureEnabled ? "on" : "off"}.`,
    "Send these headers on each model request:",
    `  x-understudy-project: ${result.project.slug}`,
    `  x-understudy-workload: ${result.workload.name}`,
    "Strongly recommended for session-level evaluation (required for online model experiments):",
    "  x-understudy-session-id: <execution ID>",
    "For multiple steps within a session, identify each logical turn:",
    "  x-understudy-turn-id: <turn ID>",
    "Add tags to select and compare the users or cohorts you care about:",
    '  x-understudy-tags: {"cohort":"trial"}',
    guidance.sessionId,
    guidance.turnId,
    guidance.tags,
    "A new model call does not by itself mean a new turn.",
    "Tags select cohorts; the session ID groups calls and keeps an experiment assignment stable.",
  ]);
}

function formatRouting(workload: WorkloadResult["workload"]): string {
  if (workload.routeKind === "none") return "none";
  if (workload.routeKind === "deployment") {
    return `configured deployment at ${workload.routeTrafficPercent}%`;
  }
  return `${workload.routeModelId} at ${workload.routeTrafficPercent}%`;
}
