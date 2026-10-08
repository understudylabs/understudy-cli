import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const executable = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function runCli(args, options = {}) {
  const cliTestHome = mkdtempSync(path.join(tmpdir(), "synthetic-cli-home-"));
  try {
    return spawnSync(process.execPath, [executable, ...args], {
      encoding: "utf8",
      ...options,
      env: { ...process.env, ...options.env, HOME: cliTestHome, USERPROFILE: cliTestHome },
    });
  } finally {
    rmSync(cliTestHome, { recursive: true, force: true });
  }
}

test("help succeeds without advertising deferred product areas", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: understudy/m);
  assert.match(result.stdout, /--version/);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /--help/);

  for (const deferredArea of [
    "monitoring",
    "evals",
    "desktop",
    "training",
    "local models",
    "optimizer",
  ]) {
    assert.doesNotMatch(result.stdout.toLowerCase(), new RegExp(deferredArea));
  }
});

test("version emits the stable package version", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${packageVersion}\n`);
  assert.equal(result.stderr, "");
});

test("JSON help and version remain successful", () => {
  const help = runCli(["--json", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: understudy/m);
  assert.equal(help.stderr, "");

  const version = runCli(["--json", "--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `${packageVersion}\n`);
  assert.equal(version.stderr, "");
});

test("JSON runtime failures use one structured error", () => {
  const result = runCli(["--json", "report", "--window", "invalid"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: {
      type: "cli_error",
      message: "Invalid window. Use 24h, 7d, or 30d.",
    },
  });
});

test("JSON login fails before starting an interactive OAuth flow", () => {
  const result = runCli(["--json", "login"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: {
      type: "cli_error",
      message:
        "Login is interactive and does not support --json. Run `understudy login`, or use email sign-in.",
    },
  });
});

test("JSON Commander failures suppress human usage output", () => {
  const cases = [
    {
      args: ["--json", "unknown-command"],
      message: "unknown command 'unknown-command'",
    },
    {
      args: ["--json", "workloads", "create"],
      message: "missing required argument 'name'",
    },
  ];

  for (const { args, message } of cases) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: { type: "usage_error", message },
    });
    assert.doesNotMatch(result.stderr, /Usage:/);
  }
});

test("JSON Commander failures escape terminal formatting controls", () => {
  const unsafeCommand = "unknown\u009b\u202e-command";
  const result = runCli(["--json", unsafeCommand]);

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: {
      type: "usage_error",
      message: `unknown command '${unsafeCommand}'`,
    },
  });
  assert.doesNotMatch(result.stderr, /[\u009b\u202e]/);
  assert.match(result.stderr, /\\u009b/);
  assert.match(result.stderr, /\\u202e/);
});

test("human Commander failures sanitize terminal control characters", () => {
  const result = runCli(["unknown\u001b[31m-command"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown\?\[31m-command/);
  assert.doesNotMatch(
    result.stderr,
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/,
  );
});

test("help exposes authentication and setup", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /login/);
  assert.match(result.stdout, /logout/);
  assert.match(result.stdout, /auth/);
  assert.match(result.stdout, /models/);
  assert.match(result.stdout, /projects/);
  assert.match(result.stdout, /report/);
  assert.match(result.stdout, /setup/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /test/);
  assert.match(result.stdout, /workloads/);
  assert.doesNotMatch(result.stdout, /gateway/i);

  const loginHelp = runCli(["login", "--help"]);
  assert.equal(loginHelp.status, 0, loginHelp.stderr);
  assert.doesNotMatch(loginHelp.stdout, /api.key/i);

  const setupHelp = runCli(["setup", "--help"]);
  assert.equal(setupHelp.status, 0, setupHelp.stderr);
  assert.doesNotMatch(setupHelp.stdout, /api.key/i);
});

test("status is safe when no OAuth session exists", () => {
  const result = runCli(["auth", "status"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Not authenticated/i);
});
