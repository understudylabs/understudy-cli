import { Command } from "commander";
import { formatOutput } from "../output.js";
import { createReportReads, type ReportReadInput } from "../report/reads.js";

export function addBillingCommands(program: Command, reads = createReportReads(), output = (value: string) => process.stdout.write(`${value}\n`)): void {
  const billing = program.command("billing").description("Read current balance and recorded organization billing usage.");
  for (const kind of ["balance", "summary", "trend", "usage-by-model"] as const) {
    const command = billing.command(kind).description(kind === "balance" ? "Show the current ledger-backed balance." : `Show organization billing ${kind} over an exact UTC interval.`)
      .option("--org <id>", "Require the active authenticated organization.");
    if (kind !== "balance") command.option("--window <duration>", "Trailing interval, default 30d (maximum 366d).")
      .option("--from <timestamp>", "Inclusive ISO timestamp with Z or a numeric UTC offset.")
      .option("--to <timestamp>", "Exclusive ISO timestamp with Z or a numeric UTC offset.");
    command.action(async function (this: Command) {
      const result = await reads.billing(kind, this.opts<ReportReadInput>());
      output(formatOutput(this, result, [
        `Organization ${result.organizationId}`,
        ...JSON.stringify(result.data, null, 2).split("\n"),
        ...(kind === "balance" ? [] : ["Costs are estimated from pricing records. Priced events are not a count of ledger debits or distinct priced requests."]),
      ]));
    });
  }
}
