import { Command } from "commander";

import { createCredentialStore, type CredentialStore } from "../auth/credentials.js";
import { beginEmailLogin, completeEmailLogin, createPendingEmailStore, type EmailLoginResult } from "../auth/email.js";
import { readSignInCode } from "../auth/input.js";
import { getAuthenticationStatus, loginWithOAuth } from "../auth/service.js";
import { CliError } from "../errors.js";
import { createInferenceCredentialStore } from "../inference/credentials.js";
import { resolveManagementSession, verifyManagementIdentity } from "../management/session.js";
import { formatOutput, isJsonOutput } from "../output.js";

export interface AuthCommandDependencies {
  store: CredentialStore;
  output(message: string): void;
  loginWithOAuth(output: (message: string) => void): Promise<void>;
  beginEmail?(email: string): Promise<{ pending: true; expiresAt: string }>;
  completeEmail?(code: string): Promise<EmailLoginResult>;
  readCode?(): Promise<string>;
  pending?(): Promise<{ pending: boolean; expiresAt: string | null }>;
  whoami?(): Promise<{ organizationId: string; credentialClass: "oauth" | "organization_key" }>;
  clear?(inference: boolean): Promise<void>;
}

export function createAuthCommandDependencies(): AuthCommandDependencies {
  const store = createCredentialStore();
  const inferenceStore = createInferenceCredentialStore();
  const pendingStore = createPendingEmailStore();
  const options = { store, inferenceStore, pendingStore };
  return {
    store,
    output: (message) => process.stdout.write(`${message}\n`),
    loginWithOAuth: (output) => loginWithOAuth({ store, output }),
    beginEmail: (email) => beginEmailLogin(options, email),
    completeEmail: (code) => completeEmailLogin(options, code),
    readCode: readSignInCode,
    pending: async () => {
      const saved = await pendingStore.read();
      return { pending: Boolean(saved && saved.expiresAt > Date.now()), expiresAt: saved ? new Date(saved.expiresAt).toISOString() : null };
    },
    whoami: async () => {
      const session = await resolveManagementSession({ store });
      if (session.credentialClass === "oauth") await verifyManagementIdentity(session);
      return { organizationId: session.organizationId, credentialClass: session.credentialClass };
    },
    clear: async (inference) => {
      await store.clear();
      await pendingStore.clear();
      if (inference) await inferenceStore.withSetupLock(() => inferenceStore.clear());
    },
  };
}

export function addAuthenticationCommands(program: Command, dependencies: AuthCommandDependencies): void {
  program.command("login").description("Sign in with browser OAuth, or request and complete an email-code sign-in.")
    .option("--email <email>", "Request an email code and save a private pending sign-in.")
    .option("--send-code", "Request the email code and exit; requires --email.")
    .option("--code [code]", "Complete pending email sign-in with the six-digit code; omit the value for hidden input or stdin.")
    .action(async function (this: Command, options: { email?: string; sendCode?: boolean; code?: string | true }) {
      const hasCode = options.code !== undefined;
      if ((hasCode && (options.email !== undefined || options.sendCode)) || (options.sendCode && !options.email)) {
        throw new CliError("Use --email [--send-code] to request a code, or --code to complete a pending sign-in.");
      }
      if (options.email !== undefined) {
        if (!dependencies.beginEmail) throw new CliError("Email authentication is unavailable.");
        const result = await dependencies.beginEmail(options.email);
        dependencies.output(formatOutput(this, result, "Email code requested. Complete sign-in with `understudy login --code <code>`."));
        return;
      }
      if (hasCode) {
        if (!dependencies.completeEmail || (options.code === true && !dependencies.readCode)) throw new CliError("Email authentication is unavailable.");
        const code = typeof options.code === "string" ? options.code : await dependencies.readCode!();
        const result = await dependencies.completeEmail(code);
        dependencies.output(formatOutput(this, result, ["Signed in with an organization API key.",
          ...(result.project ? [`Default project: ${result.project.slug}. Context saved for this directory.`] : []),
          ...(result.inferenceReady ? [] : ["Existing inference access was preserved for another organization or service. Inspect `understudy status` before setting up inference."]),
        ]));
        return;
      }
      if (isJsonOutput(this)) throw new CliError("Login is interactive and does not support --json. Run `understudy login`, or use email sign-in.");
      await dependencies.loginWithOAuth(dependencies.output);
      dependencies.output(formatOutput(this, { authenticated: true, method: "oauth" }, "Signed in with OAuth."));
    });

  program.command("logout").description("Remove active local authentication and pending email sign-in; keep inference access.")
    .action(async function (this: Command) {
      if (dependencies.clear) await dependencies.clear(false);
      else await dependencies.store.clear();
      dependencies.output(formatOutput(this, { authenticated: false, method: null }, "Logged out."));
    });

  const auth = program.command("auth").description("Inspect identity and remove private local authentication.");
  auth.command("status").description("Show stored credential class and pending sign-in without contacting the server.")
    .action(async function (this: Command) {
      const status = await getAuthenticationStatus(dependencies.store);
      const pending = await dependencies.pending?.() ?? { pending: false, expiresAt: null };
      const method = status.method === "none" ? null : status.method;
      const result = { authenticated: method !== null, method, verification: "local", ...pending,
        ...(status.method === "organization_key" ? { organizationId: status.organizationId, oauthOnlyOperations: false } : {}) };
      const identityLine = method === null ? "Not authenticated. Run `understudy login`." :
        method === "oauth" ? "Authentication configured with OAuth (stored session; not verified online)." :
          "Authentication configured with an organization API key. OAuth-only operations require browser login.";
      dependencies.output(formatOutput(this, result, [identityLine,
        ...(pending.pending ? [`Email sign-in pending until ${pending.expiresAt}. Complete it with \`understudy login --code <code>\`.`] : []),
      ]));
    });
  auth.command("whoami").description("Verify the active organization and credential class with Understudy.")
    .action(async function (this: Command) {
      if (!dependencies.whoami) throw new CliError("Online authentication verification is unavailable.");
      const result = await dependencies.whoami();
      dependencies.output(formatOutput(this, { authenticated: true, ...result, verification: "remote" }, [
        `Organization ${result.organizationId}`, `Credential   ${result.credentialClass}`, "Verification remote organization scope",
      ]));
    });
  auth.command("clear").description("Clear local authentication and pending email state; no server-side revocation.")
    .option("--inference", "Also remove locally stored inference access.")
    .action(async function (this: Command, options: { inference?: boolean }) {
      if (!dependencies.clear && options.inference) throw new CliError("Inference credential cleanup is unavailable.");
      if (dependencies.clear) await dependencies.clear(options.inference === true);
      else await dependencies.store.clear();
      dependencies.output(formatOutput(this, { authenticated: false, inferenceCleared: options.inference === true, remoteRevocation: false }, "Local authentication cleared."));
    });
}
