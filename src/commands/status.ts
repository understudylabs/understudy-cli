import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { createInferenceCredentialStore } from "../inference/credentials.js";
import { formatOutput } from "../output.js";
import { getStatus, type StatusResult } from "../status/service.js";

export interface StatusCommandDependencies {
  status(): Promise<StatusResult>;
  output(message: string): void;
  setExitCode(code: number): void;
}

export function createStatusCommandDependencies(): StatusCommandDependencies {
  const authStore = createCredentialStore();
  const inferenceStore = createInferenceCredentialStore();
  return {
    status: () => getStatus({ authStore, inferenceStore }),
    output: (message) => process.stdout.write(`${message}\n`),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

export function addStatusCommand(
  program: Command,
  dependencies: StatusCommandDependencies = createStatusCommandDependencies(),
): void {
  program
    .command("status")
    .description("Check login, setup, and Understudy connectivity.")
    .action(async function (this: Command) {
      const result = await dependencies.status();
      dependencies.output(formatStatus(this, result));
      if (!result.ready) dependencies.setExitCode(1);
    });
}

function formatStatus(command: Command, result: StatusResult): string {
  return formatOutput(command, result, [
    `Login          ${result.authenticated ? "signed in" : "signed out"}`,
    `Organization   ${result.organizationId ?? "not available"}`,
    `Management     ${result.management.replace("-", " ")}`,
    `Access         ${result.access.replaceAll("-", " ")}`,
    `Projects       ${result.projectCount ?? "not checked"}`,
    `Models         ${result.modelCount ?? "not checked"}`,
    ...(result.access === "service-mismatch"
      ? ["Stored inference access belongs to another service. Run `understudy setup --replace` to configure access for the active service."]
      : []),
  ]);
}
