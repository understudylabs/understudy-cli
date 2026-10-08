#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { scanCandidateFiles } from "./check-public.mjs";
import { writeSkillBundle } from "./bundle-skills.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDirectory = path.join(root, "artifacts");
const supportedBunVersion = "1.4.0";
const supportedBunRevision = "1.4.0+34cbb9a40";
const maximumBinarySize = 70_000_000;
const entitlementsPath = path.join(root, "scripts", "macos-entitlements.plist");

function parseArguments(argv) {
  let bunPath = process.execPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bun") {
      bunPath = argv[index + 1];
      if (!bunPath) throw new Error("--bun requires an executable path");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { bunPath: path.resolve(bunPath) };
}

function withoutBunOverrides(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.BUN_OPTIONS;
  delete sanitized.BUN_BE_BUN;
  return sanitized;
}

async function run(executable, arguments_, options = {}) {
  return execFileAsync(executable, arguments_, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function readManifest() {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("package.json must contain a releasable semantic version");
  }

  const cliSource = await readFile(path.join(root, "src", "cli.ts"), "utf8");
  if (!cliSource.includes(`packageVersion = "${manifest.version}"`)) {
    throw new Error("The CLI and package versions must match before release");
  }
  return manifest;
}

async function assertBunToolchain(bunPath) {
  const environment = withoutBunOverrides();
  const [{ stdout: version }, { stdout: revision }] = await Promise.all([
    run(bunPath, ["--version"], { env: environment }),
    run(bunPath, ["--revision"], { env: environment }),
  ]);
  if (version.trim() !== supportedBunVersion) {
    throw new Error(
      `Binary builds require Bun ${supportedBunVersion}; received ${version.trim()}`,
    );
  }
  if (revision.trim() !== supportedBunRevision) {
    throw new Error(
      `Binary builds require Bun revision ${supportedBunRevision}; received ${revision.trim()}`,
    );
  }
}

function assertHost() {
  if (platform() !== "darwin" || arch() !== "arm64") {
    throw new Error("The first binary release supports darwin-arm64 only");
  }
}

function dependencyNames(inputs) {
  const names = new Set();
  for (const input of Object.keys(inputs)) {
    const marker = "node_modules/";
    const offset = input.lastIndexOf(marker);
    if (offset === -1) continue;
    const segments = input.slice(offset + marker.length).split("/");
    names.add(
      segments[0].startsWith("@")
        ? `${segments[0]}/${segments[1]}`
        : segments[0],
    );
  }
  return [...names].sort();
}

async function assertBundleContract(metafile, workDirectory) {
  const outputs = Object.values(metafile.outputs);
  if (outputs.length !== 1) {
    throw new Error("Bun did not produce exactly one review bundle");
  }
  if (outputs[0].imports.length !== 0) {
    throw new Error("The release bundle contains unresolved imports");
  }

  const dependencies = dependencyNames(metafile.inputs);
  if (dependencies.join(",") !== "ajv,ajv-formats,commander,fast-deep-equal,fast-uri,json-schema-traverse,zod") {
    throw new Error(
      `Release bundle dependencies changed; review notices for: ${dependencies.join(",")}`,
    );
  }

  const allowedRoots = await Promise.all(
    [
      path.join(root, "src"),
      ...dependencies.map(name => path.join(root, "node_modules", name)),
    ].map(async (directory) => `${await realpath(directory)}${path.sep}`),
  );
  for (const input of Object.keys(metafile.inputs)) {
    const absoluteInput = await realpath(path.resolve(workDirectory, input));
    if (!allowedRoots.some((allowedRoot) => absoluteInput.startsWith(allowedRoot))) {
      throw new Error(`Release bundle contains an unexpected input: ${input}`);
    }
  }
}

async function createNotices() {
  const notices = [
    ["Understudy CLI", path.join(root, "LICENSE")],
    ["Reused Understudy Labs components", path.join(root, "NOTICES.txt")],
    [
      `Bun ${supportedBunVersion}`,
      path.join(root, "scripts", "licenses", "BUN-LICENSE.md"),
    ],
    ["Commander", path.join(root, "node_modules", "commander", "LICENSE")],
    ["Zod", path.join(root, "node_modules", "zod", "LICENSE")],
    ...["ajv", "ajv-formats", "fast-deep-equal", "fast-uri", "json-schema-traverse"].map(name => [name, path.join(root, "node_modules", name, "LICENSE")]),
  ];

  const sections = [];
  for (const [name, licensePath] of notices) {
    sections.push(
      `${name}\n${"=".repeat(name.length)}\n\n${await readFile(licensePath, "utf8")}`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function assertMaximumSize(filePath, maximum, label) {
  const entry = await stat(filePath);
  if (entry.size > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes: ${entry.size}`);
  }
  return entry.size;
}

function compileArguments({ bunPath, entrypoint, outfile, metafile }) {
  return [
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    `--compile-executable-path=${bunPath}`,
    `--outfile=${outfile}`,
    ...(metafile ? [`--metafile=${metafile}`] : []),
    "--minify",
    "--sourcemap=none",
    "--env=disable",
    "--reject-unresolved",
    "--packages=bundle",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    entrypoint,
  ];
}

async function assertRuntimeAutoloadDisabled(bunPath, workDirectory) {
  const probeDirectory = path.join(workDirectory, "runtime-autoload-probe");
  const probeEntrypoint = path.join(probeDirectory, "probe.ts");
  const probeBinary = path.join(probeDirectory, "probe");
  const preloadSentinel = path.join(probeDirectory, "preload-ran.txt");
  await mkdir(probeDirectory);
  await writeFile(
    probeEntrypoint,
    [
      'process.stdout.write(process.env.UNDERSTUDY_RUNTIME_PROBE ?? "unset");',
      "",
    ].join("\n"),
    "utf8",
  );
  await run(
    bunPath,
    compileArguments({
      bunPath,
      entrypoint: probeEntrypoint,
      outfile: probeBinary,
    }),
    { cwd: workDirectory, env: withoutBunOverrides() },
  );
  await writeFile(
    path.join(probeDirectory, ".env"),
    "UNDERSTUDY_RUNTIME_PROBE=loaded\n",
    "utf8",
  );
  await writeFile(
    path.join(probeDirectory, "bunfig.toml"),
    'preload = ["./preload.mjs"]\n',
    "utf8",
  );
  await writeFile(
    path.join(probeDirectory, "preload.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(preloadSentinel)}, "executed\\n");`,
      "",
    ].join("\n"),
    "utf8",
  );

  const probeEnvironment = withoutBunOverrides();
  delete probeEnvironment.UNDERSTUDY_RUNTIME_PROBE;
  const { stdout } = await run(probeBinary, [], {
    cwd: probeDirectory,
    env: probeEnvironment,
  });
  if (stdout !== "unset") {
    throw new Error("Bun standalone runtime loaded the hostile .env fixture");
  }
  try {
    await access(preloadSentinel);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Bun standalone runtime executed the hostile bunfig preload");
}

async function main() {
  await rm(artifactsDirectory, { recursive: true, force: true });
  assertHost();
  const { bunPath } = parseArguments(process.argv.slice(2));
  await assertBunToolchain(bunPath);
  const manifest = await readManifest();
  await writeSkillBundle(root);
  const target = "darwin-arm64";
  const artifactName = `understudy-${target}`;
  const workDirectory = await mkdtemp(
    path.join(tmpdir(), "understudy-cli-release-"),
  );
  const environment = withoutBunOverrides();

  try {
    const entrypoint = path.join(root, "src", "bin.ts");
    const bundlePath = path.join(workDirectory, "understudy.bundle.js");
    const metafilePath = path.join(workDirectory, "understudy.meta.json");
    await run(
      bunPath,
      [
        "build",
        entrypoint,
        "--target=bun",
        `--outfile=${bundlePath}`,
        `--metafile=${metafilePath}`,
        "--format=esm",
        "--minify",
        "--sourcemap=none",
        "--env=disable",
        "--reject-unresolved",
        "--packages=bundle",
      ],
      { cwd: workDirectory, env: environment },
    );
    const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
    await assertBundleContract(metafile, workDirectory);

    const bundleViolations = await scanCandidateFiles(workDirectory, [
      path.basename(bundlePath),
    ]);
    if (bundleViolations.length > 0) {
      throw new Error(
        `Release bundle boundary failed:\n${bundleViolations.join("\n")}`,
      );
    }

    const binaryPath = path.join(workDirectory, "understudy");
    const compileMetafilePath = path.join(
      workDirectory,
      "understudy.compile-meta.json",
    );
    await run(
      bunPath,
      compileArguments({
        bunPath,
        entrypoint,
        outfile: binaryPath,
        metafile: compileMetafilePath,
      }),
      { cwd: workDirectory, env: environment },
    );
    const compileMetafile = JSON.parse(
      await readFile(compileMetafilePath, "utf8"),
    );
    await assertBundleContract(compileMetafile, workDirectory);
    const reviewedInputs = Object.keys(metafile.inputs).sort();
    const compiledInputs = Object.keys(compileMetafile.inputs).sort();
    if (JSON.stringify(reviewedInputs) !== JSON.stringify(compiledInputs)) {
      throw new Error("The reviewed and compiled release dependency graphs differ");
    }
    await assertRuntimeAutoloadDisabled(bunPath, workDirectory);
    await chmod(binaryPath, 0o755);
    await run("codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "com.understudylabs.understudy",
      "--options",
      "runtime",
      "--entitlements",
      entitlementsPath,
      "--timestamp=none",
      binaryPath,
    ]);
    await run("codesign", ["--verify", "--strict", "--verbose=2", binaryPath]);
    const binarySize = await assertMaximumSize(
      binaryPath,
      maximumBinarySize,
      "Standalone binary",
    );

    await mkdir(artifactsDirectory, { recursive: true });
    const artifactPath = path.join(artifactsDirectory, artifactName);
    await copyFile(binaryPath, artifactPath);
    await chmod(artifactPath, 0o755);
    const installerMarker = "__UNDERSTUDY_RELEASE_TAG__";
    const teamIdMarker = "__UNDERSTUDY_DEVELOPER_TEAM_ID__";
    const installerTemplate = await readFile(
      path.join(root, "install.sh"),
      "utf8",
    );
    if (installerTemplate.split(installerMarker).length !== 2) {
      throw new Error("The installer must contain exactly one release tag marker");
    }
    if (installerTemplate.split(teamIdMarker).length !== 2) {
      throw new Error("The installer must contain exactly one signing team marker");
    }
    await writeFile(
      path.join(artifactsDirectory, "install.sh"),
      installerTemplate.replace(installerMarker, `v${manifest.version}`),
      "utf8",
    );
    await chmod(path.join(artifactsDirectory, "install.sh"), 0o755);

    const binaryDigest = await sha256(binaryPath);
    await writeFile(
      path.join(artifactsDirectory, "SHA256SUMS"),
      `${binaryDigest}  ${artifactName}\n`,
      "utf8",
    );
    await writeFile(
      path.join(artifactsDirectory, "THIRD_PARTY_NOTICES.txt"),
      await createNotices(),
      "utf8",
    );
    await writeFile(
      path.join(artifactsDirectory, "latest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: manifest.version,
          target,
          artifact: artifactName,
          sha256: binaryDigest,
          size: binarySize,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const releaseViolations = await scanCandidateFiles(artifactsDirectory, [
      "SHA256SUMS",
      "THIRD_PARTY_NOTICES.txt",
      "install.sh",
      "latest.json",
    ]);
    if (releaseViolations.length > 0) {
      throw new Error(
        `Release artifact boundary failed:\n${releaseViolations.join("\n")}`,
      );
    }

    process.stdout.write(
      `Built ${artifactName} (${binarySize} bytes, sha256 ${binaryDigest})\n`,
    );
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `Binary build failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
