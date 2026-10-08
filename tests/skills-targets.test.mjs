import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CliError } from "../dist/errors.js";
import { resolveSkillTarget } from "../dist/skills/targets.js";

const homeDirectory = path.resolve(os.tmpdir(), "synthetic-skill-target-home");
const cwd = path.join(homeDirectory, "synthetic-project");
const context = { homeDirectory, cwd, environment: {} };

test("the default destination is the shared user skill directory", () => {
  const result = resolveSkillTarget({}, context);
  assert.equal(result.harness, "agents");
  assert.equal(result.directory, path.join(homeDirectory, ".agents", "skills"));
  assert.match(result.reload, /Codex, Cursor, and OpenCode/);
  assert.match(result.reload, /--harness claude/);
});

test("explicit harnesses resolve documented user skill locations", () => {
  const expected = {
    codex: [".agents", "skills"],
    claude: [".claude", "skills"],
    cursor: [".cursor", "skills"],
    opencode: [".config", "opencode", "skills"],
  };
  for (const [harness, segments] of Object.entries(expected)) {
    const result = resolveSkillTarget({ harness }, context);
    assert.equal(result.harness, harness);
    assert.equal(result.directory, path.join(homeDirectory, ...segments));
    assert.ok(result.label.length > 0);
    assert.ok(result.reload.length > 0);
  }
});

test("explicit directory supports absolute, relative, and quoted home-relative paths", () => {
  for (const [directory, expected] of [
    [path.join(homeDirectory, "custom"), path.join(homeDirectory, "custom")],
    ["local-skills", path.join(cwd, "local-skills")],
    ["~/.agents/skills", path.join(homeDirectory, ".agents", "skills")],
  ]) {
    const result = resolveSkillTarget({ directory }, context);
    assert.equal(result.harness, "custom");
    assert.equal(result.directory, expected);
  }
});

test("ambiguous or invalid destination arguments fail explicitly", () => {
  assert.throws(() => resolveSkillTarget({ harness: "codex", directory: "local-skills" }, context), /not both/);
  for (const directory of ["", "   ", "invalid\0path"]) assert.throws(() => resolveSkillTarget({ directory }, context), CliError);
  for (const harness of ["", "automatic", "agents", "Claude"]) assert.throws(() => resolveSkillTarget({ harness }, context), /Unsupported harness/);
});

test("Claude Code honors CLAUDE_CONFIG_DIR without changing other harnesses", () => {
  const custom = path.join(homeDirectory, "alternate-claude");
  const configured = { ...context, environment: { CLAUDE_CONFIG_DIR: custom } };
  assert.equal(resolveSkillTarget({ harness: "claude" }, configured).directory, path.join(custom, "skills"));
  assert.equal(resolveSkillTarget({}, configured).directory, path.join(homeDirectory, ".agents", "skills"));
  assert.equal(resolveSkillTarget({ harness: "cursor" }, configured).directory, path.join(homeDirectory, ".cursor", "skills"));
});

test("OpenCode honors its custom directory before the XDG config root", () => {
  const xdg = path.join(homeDirectory, "xdg-config");
  const custom = path.join(homeDirectory, "alternate-opencode");
  assert.equal(resolveSkillTarget({ harness: "opencode" }, { ...context, environment: { XDG_CONFIG_HOME: xdg } }).directory, path.join(xdg, "opencode", "skills"));
  assert.equal(resolveSkillTarget({ harness: "opencode" }, { ...context, environment: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: custom } }).directory, path.join(custom, "skills"));
  assert.equal(resolveSkillTarget({ harness: "opencode" }, { ...context, environment: { XDG_CONFIG_HOME: "invalid\0unused", OPENCODE_CONFIG_DIR: custom } }).directory, path.join(custom, "skills"));
});

test("empty configuration overrides use defaults and malformed selected overrides fail", () => {
  const empty = { ...context, environment: { CLAUDE_CONFIG_DIR: "", OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" } };
  assert.equal(resolveSkillTarget({ harness: "claude" }, empty).directory, path.join(homeDirectory, ".claude", "skills"));
  assert.equal(resolveSkillTarget({ harness: "opencode" }, empty).directory, path.join(homeDirectory, ".config", "opencode", "skills"));
  assert.throws(() => resolveSkillTarget({ harness: "claude" }, { ...context, environment: { CLAUDE_CONFIG_DIR: "  " } }), /CLAUDE_CONFIG_DIR/);
  assert.throws(() => resolveSkillTarget({ harness: "opencode" }, { ...context, environment: { OPENCODE_CONFIG_DIR: "\0" } }), /OPENCODE_CONFIG_DIR/);
  assert.throws(() => resolveSkillTarget({ harness: "opencode" }, { ...context, environment: { XDG_CONFIG_HOME: "relative-config" } }), /must be an absolute/);
});

test("the current Codex user skill location is independent of legacy CODEX_HOME", () => {
  const configured = { ...context, environment: { CODEX_HOME: path.join(homeDirectory, "alternate-codex") } };
  assert.equal(resolveSkillTarget({ harness: "codex" }, configured).directory, path.join(homeDirectory, ".agents", "skills"));
});
