import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { createEvaluatorsService, type EvaluatorsService, type EvaluatorShowResult } from "../evaluators/service.js";
import type { Summary } from "../evaluators/contracts.js";
import { formatOutput, formatRateInterval as rateText } from "../output.js";

export function addEvaluatorsCommands(
  program: Command,
  service: EvaluatorsService = createEvaluatorsService({ store: createCredentialStore() }),
  output = (message: string) => process.stdout.write(`${message}\n`),
): void {
  const evaluators = program.command("evaluators")
    .description("Read workload evaluators, their rubrics, and judged results. Requires browser OAuth.");

  evaluators.command("list")
    .description("List evaluators visible to the organization with their last 30 days of results.")
    .option("--project <selector>", "Exact project id, slug, or name.")
    .option("--workload <selector>", "Exact workload id or name within --project.")
    .action(async function (this: Command, options: { project?: string; workload?: string }) {
      const result = await service.list(options);
      output(formatOutput(this, result, result.evaluators.length === 0
        ? "No visible evaluators match."
        : [
            ...result.evaluators.map((row) => {
              const rate = row.stats.trace_pass_rate ? rateText(row.stats.trace_pass_rate) : "not enough rated traces";
              return `${row.id}  ${row.status.padEnd(6)}  ${row.project_slug}/${row.workload_name}  v${row.version.version}  ${row.stats.traces_judged} judged  ${rate}  ${row.name}`;
            }),
            `${result.evaluators.length} evaluator(s). Results cover the last 30 days.`,
          ]));
    });

  evaluators.command("show [evaluator]")
    .description("Show an evaluator's active version and rubrics, by id or by workload.")
    .option("--project <selector>", "Exact project id, slug, or name; defaults to saved context.")
    .option("--workload <selector>", "Exact workload id or name; defaults to saved context.")
    .action(async function (this: Command, evaluator: string | undefined, options: { project?: string; workload?: string }) {
      const result = await service.show({ ...options, ...(evaluator === undefined ? {} : { evaluator }) });
      output(formatOutput(this, result, evaluatorLines(result)));
    });

  evaluators.command("summary <evaluator>")
    .description("Summarize judged results by model, rubric, and experiment arm.")
    .option("--from <time>", "Start of the trace window (ISO date or UTC datetime). Default: 30 days before --to.")
    .option("--to <time>", "End of the trace window. Default: now. The range spans at most 90 days.")
    .action(async function (this: Command, evaluator: string, options: { from?: string; to?: string }) {
      const result = await service.summary({ evaluator, ...options });
      output(formatOutput(this, result, summaryLines(result)));
    });

  evaluators.command("scores <evaluator>")
    .description("List per-trace verdicts. Organization admins only. Judge reasons are omitted unless --include-reasons.")
    .option("--verdict <verdict>", "pass, fail, or na.")
    .option("--model <model>", "Public served model of the judged call.")
    .option("--rubric <name>", "Rubric name.")
    .option("--from <time>", "Start of the trace window. Default: 30 days before --to.")
    .option("--to <time>", "End of the trace window. Default: now.")
    .option("--limit <count>", "Page size from 1 to 20.")
    .option("--cursor <cursor>", "Continue from a previous page.")
    .option("--include-reasons", "Include judge reasons, which can quote the organization's traces.")
    .action(async function (this: Command, evaluator: string, options: {
      verdict?: string; model?: string; rubric?: string; from?: string; to?: string;
      limit?: string; cursor?: string; includeReasons?: boolean;
    }) {
      const result = await service.scores({ evaluator, ...options });
      output(formatOutput(this, result, [
        ...result.scores.map((score) => [
          `${score.trace_ended_at}  ${score.request_id}  ${score.model}  ${score.rubric}  ${score.verdict}`,
          ...(result.reasonsIncluded && score.reason ? [`  reason: ${score.reason}`] : []),
        ]).flat(),
        result.scores.length === 0 ? "No scores match." : `${result.scores.length} score(s).`,
        ...(result.nextCursor ? [`More results: --cursor ${result.nextCursor}`] : []),
      ]));
    });
}

function evaluatorLines(result: EvaluatorShowResult): string[] {
  const { evaluator } = result;
  return [
    `Evaluator   ${evaluator.name}`,
    `Id          ${evaluator.id}`,
    `Status      ${evaluator.status}`,
    `Workload    ${evaluator.project_slug}/${evaluator.workload_name}`,
    `Scores from ${evaluator.score_from}`,
    `Version     v${evaluator.version.version} (${evaluator.version.id})`,
    `Judge       ${evaluator.version.judge_model ?? "none (code checks only)"}`,
    "Rubrics",
    ...evaluator.version.rubrics.flatMap((rubric) => [
      `  ${rubric.name} [${rubric.implementation === "deterministic" ? `code check: ${String(rubric.check?.type ?? "unknown")}` : "judge"}]`,
      `    pass when: ${rubric.pass_when}`,
      `    fail when: ${rubric.fail_when}`,
      ...(rubric.na_when ? [`    n/a when:  ${rubric.na_when}`] : []),
    ]),
    ...(result.experiments.length === 0 ? ["Experiments none"] : [
      "Experiments",
      ...result.experiments.map((row) => `  ${row.id}  ${row.status}  ${row.control_model} -> ${row.candidate_model}  ${row.name}`),
    ]),
  ];
}

function summaryLines(summary: Summary): string[] {
  const rate = (stats: Summary["total"]) => stats.trace_pass_rate ? rateText(stats.trace_pass_rate) : "not enough rated traces";
  return [
    `Evaluator   ${summary.evaluator_id} v${summary.version}`,
    `Range       ${summary.from ?? "?"} -> ${summary.to ?? "?"}`,
    `Total       ${summary.total.traces_judged} judged, ${summary.total.rated_traces} rated, pass ${rate(summary.total)}`,
    ...summary.total.rubrics.map((rubric) =>
      `  ${rubric.rubric.padEnd(24)} pass ${rubric.pass}  fail ${rubric.fail}  n/a ${rubric.na}`),
    ...(summary.by_model.length ? ["By model", ...summary.by_model.map((group) =>
      `  ${group.model.padEnd(32)} rated ${group.rated_traces}  pass ${rate(group)}`)] : []),
    ...(summary.by_variant.some((group) => group.experiment_id) ? ["By experiment arm", ...summary.by_variant
      .filter((group) => group.experiment_id)
      .map((group) => `  ${group.experiment_id} ${group.variant ?? "?"}  rated ${group.rated_traces}  pass ${rate(group)}`)] : []),
  ];
}
