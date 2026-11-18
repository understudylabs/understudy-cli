import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import type { Experiment, Interval } from "../evaluators/contracts.js";
import {
  createExperimentsService,
  type ExperimentArm,
  type ExperimentResults,
  type ExperimentsService,
} from "../experiments/service.js";
import { formatOutput, formatRateInterval } from "../output.js";

export function addExperimentsCommands(
  program: Command,
  service: ExperimentsService = createExperimentsService({ store: createCredentialStore() }),
  output = (message: string) => process.stdout.write(`${message}\n`),
): void {
  const experiments = program.command("experiments")
    .description("Read online model experiments and their measured results. Requires browser OAuth.");

  experiments.command("list")
    .description("List experiments visible to the organization, newest first.")
    .option("--project <selector>", "Exact project id, slug, or name.")
    .option("--workload <selector>", "Exact workload id or name within --project.")
    .option("--status <status>", "draft, active, or stopped.")
    .action(async function (this: Command, options: { project?: string; workload?: string; status?: string }) {
      const result = await service.list(options);
      output(formatOutput(this, result, result.experiments.length === 0
        ? "No experiments match."
        : [
            ...result.experiments.map((row) =>
              `${row.id}  ${row.status.padEnd(7)}  ${scopeLabel(row)}  ${row.control_model} -> ${row.candidate_model} ${row.candidate_percent}%  ${row.name}`),
            `${result.experiments.length} experiment(s).`,
            ...(result.possiblyTruncated ? ["Understudy returned its maximum page; older experiments may be missing."] : []),
          ]));
    });

  experiments.command("show <experiment>")
    .description("Show one experiment's configuration.")
    .action(async function (this: Command, experiment: string) {
      const result = await service.show({ experiment });
      output(formatOutput(this, result, experimentLines(result)));
    });

  experiments.command("results <experiment>")
    .description("Compare control and candidate using the workload's evaluator.")
    .option("--from <time>", "Start of the trace window (ISO date or UTC datetime). Default: experiment creation, at most 90 days back.")
    .option("--to <time>", "End of the trace window. Default: now.")
    .action(async function (this: Command, experiment: string, options: { from?: string; to?: string }) {
      const result = await service.results({ experiment, ...options });
      output(formatOutput(this, result, resultLines(result)));
    });
}

function scopeLabel(row: Experiment): string {
  return `${row.project_slug}/${row.workload_name ?? `${row.workload_id} (deleted)`} [${row.request_environment}]`;
}

function audience(row: Experiment): string {
  return row.target_tag === null
    ? "all sessions with a session id"
    : `sessions tagged ${row.target_tag} with one of ${row.target_values!.length} value(s)`;
}

function experimentLines(row: Experiment): string[] {
  return [
    `Experiment  ${row.name}`,
    `Id          ${row.id}`,
    `Status      ${row.status}`,
    `Workload    ${scopeLabel(row)}`,
    `Control     ${row.control_model}`,
    `Candidate   ${row.candidate_model} (${row.candidate_percent}% of sessions)`,
    `Audience    ${audience(row)}`,
    `Created     ${new Date(row.created_at_ms).toISOString()}`,
    `Updated     ${new Date(row.updated_at_ms).toISOString()}`,
  ];
}

function resultLines(result: ExperimentResults): string[] {
  const row = result.experiment;
  const lines = [
    `Experiment  ${row.name} (${row.status})`,
    `Workload    ${scopeLabel(row)}`,
  ];
  if (result.evaluator && result.range) {
    lines.push(
      `Evaluator   ${result.evaluator.name} v${result.evaluator.version} (${result.evaluator.status})`,
      `Range       ${result.range.from} -> ${result.range.to}`,
      armLine("control", row.control_model, result.control, result.minimumRatedTraces),
      armLine("candidate", row.candidate_model, result.candidate, result.minimumRatedTraces),
      `Difference  ${difference(result.candidateMinusControl)}`,
    );
  }
  return [...lines, ...result.notes.map((note) => `Note: ${note}`)];
}

function armLine(label: string, model: string, arm: ExperimentArm | null, minimum: number): string {
  const head = `${label.padEnd(11)} ${model}`;
  if (!arm) return `${head}  no judged traces`;
  const rate = arm.trace_pass_rate ? `pass ${formatRateInterval(arm.trace_pass_rate)}` : `pass rate needs ${minimum} rated traces`;
  const cost = arm.cost_per_trace_usd === null ? "cost unknown" : `$${arm.cost_per_trace_usd.toFixed(4)}/trace`;
  return `${head}  rated ${arm.rated_traces}  ${rate}  ${cost}`;
}

function difference(interval: Interval | null): string {
  if (!interval) return "not enough rated traces in both arms";
  const pts = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
  return `${pts(interval.value)} pts [${pts(interval.low)}, ${pts(interval.high)}] (candidate - control, 95% interval)`;
}
