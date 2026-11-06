import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { createBenchmarksService, type BenchmarksService, type BenchmarkShowResult } from "../benchmarks/service.js";
import { formatOutput } from "../output.js";

export function addBenchmarksCommands(
  program: Command,
  service: BenchmarksService = createBenchmarksService({ store: createCredentialStore() }),
  output = (message: string) => process.stdout.write(`${message}\n`),
): void {
  const benchmarks = program.command("benchmarks")
    .description("Read published workload benchmarks and model recommendations.");

  benchmarks.command("list")
    .description("List workloads and their current benchmark publication, if any.")
    .action(async function (this: Command) {
      const result = await service.list();
      const published = result.workloads.filter((row) => row.benchmark);
      output(formatOutput(this, result, published.length === 0
        ? "No published benchmarks in the authenticated organization."
        : [
            ...published.map((row) => `${row.project_slug}/${row.workload_name}  ${row.benchmark!.name}  published ${row.benchmark!.published_at}`),
            `${published.length} published benchmark(s) across ${result.workloads.length} workload(s).`,
          ]));
    });

  benchmarks.command("show")
    .description("Show the current benchmark for a workload. Use --include-report for the full manifest and prompt diff.")
    .option("--project <selector>", "Exact project id, slug, or name; defaults to saved context.")
    .option("--workload <selector>", "Exact workload id or name; defaults to saved context.")
    .option("--include-report", "Include the full benchmark manifest, which may contain customer prompt and eval content.")
    .option("--expect-publication <id>", "Require this exact publication; fail if the current benchmark changed.")
    .action(async function (this: Command, options: { project?: string; workload?: string; includeReport?: boolean; expectPublication?: string }) {
      const result = await service.show(options);
      output(formatBenchmark(this, result, options.includeReport === true));
    });
}

function formatBenchmark(command: Command, result: BenchmarkShowResult, full: boolean): string {
  if (full) {
    return formatOutput(command, result, JSON.stringify(result, null, 2).split("\n"));
  }
  if (!result.publication) {
    return formatOutput(command, result, `No published benchmark for ${result.project.slug}/${result.workload.name}.`);
  }
  const lines = [
    `Benchmark  ${result.publication.name}`,
    `Workload   ${result.project.slug}/${result.workload.name}`,
    `Published  ${result.publication.published_at}`,
    `Models     ${result.publication.model_count}`,
    `Tasks      ${result.publication.task_count}`,
    `Size       ${result.manifestBytes} bytes (serialized manifest)`,
    ...(result.recommendation ? [
      `Recommend  ${result.recommendation.headline}`,
      `Summary    ${result.recommendation.summary}`,
      ...result.arms.map((arm) => `${arm.role.padEnd(11)}${arm.model} (score ${arm.score})`),
      `Prompt diff ${result.hasPromptDiff ? "available in full report" : "not published"}`,
    ] : ["Recommendation report not published for this benchmark."]),
    "Use --include-report --json to give a coding agent the full report and benchmark evidence.",
  ];
  return formatOutput(command, result, lines);
}
