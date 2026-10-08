import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { createInferenceCredentialStore } from "../inference/credentials.js";
import {
  setupInference,
  type InferenceSetupResult,
} from "../inference/service.js";
import { formatOutput } from "../output.js";

export interface SetupCommandDependencies {
  setup(replace: boolean): Promise<InferenceSetupResult>;
  output(message: string): void;
}

export function createSetupCommandDependencies(): SetupCommandDependencies {
  const authStore = createCredentialStore();
  const inferenceStore = createInferenceCredentialStore();
  return {
    setup: (replace) => setupInference({ authStore, inferenceStore, replace }),
    output: (message) => process.stdout.write(`${message}\n`),
  };
}

export function addSetupCommand(
  program: Command,
  dependencies: SetupCommandDependencies,
): void {
  program
    .command("setup")
    .description("Prepare private inference access for CLI probes and replay.")
    .option("--replace", "Replace stored inference access.")
    .action(async function (this: Command, options: { replace?: boolean }) {
      const result = await dependencies.setup(options.replace === true);
      dependencies.output(
        formatOutput(
          this,
          { ready: true, status: result.status },
          [result.status === "created"
            ? "Private CLI inference access is ready."
            : result.status === "replaced"
              ? "Private CLI inference access replaced."
              : "Private CLI inference access is already ready.",
          "To connect your application, install skills with `understudy skills install` and ask your agent to use setup-understudy."],
        ),
      );
    });
}
