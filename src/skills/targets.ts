import os from "node:os";
import path from "node:path";

import { CliError } from "../errors.js";

export interface SkillTargetOptions {
  harness?: string;
  directory?: string;
}

export interface SkillTargetContext {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface SkillTarget {
  harness: "agents" | "codex" | "claude" | "cursor" | "opencode" | "custom";
  label: string;
  directory: string;
  reload: string;
}

export function resolveSkillTarget(
  options: SkillTargetOptions = {},
  context: SkillTargetContext = {},
): SkillTarget {
  if (options.harness !== undefined && options.directory !== undefined) {
    throw new CliError("Choose --harness or --directory, not both.");
  }
  const homeDirectory = context.homeDirectory ?? os.homedir();
  const environment = context.environment ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  const resolve = (value: string, label: string) => {
    if (!value.trim() || value.includes("\0")) throw new CliError(`${label} must be a non-empty directory path.`);
    if (value === "~") return homeDirectory;
    if (value.startsWith("~/") || (path.sep === "\\" && value.startsWith("~\\"))) {
      return path.resolve(homeDirectory, value.slice(2));
    }
    return path.resolve(cwd, value);
  };
  if (options.directory !== undefined) {
    return {
      harness: "custom",
      label: "Custom skill directory",
      directory: resolve(options.directory, "--directory"),
      reload: "Confirm your agent reads this skill directory, then start a new session if the skills do not appear.",
    };
  }
  const configured = (name: string, fallback: string) => {
    const value = environment[name];
    return value === undefined || value === "" ? fallback : resolve(value, name);
  };
  switch (options.harness) {
    case undefined:
      return {
        harness: "agents",
        label: "Shared agent skills",
        directory: path.join(homeDirectory, ".agents", "skills"),
        reload: "Shared skills are discoverable by Codex, Cursor, and OpenCode. Start a new agent session if they do not appear. For Claude Code, install with --harness claude.",
      };
    case "codex":
      return {
        harness: "codex",
        label: "Codex",
        directory: path.join(homeDirectory, ".agents", "skills"),
        reload: "Codex detects skill changes automatically. Restart Codex if the skills do not appear.",
      };
    case "claude":
      return {
        harness: "claude",
        label: "Claude Code",
        directory: path.join(configured("CLAUDE_CONFIG_DIR", path.join(homeDirectory, ".claude")), "skills"),
        reload: "Start a new Claude Code session if the skills do not appear in the skill menu.",
      };
    case "cursor":
      return {
        harness: "cursor",
        label: "Cursor",
        directory: path.join(homeDirectory, ".cursor", "skills"),
        reload: "Start a new Cursor agent session if the skills do not appear.",
      };
    case "opencode": {
      const customDirectory = environment.OPENCODE_CONFIG_DIR;
      const xdgDirectory = environment.XDG_CONFIG_HOME;
      if (!customDirectory && xdgDirectory && !path.isAbsolute(xdgDirectory)) {
        throw new CliError("XDG_CONFIG_HOME must be an absolute directory path; use --directory for a custom skill root.");
      }
      const configDirectory = customDirectory !== undefined && customDirectory !== ""
        ? resolve(customDirectory, "OPENCODE_CONFIG_DIR")
        : path.join(configured("XDG_CONFIG_HOME", path.join(homeDirectory, ".config")), "opencode");
      return {
        harness: "opencode",
        label: "OpenCode",
        directory: path.join(configDirectory, "skills"),
        reload: "Start a new OpenCode session if the skills do not appear.",
      };
    }
    default:
      throw new CliError(`Unsupported harness: ${options.harness}. Choose codex, claude, cursor, or opencode.`);
  }
}
