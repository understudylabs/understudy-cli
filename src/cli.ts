import { Command, CommanderError } from "commander";

import {
  addAuthenticationCommands,
  createAuthCommandDependencies,
  type AuthCommandDependencies,
} from "./commands/auth.js";
import { addModelsCommand } from "./commands/models.js";
import { addBillingCommands } from "./commands/billing.js";
import { addCapturesCommands } from "./commands/captures.js";
import { addContextCommands } from "./commands/context.js";
import { addKeysCommands } from "./commands/keys.js";
import { addMigrationCommands } from "./commands/migrations.js";
import { addProjectsCommands } from "./commands/projects.js";
import { addReportCommands } from "./commands/report.js";
import { addFailureReportCommand, addReportReadCommands } from "./commands/report-reads.js";
import { addRequestsCommands } from "./commands/requests.js";
import {
  addSetupCommand,
  createSetupCommandDependencies,
  type SetupCommandDependencies,
} from "./commands/setup.js";
import { addStatusCommand } from "./commands/status.js";
import { addSkillsCommands } from "./commands/skills.js";
import { addTestCommand } from "./commands/test.js";
import { addWorkloadsCommands } from "./commands/workloads.js";
import { CliError, MissingCapabilityError } from "./errors.js";
import { sanitizeTerminalText, stringifyJsonOutput } from "./output.js";

const packageVersion = "0.1.0";

export function createCli(
  authDependencies: AuthCommandDependencies = createAuthCommandDependencies(),
  setupDependencies: SetupCommandDependencies =
    createSetupCommandDependencies(),
): Command {
  const program = new Command()
    .name("understudy")
    .description("Configure, verify, and inspect an Understudy integration.")
    .version(packageVersion)
    .option("--json", "Output JSON.")
    .showHelpAfterError();

  addAuthenticationCommands(program, authDependencies);
  addBillingCommands(program);
  addCapturesCommands(program);
  addContextCommands(program);
  addKeysCommands(program);
  addModelsCommand(program);
  addMigrationCommands(program);
  addProjectsCommands(program);
  addReportCommands(program);
  addReportReadCommands(program);
  addFailureReportCommand(program);
  addRequestsCommands(program);
  addSetupCommand(program, setupDependencies);
  addStatusCommand(program);
  addSkillsCommands(program);
  addTestCommand(program);
  addWorkloadsCommands(program);
  return program;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const json = argv.slice(2).includes("--json");
  const program = createCli();
  configureTerminalSafeErrors(program);
  if (json) configureStructuredErrors(program);

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (isSuccessfulCommanderExit(error)) return;

    process.exitCode = 1;
    const failure = describeFailure(error);
    if (json) {
      process.stderr.write(
        `${stringifyJsonOutput({ ok: false, error: failure })}\n`,
      );
      return;
    }
    process.stderr.write(`Error: ${sanitizeTerminalText(failure.message)}\n`);
  }
}

type FailureType = "usage_error" | "cli_error" | "unexpected_error" | "missing_capability";

interface CliFailure {
  type: FailureType;
  message: string;
  command?: string;
  inputContract?: unknown;
  outputContract?: unknown;
}

function configureTerminalSafeErrors(command: Command): void {
  command.configureOutput({
    outputError: (message, write) =>
      write(message.split("\n").map(sanitizeTerminalText).join("\n")),
  });
  for (const child of command.commands) configureTerminalSafeErrors(child);
}

function configureStructuredErrors(command: Command): void {
  command.exitOverride();
  command.configureOutput({ writeErr: () => undefined });
  for (const child of command.commands) configureStructuredErrors(child);
}

function isSuccessfulCommanderExit(error: unknown): boolean {
  return (
    error instanceof CommanderError &&
    error.exitCode === 0 &&
    ["commander.help", "commander.helpDisplayed", "commander.version"].includes(
      error.code,
    )
  );
}

function describeFailure(error: unknown): CliFailure {
  if (error instanceof MissingCapabilityError) return { type: error.code, message: error.message, command: error.command, inputContract: error.inputContract, outputContract: error.outputContract };
  if (error instanceof CommanderError) {
    return {
      type: "usage_error",
      message: error.message.replace(/^error:\s*/i, ""),
    };
  }
  if (error instanceof CliError) {
    return { type: "cli_error", message: error.message };
  }
  return {
    type: "unexpected_error",
    message: "The command failed unexpectedly.",
  };
}
