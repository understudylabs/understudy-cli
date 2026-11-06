import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError } from "../errors.js";

/** Recognizes the hooks this CLI installed, so reinstalling replaces them. */
export const gitStateCommandMarker = "'hooks' 'git-state'";

export interface HookSettingsContext {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

/** `--settings`, else Claude Code's settings in `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function resolveClaudeSettingsPath(settings: string | undefined, context: HookSettingsContext = {}): string {
  const homeDirectory = context.homeDirectory ?? os.homedir();
  const environment = context.environment ?? process.env;
  const expand = (value: string) =>
    value === "~" ? homeDirectory : value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : path.resolve(value);
  if (settings !== undefined) {
    if (!settings.trim() || settings.includes("\0")) throw new CliError("--settings must be a file path.");
    return expand(settings);
  }
  const configDirectory = environment.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDirectory ? expand(configDirectory) : path.join(homeDirectory, ".claude"), "settings.json");
}

/**
 * The command Claude Code runs: this CLI by absolute path, since hooks run
 * in a shell whose PATH may not find it, and each argument single-quoted.
 */
export function gitStateCommand(entry: readonly string[], apiUrl: string | undefined): string {
  const words = [...entry, "hooks", "git-state", "--harness", "claude_code", ...(apiUrl ? ["--api-url", apiUrl] : [])];
  for (const word of words) {
    if (word.includes("'")) throw new CliError("The CLI's path contains a quote; install it elsewhere and retry.");
  }
  return words.map((word) => `'${word}'`).join(" ");
}

/**
 * How this process was started: node with its script (which a package
 * manager's `bin` link may name without an extension), or the compiled
 * binary, whose script path exists only inside it.
 */
export function cliEntry(
  execPath = process.execPath,
  script = process.argv[1],
  exists: (file: string) => boolean = existsSync,
): string[] {
  return script && exists(script) ? [execPath, path.resolve(script)] : [execPath];
}

type Settings = Record<string, unknown>;
type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/**
 * Claude Code runs the hook on each prompt and after each shell command,
 * failed ones included (a commit can precede the failure), the only places
 * git state changes before its next model request. Windows sessions run
 * shell commands as `PowerShell`. `async` keeps the hook off the agent's path.
 */
export function withGitStateHooks(settings: Settings, command: string): Settings {
  const handler = { type: "command", command, timeout: 10, async: true };
  const shell = { matcher: "Bash|PowerShell", hooks: [handler] };
  const hooks = withoutGitStateHooks(settings).hooks as Record<string, HookGroup[]> | undefined;
  return {
    ...settings,
    hooks: {
      ...hooks,
      UserPromptSubmit: [...(hooks?.UserPromptSubmit ?? []), { hooks: [handler] }],
      PostToolUse: [...(hooks?.PostToolUse ?? []), shell],
      PostToolUseFailure: [...(hooks?.PostToolUseFailure ?? []), shell],
    },
  };
}

export function withoutGitStateHooks(settings: Settings): Settings {
  const hooks = settings.hooks;
  if (hooks === undefined) return settings;
  if (!isObject(hooks)) throw new CliError("Claude Code settings have a `hooks` value that is not an object.");
  const kept: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const remaining = (groups as HookGroup[])
      .map((group) =>
        Array.isArray(group?.hooks)
          ? { ...group, hooks: group.hooks.filter((hook) => !hook?.command?.includes(gitStateCommandMarker)) }
          : group,
      )
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (remaining.length > 0) kept[event] = remaining;
  }
  const { hooks: _hooks, ...rest } = settings;
  return Object.keys(kept).length > 0 ? { ...rest, hooks: kept } : rest;
}

export async function readSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not valid JSON. Fix it, then retry; nothing was changed.`);
  }
  if (!isObject(parsed)) throw new CliError(`${file} must hold a JSON object; nothing was changed.`);
  return parsed;
}

/** Writes a sibling temporary file, then renames it over the settings, keeping their mode. */
export async function writeSettings(file: string, settings: Settings): Promise<void> {
  const mode = await lstat(file).then((entry) => entry.mode & 0o777, () => 0o600);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isObject(value: unknown): value is Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
