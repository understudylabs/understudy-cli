import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import { CliError } from "../errors.js";
import {
  reportGitState,
  sessionStateSchema,
  resolveApiUrl,
  resolveHookCredential,
  type GitStateDependencies,
} from "../hooks/git-state.js";
import {
  cliEntry,
  gitStateCommand,
  readSettings,
  resolveClaudeSettingsPath,
  withGitStateHooks,
  withoutGitStateHooks,
  writeSettings,
} from "../hooks/settings.js";
import { createInferenceCredentialStore } from "../inference/credentials.js";
import { formatOutput } from "../output.js";
import { createPrivateJsonStore, ensurePrivateDirectory } from "../storage/private-json.js";

const execute = promisify(execFile);
const hookInputMaxBytes = 256 * 1024;

export function addHooksCommands(
  program: Command,
  gitStateDependencies: () => GitStateDependencies = createGitStateDependencies,
): void {
  const hooks = program.command("hooks")
    .description("Install Claude Code hooks that tie its spend to the pull requests it produces.");

  hooks.command("install")
    .description("Add the hooks to Claude Code settings, replacing an earlier install.")
    .option("--settings <file>", "Claude Code settings file; defaults to $CLAUDE_CONFIG_DIR or ~/.claude settings.json.")
    .option("--api-url <origin>", "Understudy API origin, for local development.")
    .addHelpText("after", `
On each prompt and after each shell command, Claude Code runs this CLI, which
reports the session's repository, branch, and commit to Understudy when they
change. It sends no code, prompts, paths, or remote credentials. Understudy
uses it to show what each pull request cost. The key is UNDERSTUDY_API_KEY,
an Understudy ANTHROPIC_API_KEY, or the one stored by understudy setup.
`)
    .action(async function (this: Command, options: { settings?: string; apiUrl?: string }) {
      if (options.apiUrl !== undefined && resolveApiUrl(options.apiUrl, {}) === null) {
        throw new CliError("--api-url must be an https origin, or http on localhost.");
      }
      const file = resolveClaudeSettingsPath(options.settings);
      const command = gitStateCommand(cliEntry(), options.apiUrl);
      await writeSettings(file, withGitStateHooks(await readSettings(file), command));
      process.stdout.write(`${formatOutput(this, { installed: true, settings: file, command }, [
        `Installed the work hooks in ${file}.`,
        "New Claude Code sessions report their git state; restart running ones.",
      ])}\n`);
    });

  hooks.command("uninstall")
    .description("Remove only these hooks from Claude Code settings.")
    .option("--settings <file>", "Claude Code settings file; defaults to $CLAUDE_CONFIG_DIR or ~/.claude settings.json.")
    .action(async function (this: Command, options: { settings?: string }) {
      const file = resolveClaudeSettingsPath(options.settings);
      await writeSettings(file, withoutGitStateHooks(await readSettings(file)));
      process.stdout.write(`${formatOutput(this, { installed: false, settings: file }, [
        `Removed the work hooks from ${file}.`,
      ])}\n`);
    });

  // Claude Code runs this; nothing reaches stdout or stderr and it always
  // exits 0, since a hook's output joins the model's context.
  hooks.command("git-state", { hidden: true })
    .option("--harness <harness>", "The coding tool running the hook.", "claude_code")
    .option("--api-url <origin>")
    .action(async (options: { harness: string; apiUrl?: string }) => {
      const apiUrl = resolveApiUrl(options.apiUrl, process.env);
      if (options.harness !== "claude_code" || apiUrl === null) return;
      await reportGitState({ harness: "claude_code", apiUrl }, gitStateDependencies());
    });
}

export function createGitStateDependencies(): GitStateDependencies {
  const directory = path.join(homedir(), ".understudy", "work-hooks");
  const inferenceStore = createInferenceCredentialStore();
  const authStore = createCredentialStore();
  return {
    now: () => Date.now(),
    readInput: () => readStdin(hookInputMaxBytes, 1_000),
    git: async (cwd, args) => {
      // Without inherited GIT_* overrides, like the migration commands.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
      try {
        const { stdout } = await execute("git", ["-C", cwd, ...args], { env, timeout: 1_500, maxBuffer: 64 * 1024 });
        return stdout.trim();
      } catch {
        return null;
      }
    },
    sessionState: (sessionId) =>
      createPrivateJsonStore({
        directory,
        fileName: `${sessionFile(sessionId)}.json`,
        label: "work hook state",
        schema: sessionStateSchema,
      }),
    // mkdir is atomic: whoever creates the directory holds the lock. A lock
    // older than a hook's timeout belongs to a process that died.
    lockSession: async (sessionId, operation) => {
      await ensurePrivateDirectory(directory);
      const lock = path.join(directory, `${sessionFile(sessionId)}.lock`);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await mkdir(lock, { mode: 0o700 });
        } catch {
          const entry = await lstat(lock).catch(() => null);
          if (entry && Date.now() - entry.mtimeMs > 10_000) await rmdir(lock).catch(() => undefined);
          await sleep(25);
          continue;
        }
        try {
          return await operation();
        } finally {
          await rmdir(lock).catch(() => undefined);
        }
      }
      return undefined;
    },
    pruneSessionStates: async (olderThanMs) => {
      for (const name of await readdir(directory).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(directory, name);
        const entry = await lstat(file).catch(() => null);
        if (entry?.isFile() && entry.mtimeMs < olderThanMs) await unlink(file).catch(() => undefined);
      }
    },
    credential: async () => {
      const inference = await inferenceStore.read().catch(() => null);
      const auth = await authStore.read().catch(() => null);
      return resolveHookCredential(process.env, [
        inference ?? {},
        auth?.method === "organization_key" ? auth : {},
      ]);
    },
  };
}

function sessionFile(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function readStdin(maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(size > maxBytes ? "" : Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
      else finish();
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
