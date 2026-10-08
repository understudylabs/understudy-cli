import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { CliError } from "../errors.js";
import { execWithKey, type KeyExecInput } from "../keys/exec.js";
import { createKeysService, type KeysService } from "../keys/service.js";
import { formatOutput, isJsonOutput } from "../output.js";

export interface KeysCommandDependencies extends KeysService {
  output(message: string): void;
  exec?(input: KeyExecInput): Promise<number>;
  setExitCode?(code: number): void;
}

export function createKeysCommandDependencies(): KeysCommandDependencies {
  const options = { store: createCredentialStore() };
  return { ...createKeysService(options), exec: (input) => execWithKey(options, input),
    setExitCode: (code) => { process.exitCode = code; },
    output: (message) => process.stdout.write(`${message}\n`) };
}

export function addKeysCommands(program: Command, dependencies: KeysCommandDependencies = createKeysCommandDependencies()): void {
  const keys = program.command("keys").description("Manage organization API keys with private credential storage.");
  keys.command("list").description("List the key page exposed by the platform.")
    .action(async function (this: Command) {
      const result = await dependencies.list();
      dependencies.output(formatOutput(this, result, [
        ...result.keys.map((key) => `${key.id}  ${key.name}`),
        ...(result.keys.length ? [] : ["No keys returned."]),
        result.limitation,
      ]));
    });
  keys.command("create").description("Create a key and store its one-time value privately.")
    .requiredOption("--name <name>", "Human-readable key name.")
    .action(async function (this: Command, options: { name: string }) {
      const result = await dependencies.create({ name: options.name });
      dependencies.output(formatOutput(this, result, [
        `Created API key ${result.key.id} (${result.key.name}).`,
        `Private credential reference: ${result.credentialReference}`,
      ]));
    });
  keys.command("revoke <key>").description("Revoke an API key by exact id.")
    .option("--confirm", "Confirm revocation of this key.")
    .action(async function (this: Command, key: string, options: { confirm?: boolean }) {
      if (options.confirm !== true) throw new CliError("API key revocation requires --confirm.");
      const result = await dependencies.revoke({ key, confirm: true });
      dependencies.output(formatOutput(this, result, `Revoked API key ${result.id}.`));
    });
  keys.command("exec <reference> <command> [args...]")
    .description("Run a command with a privately saved key in UNDERSTUDY_API_KEY. Put -- before the command.")
    .allowUnknownOption()
    .action(async function (this: Command, reference: string, command: string, args: string[]) {
      if (isJsonOutput(this)) throw new CliError("keys exec inherits the child process output and does not support --json.");
      if (!dependencies.exec) throw new CliError("Private key execution is unavailable.");
      const code = await dependencies.exec({ reference, command, args });
      (dependencies.setExitCode ?? ((value: number) => { process.exitCode = value; }))(code);
    });
}
