import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const reviewedFiles = {
  "adapt-model-api": ["SKILL.md"],
    "compare-models": ["SKILL.md", "references/bundled-comparison.md", "references/comparison-view.md", "references/demo.md", "scripts/compare.mjs", "scripts/present.mjs", "templates/demo-adapter.mjs"],
  "setup-understudy": [
    "SKILL.md",
    "references/anthropic-messages.md",
    "references/mastra.md",
    "references/openai-compatible.md",
    "references/request-correlation.md",
    "references/vercel-ai-sdk.md",
  ],
  "try-models": [
    "SKILL.md",
    "references/spot-check-view.md",
    "references/upgrade.md",
  ],
  "recommend-models": ["SKILL.md", "references/model-facts.md", "references/task-cost.md"],
  "rollout-workload": ["SKILL.md"],
  "check-workload": ["SKILL.md"],
  "build-evals": [
    "SKILL.md",
    "references/captures.md",
    "references/case-review.md",
    "references/check-eval.md",
    "references/formats.md",
    "references/measurements.md",
    "references/medium.md",
    "references/worked-example.md",
    "scripts/eval.mjs",
    "scripts/lib.mjs",
    "scripts/measure.mjs",
    "scripts/report.mjs",
    "scripts/worker.mjs",
    "templates/adapter.mjs",
    "templates/cases.jsonl",
    "templates/controls.jsonl",
    "templates/demo-adapter.mjs",
    "templates/demo-cases.jsonl",
    "templates/demo-controls.jsonl",
    "templates/demo-eval.json",
    "templates/demo-eval.md",
    "templates/demo-grader.mjs",
    "templates/eval.json",
    "templates/eval.md",
    "templates/grader.mjs",
  ],
};

function isolatedDistribution(t) {
  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), "synthetic-skill-distribution-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const packageDirectory = path.join(scratch, "package");
  const home = path.join(scratch, "home");
  const application = path.join(scratch, "application");
  for (const directory of [packageDirectory, home, application]) mkdirSync(directory);

  // Reproduce the installed Node layout without any source skills or checkout links.
  cpSync(path.join(root, "dist"), path.join(packageDirectory, "dist"), { recursive: true });
  cpSync(path.join(root, "package.json"), path.join(packageDirectory, "package.json"));
  for (const [relativePath, dependency] of Object.entries(lockfile.packages)) {
    if (!relativePath || dependency.dev) continue;
    cpSync(path.join(root, relativePath), path.join(packageDirectory, relativePath), { recursive: true });
  }
  assert.equal(existsSync(path.join(packageDirectory, "skills")), false);
  assert.equal(existsSync(path.join(packageDirectory, "src")), false);

  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: path.dirname(process.execPath),
    TMPDIR: scratch,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const run = (args, overrides = {}) => spawnSync(process.execPath, [path.join(packageDirectory, "dist/bin.js"), ...args], {
    cwd: application,
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { scratch, home, application, run };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function failure(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  const output = JSON.parse(result.stderr);
  assert.equal(output.ok, false);
  assert.equal(typeof output.error.message, "string");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertListedSkills(listed) {
  assert.equal(listed.cliVersion, manifest.version);
  assert.deepEqual(listed.skills.map(skill => skill.name).sort(), Object.keys(reviewedFiles).sort());
  for (const skill of listed.skills) {
    assert.equal(skill.entrypoint, "SKILL.md");
    assert.equal(typeof skill.description, "string");
    assert.ok(skill.description.length > 0);
    assert.match(skill.version, /^(?:sha256:)?[a-f0-9]{64}$/);
    assert.deepEqual(skill.files.map(file => file.path).sort(), reviewedFiles[skill.name]);
  }
}

function assertInstalledSkill(installed, skill, directory, status = "installed") {
  assert.equal(installed.cliVersion, manifest.version);
  assert.equal(installed.name, skill.name);
  assert.equal(installed.version, skill.version);
  assert.equal(installed.status, status);
  assert.equal(installed.directory, path.join(directory, skill.name));
  assert.equal(installed.entrypoint, path.join(installed.directory, "SKILL.md"));
  assert.deepEqual(installed.files, skill.files);
  for (const file of installed.files) {
    const reviewed = readFileSync(path.join(root, "skills", skill.name, file.path));
    const actual = readFileSync(path.join(installed.directory, file.path));
    assert.deepEqual(actual, reviewed, `${skill.name}/${file.path}`);
    assert.equal(file.sha256, sha256(reviewed), file.path);
    if (!file.path.endsWith(".md")) continue;
    for (const match of actual.toString("utf8").matchAll(/\]\(([^\s)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        const referenced = path.resolve(installed.directory, path.dirname(file.path), target);
        assert.equal(existsSync(referenced), true, `${file.path} links to installed ${target}`);
      }
    }
  }
}

function assertInstalledAll(result, listed, directory, status = "installed") {
  assert.equal(result.cliVersion, manifest.version);
  assert.equal(result.target.directory, directory);
  assert.equal(typeof result.target.reload, "string");
  assert.deepEqual(result.skills.map(skill => skill.name), listed.skills.map(skill => skill.name));
  for (const skill of listed.skills) {
    assertInstalledSkill(result.skills.find(value => value.name === skill.name), skill, directory, status);
  }
}

test("installed Node distribution installs every reviewed skill in the default shared location without authentication", (t) => {
  const { home, application, run } = isolatedDistribution(t);
  const listed = success(run(["skills", "list", "--json"]));
  assertListedSkills(listed);
  const destination = path.join(home, ".agents", "skills");
  const installed = success(run(["skills", "install", "--json"]));
  assertInstalledAll(installed, listed, destination);
  const repeated = success(run(["skills", "install", "--json"]));
  assert.deepEqual(repeated, { ...installed, skills: installed.skills.map(skill => ({ ...skill, status: "unchanged" })) });
  assert.equal(existsSync(path.join(home, ".understudy")), false);
  assert.deepEqual(readdirSync(application), []);
});

test("installed Node replay help includes technical contracts without source docs or credentials", (t) => {
  const { home, application, run } = isolatedDistribution(t);
  const result = run(["replay", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const contract of ["module.exports", "appendToolResults", "simulateTool", "recordedTools", "stateSchema", "preflight.json"]) {
    assert.ok(result.stdout.includes(contract), contract);
  }
  assert.equal(result.stdout.includes("](replay-"), false, "help must not link to absent source files");
  assert.equal(existsSync(path.join(home, ".understudy")), false);
  assert.deepEqual(readdirSync(application), []);
});

test("installed Node distribution honors explicit coding-agent destinations for all bundled skills", (t) => {
  const { home, application, run } = isolatedDistribution(t);
  const listed = success(run(["skills", "list", "--json"]));
  const destinations = {
    codex: path.join(home, ".agents", "skills"),
    claude: path.join(home, ".claude", "skills"),
    cursor: path.join(home, ".cursor", "skills"),
    opencode: path.join(home, ".config", "opencode", "skills"),
  };
  for (const [harness, destination] of Object.entries(destinations)) {
    const installed = success(run(["skills", "install", "--harness", harness, "--json"]));
    assertInstalledAll(installed, listed, destination);
    assert.equal(installed.target.harness, harness);
  }
  assert.equal(existsSync(path.join(home, ".understudy")), false);
  assert.deepEqual(readdirSync(application), []);
});

test("legacy named installation preserves exact files, metadata, and JSON shape outside the checkout", (t) => {
  const { scratch, home, application, run } = isolatedDistribution(t);
  const listed = success(run(["skills", "list", "--json"]));
  assertListedSkills(listed);
  const destination = path.join(scratch, "agent skills [literal]");
  for (const skill of listed.skills) {
    const args = ["skills", "install", skill.name, "--directory", destination, "--json"];
    const installed = success(run(args));
    assertInstalledSkill(installed, skill, destination);
    assert.equal("target" in installed, false, "legacy named JSON shape stays unchanged");
    assert.deepEqual(success(run(args)), { ...installed, status: "unchanged" });
  }
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(readdirSync(application), []);
});

test("a harness with a shared linked skill root installs all skills and reports their real location", (t) => {
  const { scratch, home, application, run } = isolatedDistribution(t);
  const destination = path.join(scratch, "shared agent skills");
  mkdirSync(destination);
  mkdirSync(path.join(home, ".claude"));
  const alias = path.join(home, ".claude", "skills");
  symlinkSync(destination, alias, process.platform === "win32" ? "junction" : "dir");
  const listed = success(run(["skills", "list", "--json"]));
  const installed = success(run(["skills", "install", "--harness", "claude", "--json"]));
  assertInstalledAll(installed, listed, destination);
  assert.equal(installed.target.harness, "claude");
  assert.equal(realpathSync(alias), destination);
  assert.equal(existsSync(path.join(home, ".understudy")), false);
  assert.deepEqual(readdirSync(application), []);
});

test("skill installation rejects invalid names and destination options before writing", (t) => {
  const { scratch, home, application, run } = isolatedDistribution(t);
  failure(run(["skills", "install", "setup-understudy", "--directory", "", "--json"]));
  failure(run(["skills", "install", "--harness", "unknown-synthetic-host", "--json"]));
  const destination = path.join(scratch, "unused destination");
  failure(run(["skills", "install", "", "--directory", destination, "--json"]));
  failure(run(["skills", "install", "--harness", "claude", "--directory", destination, "--json"]));
  failure(run(["skills", "install", "unbundled-synthetic-skill", "--directory", destination, "--json"]));
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(readdirSync(application), []);
});

test("skill installation refreshes managed files while preserving unrelated agent files", (t) => {
  const { scratch, run } = isolatedDistribution(t);
  const destination = path.join(scratch, "agent skills");
  const installed = success(run(["skills", "install", "setup-understudy", "--directory", destination, "--json"]));
  const customBytes = "# Synthetic local customization\n";
  writeFileSync(installed.entrypoint, customBytes);
  const unrelated = path.join(destination, "another-synthetic-skill", "SKILL.md");
  mkdirSync(path.dirname(unrelated));
  writeFileSync(unrelated, "# Unrelated synthetic skill\n");
  assert.deepEqual(success(run(["skills", "install", "setup-understudy", "--directory", destination, "--json"])), installed);
  assert.equal(readFileSync(installed.entrypoint, "utf8"), readFileSync(path.join(root, "skills", "setup-understudy", "SKILL.md"), "utf8"));
  assert.equal(readFileSync(unrelated, "utf8"), "# Unrelated synthetic skill\n");
});

test("skill refresh uses install without separate status or update commands", (t) => {
  const { run } = isolatedDistribution(t);
  for (const command of ["status", "update"]) failure(run(["skills", command, "--json"]));
});

test("skill installation refuses a linked target instead of writing through it", (t) => {
  const { scratch, run } = isolatedDistribution(t);
  const destination = path.join(scratch, "agent skills");
  const outside = path.join(scratch, "outside");
  mkdirSync(destination);
  mkdirSync(outside);
  symlinkSync(outside, path.join(destination, "setup-understudy"), process.platform === "win32" ? "junction" : "dir");
  failure(run(["skills", "install", "setup-understudy", "--directory", destination, "--json"]));
  assert.deepEqual(readdirSync(outside), []);
});
