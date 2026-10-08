import { Command } from "commander";

import { CliError } from "../errors.js";
import { formatOutput } from "../output.js";
import { createReportReads, type ReportReadInput, type ScopedReport } from "../report/reads.js";
import {
  createReportService,
  defaultReportWindow,
  parseReportWindow,
  type CostReport,
  type Coverage,
  type ErrorReport,
  type HealthReport,
  type ReportSummary,
  type ReportWindow,
  type UsageReport,
} from "../report/service.js";

export interface ReportCommandDependencies {
  summary(window: ReportWindow): Promise<ReportSummary>;
  health(): Promise<HealthReport>;
  usage(window: ReportWindow): Promise<UsageReport>;
  errors(window: ReportWindow): Promise<ErrorReport>;
  costs(window: ReportWindow): Promise<CostReport>;
  query?(kind: "usage" | "errors" | "costs", input: ReportReadInput): Promise<ScopedReport>;
  output(message: string): void;
}

export function createReportCommandDependencies(): ReportCommandDependencies {
  const service = createReportService();
  const reads = createReportReads();
  return {
    summary: (window) => service.summary(window),
    health: () => service.health(),
    usage: (window) => service.usage(window),
    errors: (window) => service.errors(window),
    costs: (window) => service.costs(window),
    query: (kind, input) => reads.query(kind, input),
    output: (message) => process.stdout.write(`${message}\n`),
  };
}

export function addReportCommands(
  program: Command,
  dependencies: ReportCommandDependencies = createReportCommandDependencies(),
): void {
  const report = withWindow(
    program
      .command("report")
      .description(
        "Report organization health, usage, errors, and recorded customer cost.",
      ),
  ).action(async function (this: Command) {
    const window = selectedWindow(this);
    const result = await dependencies.summary(window);
    dependencies.output(formatOutput(this, result, summaryLines(result)));
  });

  report
    .command("health")
    .description("Show the current organization health snapshot.")
    .action(async function (this: Command) {
      if (this.parent?.opts<{ window?: string }>().window !== undefined) {
        throw new CliError(
          "Health is a current snapshot and does not support --window.",
        );
      }
      const result = await dependencies.health();
      dependencies.output(formatOutput(this, result, healthLines(result)));
    });

  withFilters(withWindow(
    report
      .command("usage")
      .description("Show organization request and token usage."),
  )).action(async function (this: Command) {
    if (await filtered(this, "usage", dependencies)) return;
    const window = selectedWindow(this);
    const result = await dependencies.usage(window);
    dependencies.output(formatOutput(this, result, usageLines(result)));
  });

  withFilters(withWindow(
    report
      .command("errors")
      .description("Show organization errors by workload."),
  ), false).action(async function (this: Command) {
    if (await filtered(this, "errors", dependencies)) return;
    const window = selectedWindow(this);
    const result = await dependencies.errors(window);
    dependencies.output(formatOutput(this, result, errorLines(result)));
  });

  withFilters(withWindow(
    report
      .command("costs")
      .description("Show recorded organization customer cost by workload."),
  )).action(async function (this: Command) {
    if (await filtered(this, "costs", dependencies)) return;
    const window = selectedWindow(this);
    const result = await dependencies.costs(window);
    dependencies.output(formatOutput(this, result, costLines(result)));
  });
}

function withFilters(command: Command, exclusions = true): Command {
  command.option("--org <id>", "Require the active authenticated organization.")
    .option("--project <project>", "Project slug or ID in the authenticated organization.")
    .option("--project-id <id>", "Project ID in the authenticated organization.")
    .option("--workload <workload>", "Workload name or ID in the selected project.")
    .option("--workload-id <id>", "Workload ID in the selected project.")
    .option("--environment <environment>", "Request environment, or all.")
    .option("--from <date>", "Inclusive UTC start date (YYYY-MM-DD).")
    .option("--to <date>", "Inclusive UTC end date (YYYY-MM-DD).")
    .option("--group-by <dimension>", "Group by project, workload, or model.")
    .option("--granularity <interval>", "Bucket by minute, hour, or day.");
  if (exclusions) command.option("--exclude-project <project>", "Exclude a project; repeatable.", (value: string, previous: string[] = []) => [...previous, value])
    .option("--exclude-project-id <id>", "Exclude a project ID; repeatable.", (value: string, previous: string[] = []) => [...previous, value]);
  return command;
}

async function filtered(command: Command, kind: "usage" | "errors" | "costs", dependencies: ReportCommandDependencies): Promise<boolean> {
  const input = command.opts<ReportReadInput>();
  if (!Object.keys(input).some((key) => key !== "window")) return false;
  if (!dependencies.query) throw new CliError("Filtered reporting is unavailable in this command adapter.");
  input.window ??= command.parent?.opts<{window?: string}>().window;
  const result = await dependencies.query(kind, input);
  dependencies.output(formatOutput(command, result, [
    `Organization ${result.organizationId}`,
    ...(result.projectId ? [`Project ${result.projectId}`] : []),
    "Selected report (JSON fields):",
    ...JSON.stringify(result.data, null, 2).split("\n"),
    ...(result.pricingCoverage ? ["Pricing coverage is not reported by this endpoint."] : []),
  ]));
  return true;
}

function withWindow(command: Command): Command {
  return command.option(
    "--window <window>",
    "Reporting window: 24h, 7d, or 30d.",
  );
}

function selectedWindow(command: Command): ReportWindow {
  const ownWindow = command.opts<{ window?: string }>().window;
  const parentWindow = command.parent?.opts<{ window?: string }>().window;
  return parseReportWindow(
    ownWindow ?? parentWindow ?? defaultReportWindow,
  );
}

function summaryLines(result: ReportSummary): string[] {
  return [
    `Health          ${result.health.state} (last ${result.health.windowMinutes}m)`,
    `Requests        ${formatCount(result.usage.requests)} (${result.window})`,
    `Errors          ${formatCount(result.errors.errors)} (${formatRate(result.errors.errorRate)})`,
    `Recorded customer cost ${formatUsd(result.costs.recordedCustomerCostUsd)} (${result.window})`,
    `Cost coverage   ${formatPricingCoverage(result.costs.pricingCoverage)}`,
    `Health coverage ${formatCoverage(result.health.coverage)}`,
    `Error coverage  ${formatCoverage(result.errors.coverage)}`,
  ];
}

function healthLines(result: HealthReport): string[] {
  const lines = [
    `Health           ${result.recent.state}`,
    `Recent           ${formatCount(result.recent.requests)} requests, ${formatCount(result.recent.errors)} errors (${result.recent.windowMinutes}m)`,
    `Baseline         ${formatCount(result.baseline.requests)} requests, ${formatCount(result.baseline.errors)} errors (${result.baseline.windowMinutes}m)`,
    `Active workloads ${formatCount(result.activeWorkloads)}`,
    `Idle workloads   ${result.idleWorkloads ?? "not available"}`,
    `Coverage         ${formatCoverage(result.coverage)}`,
  ];
  if (result.workloadsTruncated) {
    lines.push("Workload rows    truncated by Understudy");
  }
  if (result.workloads.length > 0) {
    lines.push("", ...table(
      ["PROJECT", "WORKLOAD", "STATE", "REQUESTS", "ERRORS", "ERROR RATE"],
      result.workloads.map((workload) => [
        workload.project ?? workload.projectId ?? "unattributed",
        workload.workload,
        workload.state,
        formatCount(workload.requests),
        formatCount(workload.errors),
        formatRate(workload.errorRate),
      ]),
    ));
  }
  return lines;
}

function usageLines(result: UsageReport): string[] {
  const lines = [
    `Window       ${result.window}`,
    `Requests     ${formatCount(result.totals.requests)}`,
    `Input tokens ${formatCount(result.totals.inputTokens)}`,
    `Cache reads  ${formatCount(result.totals.cacheReadInputTokens)}`,
    `Cache writes ${formatCount(result.totals.cacheCreationInputTokens)}`,
    `Output tokens ${formatCount(result.totals.outputTokens)}`,
    `Total tokens ${formatCount(result.totals.totalTokens)}`,
  ];
  if (result.workloads.length > 0) {
    lines.push("", ...table(
      ["PROJECT", "WORKLOAD", "REQUESTS", "TOTAL TOKENS"],
      result.workloads.map((workload) => [
        workload.project ?? workload.projectId ?? "unattributed",
        workload.workload,
        formatCount(workload.requests),
        formatCount(workload.totalTokens),
      ]),
    ));
  }
  return lines;
}

function errorLines(result: ErrorReport): string[] {
  const lines = [
    `Window       ${result.window}`,
    `Requests     ${formatCount(result.totals.requests)}`,
    `Errors       ${formatCount(result.totals.errors)} (${formatRate(result.totals.errorRate)})`,
    `Upstream     ${formatCount(result.totals.bySource.upstream)}`,
    `Network      ${formatCount(result.totals.bySource.network)}`,
    `Edge         ${formatCount(result.totals.bySource.edge)}`,
    `Unclassified ${formatCount(result.totals.bySource.unclassified)}`,
    `Coverage     ${formatCoverage(result.coverage)}`,
  ];
  if (result.workloads.length > 0) {
    lines.push("", ...table(
      ["PROJECT", "WORKLOAD", "REQUESTS", "ERRORS", "ERROR RATE", "LAST ERROR"],
      result.workloads.map((workload) => [
        workload.project,
        workload.workload,
        formatCount(workload.requests),
        formatCount(workload.errors),
        formatRate(workload.errorRate),
        workload.lastErrorAt ?? "none",
      ]),
    ));
  }
  return lines;
}

function costLines(result: CostReport): string[] {
  const lines = [
    `Window        ${result.window}`,
    `Recorded customer cost ${formatUsd(result.recordedCustomerCostUsd)}`,
    `Pricing coverage ${formatPricingCoverage(result.pricingCoverage)}`,
  ];
  if (result.workloads.length > 0) {
    lines.push("", ...table(
      ["PROJECT", "WORKLOAD", "REQUESTS", "RECORDED COST"],
      result.workloads.map((workload) => [
        workload.project ?? workload.projectId ?? "unattributed",
        workload.workload,
        formatCount(workload.requests),
        formatUsd(workload.recordedCustomerCostUsd),
      ]),
    ));
  }
  return lines;
}

function formatPricingCoverage(coverage: "unavailable"): string {
  switch (coverage) {
    case "unavailable":
      return "not reported by the platform";
  }
}

function formatCoverage(coverage: Coverage): string {
  const completeness = `${(coverage.dataCompleteness * 100).toFixed(1)}%`;
  return coverage.knownGaps.length === 0
    ? completeness
    : `${completeness}; ${coverage.knownGaps.length} known gap${coverage.knownGaps.length === 1 ? "" : "s"}`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function table(headers: readonly string[], rows: readonly string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (row: readonly string[]) =>
    row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  return [formatRow(headers), ...rows.map(formatRow)];
}
