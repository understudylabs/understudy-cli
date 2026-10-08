import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const checkerUrl = new URL("../scripts/check-public.mjs", import.meta.url);

test("a synthetic absolute private path fails the candidate scan", async () => {
  const { scanCandidateFiles } = await import(checkerUrl);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "understudy-boundary-"));

  try {
    const candidate = "candidate.txt";
    const syntheticPrivatePath = [
      "",
      "Users",
      "example-person",
      "private-checkout",
      "source.ts",
    ].join(path.sep);
    await writeFile(path.join(fixtureRoot, candidate), syntheticPrivatePath);

    const violations = await scanCandidateFiles(fixtureRoot, [candidate]);

    assert.ok(
      violations.some((violation) =>
        violation.includes("absolute private filesystem path"),
      ),
      violations.join("\n"),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("an assigned synthetic home path fails the candidate scan", async () => {
  const { scanCandidateFiles } = await import(checkerUrl);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "understudy-boundary-"));

  try {
    const candidate = "candidate.txt";
    const syntheticHomePath = [
      "",
      "home",
      "example-person",
      "private-checkout",
      "source.ts",
    ].join(path.sep);
    await writeFile(
      path.join(fixtureRoot, candidate),
      ["ROOT", syntheticHomePath].join("="),
    );

    const violations = await scanCandidateFiles(fixtureRoot, [candidate]);

    assert.ok(
      violations.some((violation) =>
        violation.includes("absolute private filesystem path"),
      ),
      violations.join("\n"),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a synthetic query credential fails the candidate scan", async () => {
  const { scanCandidateFiles } = await import(checkerUrl);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "understudy-boundary-"));

  try {
    const candidate = "candidate.txt";
    const syntheticSecret = ["synthetic", "secret", "value"].join("-");
    const secretUrl = [
      "https:",
      "//example.com/callback",
      "?",
      "token",
      "=",
      syntheticSecret,
    ].join("");
    await writeFile(path.join(fixtureRoot, candidate), secretUrl);

    const violations = await scanCandidateFiles(fixtureRoot, [candidate]);

    assert.ok(
      violations.some((violation) => violation.includes("secret-bearing URL")),
      violations.join("\n"),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a synthetic credential assignment in documentation fails", async () => {
  const { scanCandidateFiles } = await import(checkerUrl);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "understudy-boundary-"));

  try {
    const candidate = "docs/example.md";
    const syntheticSecret = ["synthetic", "secret", "value"].join("-");
    await mkdir(path.join(fixtureRoot, "docs"));
    await writeFile(
      path.join(fixtureRoot, candidate),
      ["token", " = ", `"${syntheticSecret}"`].join(""),
    );

    const violations = await scanCandidateFiles(fixtureRoot, [candidate]);

    assert.ok(
      violations.some((violation) => violation.includes("assigned credential value")),
      violations.join("\n"),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a symbolic-link candidate fails before its target is read", async () => {
  const { scanCandidateFiles } = await import(checkerUrl);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "understudy-boundary-"));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const outsideFile = path.join(fixtureRoot, "outside.txt");

  try {
    await mkdir(repositoryRoot);
    await writeFile(outsideFile, "synthetic external content");
    await symlink(outsideFile, path.join(repositoryRoot, "candidate.txt"));

    const violations = await scanCandidateFiles(repositoryRoot, ["candidate.txt"]);

    assert.ok(
      violations.some((violation) => violation.includes("symbolic link")),
      violations.join("\n"),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("the package manifest rejects unexpected and missing files", async () => {
  const { findPackageFileViolations } = await import(checkerUrl);
  const violations = findPackageFileViolations(
    ["dist/bin.js", "extra.txt", "package.json"],
    ["dist/bin.js", "dist/cli.js", "package.json"],
  );

  assert.deepEqual(violations, [
    "extra.txt: unintended package entry",
    "dist/cli.js: expected package entry is missing",
  ]);
});

test("declaration sources do not require JavaScript package output", async () => {
  const { listExpectedPackageFiles } = await import(checkerUrl);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "understudy-boundary-"));

  try {
    await mkdir(path.join(fixtureRoot, "src"));
    await writeFile(path.join(fixtureRoot, "src", "runtime.ts"), "export {};\n");
    await writeFile(
      path.join(fixtureRoot, "src", "runtime.d.ts"),
      "export interface Runtime {}\n",
    );

    const expected = await listExpectedPackageFiles(fixtureRoot);

    assert.deepEqual(expected, ["LICENSE", "NOTICES.txt", "README.md", "dist/runtime.js", "package.json"]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
