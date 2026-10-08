import { spawn } from "node:child_process";
import { constants } from "node:os";

import { CliError } from "../errors.js";
import { defaultManagementUrl } from "../management/client.js";
import { resolveManagementSession, type ManagementSessionOptions } from "../management/session.js";
import { readKeyCredential, type KeyStoreFactory } from "./credentials.js";

export interface KeyExecInput { reference: string; command: string; args?: string[] }
export interface KeyExecOptions extends ManagementSessionOptions {
  keyStoreFactory?: KeyStoreFactory;
  environment?: NodeJS.ProcessEnv;
  launch?: (command: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<number>;
}

/** Pass a saved credential to a user-selected child without putting it in argv. */
export async function execWithKey(options: KeyExecOptions, input: KeyExecInput): Promise<number> {
  if (!/^key:[a-f0-9]{64}$/.test(input.reference)) throw new CliError("Invalid private key reference.");
  if (!input.command.trim() || input.command.includes("\0") || input.args?.some((arg) => arg.includes("\0"))) {
    throw new CliError("Provide a command and valid arguments after --.");
  }
  const stored = await readKeyCredential(input.reference, options.keyStoreFactory);
  const session = await resolveManagementSession(options);
  const service = new URL(stored.serviceUrl);
  if (stored.organizationId !== session.organizationId || service.origin !== new URL(session.baseUrl ?? defaultManagementUrl).origin
    || service.protocol !== "https:" || service.username || service.password || service.search || service.hash || service.pathname !== "/") {
    throw new CliError("The saved key does not belong to the active organization and service. Sign in with the intended identity.");
  }
  const environment = { ...(options.environment ?? process.env), UNDERSTUDY_API_KEY: stored.value,
    UNDERSTUDY_GATEWAY_URL: service.origin, UNDERSTUDY_ORG_ID: stored.organizationId };
  try {
    return await (options.launch ?? launchChild)(input.command, input.args ?? [], environment);
  } catch {
    throw new CliError("The command could not be started with the saved key. Command arguments and credential values are not displayed.");
  }
}

function launchChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
}
