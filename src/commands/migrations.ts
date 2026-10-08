import { Command } from "commander";
import { CliError } from "../errors.js";
import { formatOutput } from "../output.js";
import { createMigrationService, executionTarget, type MigrationService } from "../migrations/service.js";
import { bundledReplayHelp } from "../skills/bundle.generated.js";

export function addMigrationCommands(program: Command, service: MigrationService = createMigrationService({ onCaptureProgress: event => {
    if (!program.opts().json) process.stderr.write(`${event.phase}${event.date ? ` ${event.date}` : ""}: ${event.saved} captures saved, ${(event.bytes / 1048576).toFixed(1)} MiB, ${event.unavailable} unavailable.\n`);
} }), output = (message: string) => process.stdout.write(`${message}\n`)): void {
    const emit = (command: Command, result: unknown) => output(formatOutput(command, result, JSON.stringify(result, null, 2).split("\n")));
    program.command("migrate").description("Capture and reconstruct workload requests for private replay (yesterday UTC by default).")
        .requiredOption("--project <name>", "Exact project name, slug, or id.")
        .requiredOption("--workload <name>", "Exact workload name or id.")
        .option("--org <id>", "Require this exact signed-in organization.")
        .option("--last-days <count>", "Download the last N completed UTC days.")
        .option("--from <date>", "First UTC day to include (YYYY-MM-DD); requires --to.")
        .option("--to <date>", "UTC end date, exclusive (YYYY-MM-DD); requires --from.")
        .option("--resume <id>", "Reuse saved captures.")
        .action(async function (this: Command, options) {
            const useDefaultDay = !options.resume && options.lastDays === undefined && options.from === undefined && options.to === undefined;
            const result = await service.migrate({ ...options, ...(useDefaultDay ? { lastDays: "1" } : {}) });
            output(formatOutput(this, result, [
                `Captured requests: ${result.counts.requests}; logical tasks: ${result.counts.tasks}.`,
                `Evidence: ${result.directory}`,
                `Run: ${result.runId}. See understudy replay --help for the bundled harness and tool-environment reference.`,
            ]));
        });
    program.command("replay").description("Run a private harness with recorded replay or stateful simulation, optionally offline.")
        .addHelpText("after", `\n${bundledReplayHelp}`)
        .requiredOption("--run <id>", "Private capture run id.")
        .requiredOption("--harness <path>", "Private .cjs file assigning an async function to module.exports.")
        .option("--environment <path>", "Reviewed private .cjs tool environment.")
        .option("--offline", "Validate and run local tool operations without model requests or authentication.")
        .option("--model <id>", "Available catalog model; required unless offline.")
        .option("--max-calls <count>", "Maximum model requests for this replay journal; required unless offline.")
        .option("--max-output-tokens <count>", "Maximum output tokens per model request; required unless offline.")
        .option("--max-tool-calls <count>", "Maximum tool operations for this replay journal (default: 1000).")
        .option("--id <id>", "Reuse an unchanged harness's saved replay journal.")
        .option("--target-project <name>", "Existing project for comparison traffic.")
        .option("--target-workload <name>", "Existing workload for comparison traffic.")
        .action(async function (this: Command, options) {
            if (options.offline) {
                if ([options.model, options.maxCalls, options.maxOutputTokens, options.targetProject, options.targetWorkload].some(value => value !== undefined))
                    throw new CliError("Offline replay omits --model, --max-calls, --max-output-tokens, and comparison target options.");
            } else if ([options.model, options.maxCalls, options.maxOutputTokens].some(value => value === undefined)) {
                throw new CliError("Replay requires --model, --max-calls, and --max-output-tokens unless --offline is set.");
            }
            const maxToolCalls = options.maxToolCalls === undefined ? undefined : Number(options.maxToolCalls);
            if (maxToolCalls !== undefined && (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1))
                throw new CliError("--max-tool-calls must be a positive integer.");
            const result = await service.replay(options.run, { harness: options.harness,
                ...(options.offline ? { offline: true } : { model: options.model, maxCalls: Number(options.maxCalls), maxOutputTokens: Number(options.maxOutputTokens) }),
                ...(options.environment !== undefined ? { environment: options.environment } : {}),
                ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
                ...(options.id ? { id: options.id } : {}) }, options.offline ? undefined : executionTarget(options));
            emit(this, result);
        });
}
