import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MigrationStorage } from "../dist/migrations/storage.js";

// Every project and artifact here is wholly invented test material.
async function project(t, useGit = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "synthetic-project-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (useGit) git(directory, ["init", "--quiet"]);
  return directory;
}
function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) });
}

test("subdirectories share project state with an effective idempotent ignore rule", async t => {
  const directory = await project(t), nested = path.join(directory, "src", "nested");
  await mkdir(nested, { recursive: true });
  const original = "# Synthetic existing rule\n*.tmp\n!/.understudy/";
  await writeFile(path.join(directory, ".gitignore"), original);
  const storage = new MigrationStorage(nested), file = path.join(storage.runPath("synthetic-run"), "viewer", "index.html");
  assert.equal(storage.root, path.join(directory, ".understudy"));
  await storage.write(file, "Synthetic viewer");
  const ignored = await readFile(path.join(directory, ".gitignore"), "utf8");
  assert.equal(ignored, `${original}\n/.understudy/\n`);
  assert.equal(git(directory, ["check-ignore", "--", path.relative(directory, file)]).trim(), path.relative(directory, file));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(storage.root)).mode & 0o777, 0o700);
  await new MigrationStorage(directory).write(file, "Synthetic updated viewer");
  assert.equal(await readFile(path.join(directory, ".gitignore"), "utf8"), ignored);
  assert.doesNotMatch(git(directory, ["status", "--porcelain", "--untracked-files=all"]), /index.html/);
});

test("already tracked state stops before a new artifact or ignore rule is written", async t => {
  const directory = await project(t), storage = new MigrationStorage(directory);
  await mkdir(storage.root, { mode: 0o700 });
  await writeFile(path.join(storage.root, "synthetic.txt"), "Synthetic tracked file", { mode: 0o600 });
  git(directory, ["add", "--", ".understudy/synthetic.txt"]);
  const output = path.join(storage.runPath("synthetic-run"), "report.md");
  await assert.rejects(() => storage.write(output, "Synthetic report"), /already tracked/);
  await assert.rejects(() => stat(output), { code: "ENOENT" });
  await assert.rejects(() => stat(path.join(directory, ".gitignore")), { code: "ENOENT" });
});

test("linked Git worktrees each own their state and protect it from tracking", async t => {
  const directory = await project(t), worktree = path.join(directory, "synthetic-worktree");
  git(directory, ["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Synthetic test"]);
  git(directory, ["worktree", "add", "--quiet", "--detach", worktree]);
  const storage = new MigrationStorage(worktree), file = path.join(storage.runPath("synthetic-run"), "result.json");
  await storage.write(file, "{}");
  assert.equal(storage.root, path.join(worktree, ".understudy"));
  assert.equal((await stat(path.join(worktree, ".git"))).isFile(), true);
  assert.equal(git(worktree, ["check-ignore", "--", ".understudy/result.json"]).trim(), ".understudy/result.json");
  await assert.rejects(() => stat(path.join(directory, ".understudy")), { code: "ENOENT" });
});

test("non-Git projects reuse their state without adopting the global home store", async t => {
  const home = await project(t, false), directory = path.join(home, "application"), nested = path.join(directory, "src");
  await mkdir(path.join(home, ".understudy"), { mode: 0o700 });
  await mkdir(nested, { recursive: true });
  const oldHome = process.env.HOME; process.env.HOME = home;
  try {
    const storage = new MigrationStorage(directory);
    assert.equal(storage.root, path.join(directory, ".understudy"));
    await storage.write(path.join(storage.runPath("synthetic-run"), "result.json"), "{}");
    assert.equal(new MigrationStorage(nested).root, storage.root);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});

test("symlinked state and ignore files cannot redirect private writes", async t => {
  const directory = await project(t), outside = await project(t, false);
  const storage = new MigrationStorage(directory), output = path.join(storage.runPath("synthetic-run"), "result.json");
  await symlink(outside, storage.root);
  await assert.rejects(() => storage.write(output, "{}"), /symlinks/);
  await assert.rejects(() => stat(path.join(outside, "migrations")), { code: "ENOENT" });
  await rm(storage.root); await rm(path.join(directory, ".gitignore"), { force: true });
  const target = path.join(outside, "synthetic-ignore"); await writeFile(target, "Synthetic untouched content");
  await symlink(target, path.join(directory, ".gitignore"));
  await assert.rejects(() => new MigrationStorage(directory).write(output, "{}"));
  assert.equal(await readFile(target, "utf8"), "Synthetic untouched content");
});

test("a reused service rechecks Git tracking at the next locked operation", async t => {
  const directory = await project(t), storage = new MigrationStorage(directory), file = path.join(storage.runPath("synthetic-run"), "result.json");
  await storage.locked("synthetic-run", () => storage.write(file, "{}"));
  git(directory, ["add", "--force", "--", ".understudy"]);
  await assert.rejects(() => storage.locked("synthetic-run", () => storage.write(file, "changed")), /already tracked/);
  assert.equal(await readFile(file, "utf8"), "{}");
});
