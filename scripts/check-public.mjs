#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const sensitivePathPatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.understudy(?:\/|$)/i,
  /\.(?:key|log|pem|tgz)$/i,
];

const universalContentPatterns = [
  {
    label: "absolute private filesystem path",
    pattern: /(?:^|[=\s"'`(])\/(?:Users|home)\/[^/\s]+\//gm,
  },
  {
    label: "absolute private filesystem path",
    pattern: /\b[A-Za-z]:\\Users\\[^\\\s]+\\/gm,
  },
  {
    label: "secret-shaped value",
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
  },
  {
    label: "secret-shaped value",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    label: "secret-shaped value",
    pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: "private key material",
    pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/g,
  },
  {
    label: "secret-bearing URL",
    pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/g,
  },
  {
    label: "secret-bearing URL",
    pattern:
      /https?:\/\/[^\s"'`]*[?&#][^\s"'`]*(?:api[_-]?key|authorization|cookie|password|secret|token)=[^&\s"'`]{8,}/gi,
  },
  {
    label: "assigned credential value",
    pattern:
      /\b(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  },
  {
    label: "private repository transport",
    pattern: /\b(?:g[i]t@|ssh:\/\/g[i]t@)[^\s]+/g,
  },
];

function normalizeRelativePath(file) {
  return file.split(path.sep).join("/").replace(/^\.\//, "");
}

function isSensitivePath(file) {
  return sensitivePathPatterns.some((pattern) => pattern.test(file));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scanText(file, text) {
  const violations = [];

  for (const { label, pattern } of universalContentPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      violations.push(`${file}:${lineNumberAt(text, match.index ?? 0)}: ${label}`);
    }
  }

  return violations;
}

export async function scanCandidateFiles(root, files) {
  const canonicalRoot = path.resolve(root);
  const violations = [];

  for (const candidate of files) {
    const file = normalizeRelativePath(candidate);
    if (isSensitivePath(file)) {
      violations.push(`${file}: sensitive file is not allowed`);
      continue;
    }

    const absoluteFile = path.resolve(canonicalRoot, file);
    if (
      absoluteFile !== canonicalRoot &&
      !absoluteFile.startsWith(`${canonicalRoot}${path.sep}`)
    ) {
      violations.push(`${file}: candidate escapes the repository root`);
      continue;
    }

    const entry = await lstat(absoluteFile);
    if (entry.isSymbolicLink()) {
      violations.push(`${file}: symbolic link is not allowed`);
      continue;
    }
    if (!entry.isFile()) {
      violations.push(`${file}: candidate is not a regular file`);
      continue;
    }

    const content = await readFile(absoluteFile);
    if (content.includes(0)) {
      violations.push(`${file}: unreviewed binary content`);
      continue;
    }

    violations.push(...scanText(file, content.toString("utf8")));
  }

  return violations;
}

async function listRepositoryCandidates(root) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.split("\0").filter(Boolean).map(normalizeRelativePath);
}

async function listIgnoredSensitiveFiles(root) {
  const violations = [];

  async function walk(directory, relativeDirectory = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = normalizeRelativePath(
        path.join(relativeDirectory, entry.name),
      );

      if ([".git", "coverage", "dist", "node_modules"].includes(entry.name)) {
        continue;
      }

      if (isSensitivePath(relativePath)) {
        violations.push(`${relativePath}: sensitive ignored path is present`);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relativePath);
      }
    }
  }

  await walk(root);
  return violations;
}

async function listPackageFiles(root) {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json"],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) {
    throw new Error("npm pack returned an unexpected manifest");
  }
  return result[0].files.map(({ path: file }) => normalizeRelativePath(file));
}

export async function listExpectedPackageFiles(root) {
  const expected = ["LICENSE", "NOTICES.txt", "README.md", "package.json"];

  async function walk(directory, relativeDirectory = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = normalizeRelativePath(
        path.join(relativeDirectory, entry.name),
      );
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        expected.push(`dist/${relativePath.replace(/\.ts$/, ".js")}`);
      }
    }
  }

  await walk(path.join(root, "src"));
  return expected.sort();
}

export function findPackageFileViolations(packageFiles, expectedPackageFiles) {
  const violations = [];

  for (const file of packageFiles) {
    if (!expectedPackageFiles.includes(file)) {
      violations.push(`${file}: unintended package entry`);
    }
  }
  for (const file of expectedPackageFiles) {
    if (!packageFiles.includes(file)) {
      violations.push(`${file}: expected package entry is missing`);
    }
  }

  return violations;
}

async function checkPackageContract(root) {
  const violations = [];
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  if (manifest.private !== true) {
    violations.push("package.json: package must remain private");
  }
  for (const field of ["bugs", "homepage", "publishConfig", "repository"]) {
    if (field in manifest) {
      violations.push(`package.json: ${field} is not allowed before publication review`);
    }
  }

  return violations;
}

export async function checkPublicBoundary(root) {
  const canonicalRoot = path.resolve(root);
  const violations = [];
  const candidates = await listRepositoryCandidates(canonicalRoot);
  violations.push(...(await scanCandidateFiles(canonicalRoot, candidates)));
  violations.push(...(await listIgnoredSensitiveFiles(canonicalRoot)));
  violations.push(...(await checkPackageContract(canonicalRoot)));

  const packageFiles = (await listPackageFiles(canonicalRoot)).sort();
  const expectedPackageFiles = await listExpectedPackageFiles(canonicalRoot);
  violations.push(...findPackageFileViolations(packageFiles, expectedPackageFiles));
  violations.push(...(await scanCandidateFiles(canonicalRoot, packageFiles)));

  return { packageFiles, violations };
}

async function main() {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const { packageFiles, violations } = await checkPublicBoundary(root);

  if (violations.length > 0) {
    process.stderr.write(
      `Public boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Public boundary check passed (${packageFiles.length} package files).\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
