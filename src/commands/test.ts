import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { CliError } from "../errors.js";
import type {
  InferenceApi,
  InferenceTestResult,
} from "../inference/client.js";
import { createInferenceCredentialStore } from "../inference/credentials.js";
import { routableModelIdPattern } from "../models/service.js";
import { formatOutput } from "../output.js";
import { runTest } from "../test/service.js";

const projectPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const workloadPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

interface TestArguments {
  api: InferenceApi;
  model: string;
  project: string;
  workload: string;
}

type TestCommandOptions = Omit<TestArguments, "api"> & { api: string };

export interface TestCommandDependencies {
  test(options: TestArguments): Promise<InferenceTestResult>;
  output(message: string): void;
}

export function createTestCommandDependencies(): TestCommandDependencies {
  const authStore = createCredentialStore();
  const inferenceStore = createInferenceCredentialStore();
  return {
    test: (options) => runTest({ authStore, inferenceStore, ...options }),
    output: (message) => process.stdout.write(`${message}\n`),
  };
}

export function addTestCommand(
  program: Command,
  dependencies: TestCommandDependencies = createTestCommandDependencies(),
): void {
  program
    .command("test")
    .description("Send one tiny synthetic request through Understudy.")
    .requiredOption("--api <api>", "Inference API: openai or anthropic.")
    .requiredOption("--model <id>", "Routable model id.")
    .requiredOption("--project <slug>", "Existing project slug.")
    .requiredOption("--workload <name>", "Existing workload name.")
    .action(async function (this: Command, options: TestCommandOptions) {
      const api = parseApi(options.api);
      validateSelector(options.model, "model", routableModelIdPattern);
      validateSelector(options.project, "project", projectPattern);
      validateSelector(options.workload, "workload", workloadPattern);
      const result = await dependencies.test({ ...options, api });
      dependencies.output(
        formatOutput(this, result, [
          "Understudy test passed.",
          `Request   ${result.requestId}`,
          `API       ${result.api}`,
          `Project   ${result.project}`,
          `Workload  ${result.workload}`,
          `Environment ${result.requestEnvironment}`,
          `Model     ${result.effectiveModel}`,
          `Mode      ${result.mode}`,
          `Route     ${result.route}`,
          `Latency   ${result.latencyMs} ms`,
        ]),
      );
    });
}

function parseApi(value: string): InferenceApi {
  if (value !== "openai" && value !== "anthropic") {
    throw new CliError("Invalid API. Use `openai` or `anthropic`.");
  }
  return value;
}

function validateSelector(
  value: string,
  label: string,
  pattern: RegExp,
): void {
  if (!pattern.test(value)) {
    throw new CliError(`Invalid ${label}. Use its exact Understudy identifier.`);
  }
}
