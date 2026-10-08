#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const maximumBinarySize = 70_000_000;
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = path.join(root, "artifacts");
const manifest = JSON.parse(
  readFileSync(path.join(artifacts, "latest.json"), "utf8"),
);
const packageVersion = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;

assert.deepEqual(Object.keys(manifest).sort(), [
  "artifact",
  "schemaVersion",
  "sha256",
  "size",
  "target",
  "version",
]);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, packageVersion);
assert.equal(manifest.target, "darwin-arm64");
assert.equal(manifest.artifact, "understudy-darwin-arm64");
assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
assert.equal(Number.isSafeInteger(manifest.size), true);
assert.ok(manifest.size > 0);
assert.ok(
  manifest.size <= maximumBinarySize,
  `standalone binary exceeds ${maximumBinarySize} bytes: ${manifest.size}`,
);

assert.deepEqual(readdirSync(artifacts).sort(), [
  "SHA256SUMS",
  "THIRD_PARTY_NOTICES.txt",
  "install.sh",
  "latest.json",
  "understudy-darwin-arm64",
]);
const binary = path.join(artifacts, manifest.artifact);
const installer = path.join(artifacts, "install.sh");
const sourceChecksum = path.join(artifacts, "SHA256SUMS");
const installerText = readFileSync(installer, "utf8");
assert.equal(installerText.includes("__UNDERSTUDY_RELEASE_TAG__"), false);
assert.match(installerText, new RegExp(`release_tag="v${packageVersion}"`));
assert.match(
  installerText,
  /repository="github\.com\/understudylabs\/understudy-cli-releases"/,
);
assert.equal(
  installerText.split("__UNDERSTUDY_DEVELOPER_TEAM_ID__").length,
  2,
);
assert.match(installerText, /^\s*curl_bin=\/usr\/bin\/curl$/m);
assert.doesNotMatch(installerText, /UNDERSTUDY_RELEASE_DIR/);
assert.doesNotMatch(installerText, /\bgh (?:auth|release)\b|GITHUB_TOKEN/);
assert.equal(statSync(binary).size, manifest.size);
const binaryDigest = digest(binary);
assert.equal(binaryDigest, manifest.sha256);
assert.equal(
  readFileSync(sourceChecksum, "utf8"),
  `${binaryDigest}  ${manifest.artifact}\n`,
);

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "understudy-binary-test-")));
const isolatedHome = path.join(scratch, "home");
const installDirectory = path.join(scratch, "install * [literal]");
const remoteInstallDirectory = path.join(scratch, "remote install");
const failedRemoteInstallDirectory = path.join(scratch, "failed remote install");
const binaryBytes = readFileSync(binary);
const checksumBytes = readFileSync(sourceChecksum);

try {
  const binaryEntry = statSync(binary);
  assert.ok(
    binaryEntry.size <= maximumBinarySize,
    `standalone binary exceeds ${maximumBinarySize} bytes: ${binaryEntry.size}`,
  );
  assert.notEqual(binaryEntry.mode & 0o111, 0);
  assert.notEqual(statSync(installer).mode & 0o111, 0);
  assert.equal(
    readFileSync(sourceChecksum, "utf8"),
    `${digest(binary)}  understudy-darwin-arm64\n`,
  );

  const fileDescription = execFileSync("file", [binary], { encoding: "utf8" });
  assert.match(fileDescription, /Mach-O 64-bit executable arm64/);
  const buildVersion = execFileSync("xcrun", ["vtool", "-show-build", binary], {
    encoding: "utf8",
  });
  assert.match(buildVersion, /^ platform MACOS$/m);
  assert.match(buildVersion, /^    minos 13\.0$/m);
  execFileSync("codesign", ["--verify", "--strict", binary]);

  for (const privatePath of new Set([root, tmpdir(), process.env.HOME])) {
    if (privatePath && privatePath !== "/") {
      assert.equal(
        binaryBytes.includes(Buffer.from(privatePath)),
        false,
        `standalone binary contains private build path: ${privatePath}`,
      );
    }
  }

  mkdirSync(isolatedHome);
  chmodSync(isolatedHome, 0o700);
  const executionEnvironment = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    PATH: "/usr/bin:/bin",
    TMPDIR: tmpdir(),
  };
  assert.equal("BUN_OPTIONS" in executionEnvironment, false);
  assert.equal("BUN_BE_BUN" in executionEnvironment, false);
  for (const runtime of ["node", "bun"]) {
    const lookup = spawnSync(runtime, ["--version"], {
      encoding: "utf8",
      cwd: isolatedHome,
      env: executionEnvironment,
    });
    assert.equal(
      lookup.error?.code,
      "ENOENT",
      `${runtime} unexpectedly resolved through the standalone test PATH`,
    );
  }

  assertExecution(
    binary,
    ["--version"],
    `${packageVersion}\n`,
    executionEnvironment,
  );
  assertExecution(
    binary,
    ["--json", "--version"],
    `${packageVersion}\n`,
    executionEnvironment,
  );
  assert.match(
    assertExecution(binary, ["--help"], undefined, executionEnvironment),
    /^Usage: understudy/m,
  );
  assertBundledSkills(binary, executionEnvironment, scratch);
  assert.deepEqual(
    JSON.parse(
      assertExecution(
        binary,
        ["--json", "auth", "status"],
        undefined,
        executionEnvironment,
      ),
    ),
    { authenticated: false, method: null, verification: "local", pending: false, expiresAt: null },
  );
  // Synthetic codes with no pending claim: prove argument parsing works without
  // a TTY and fails locally before any authentication request can be sent.
  for (const [code, message] of [["001234", /No email sign-in is pending/], ["12345", /six digits/]]) {
    const completion = run(binary, ["login", "--code", code, "--json"], {
      env: executionEnvironment, cwd: isolatedHome,
    });
    assert.equal(completion.status, 1);
    assert.equal(completion.stdout, "");
    assert.match(JSON.parse(completion.stderr).error.message, message);
    assert.equal(completion.stderr.includes(code), false);
  }
  const invalid = run(binary, ["--json", "report", "--window", "invalid"], {
    env: executionEnvironment,
    cwd: isolatedHome,
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.deepEqual(JSON.parse(invalid.stderr), {
    ok: false,
    error: {
      type: "cli_error",
      message: "Invalid window. Use 24h, 7d, or 30d.",
    },
  });

  const hostileDirectory = path.join(scratch, "hostile runtime config");
  const preloadSentinel = path.join(scratch, "preload-ran.txt");
  mkdirSync(hostileDirectory);
  writeFileSync(
    path.join(hostileDirectory, ".env"),
    [
      "UNDERSTUDY_SYNTHETIC_DOTENV=loaded",
      "BUN_OPTIONS=--version",
      "BUN_BE_BUN=1",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(hostileDirectory, "bunfig.toml"),
    'preload = ["./hostile-preload.mjs"]\n',
  );
  writeFileSync(
    path.join(hostileDirectory, "hostile-preload.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(preloadSentinel)}, "executed\\n");`,
      "",
    ].join("\n"),
  );
  const configProbeEnvironment = { ...executionEnvironment };
  delete configProbeEnvironment.BUN_OPTIONS;
  delete configProbeEnvironment.BUN_BE_BUN;
  assertExecution(
    binary,
    ["--version"],
    `${packageVersion}\n`,
    configProbeEnvironment,
    hostileDirectory,
  );
  assert.equal(existsSync(preloadSentinel), false);

  await assertCompiledOAuthLoopback(
    binary,
    executionEnvironment,
    path.join(scratch, "oauth probe"),
  );

  const stateDirectory = path.join(isolatedHome, ".understudy");
  const stateSentinel = path.join(stateDirectory, "release-test.json");
  const oauthSession = path.join(stateDirectory, "oauth-session.json");
  mkdirSync(stateDirectory, { mode: 0o700 });
  writeFileSync(stateSentinel, '{"synthetic":true}\n', { mode: 0o600 });
  writeFileSync(
    oauthSession,
    `${JSON.stringify({
      version: 1,
      method: "oauth",
      accessToken: ["synthetic", "access", "token"].join("."),
    })}\n`,
    { mode: 0o600 },
  );

  const fakeCurlDirectory = path.join(scratch, "anonymous-downloads");
  const fakeCurl = path.join(fakeCurlDirectory, "curl");
  const networkInstaller = path.join(fakeCurlDirectory, "install.sh");
  const fakeCurlLog = path.join(scratch, "curl-arguments.txt");
  mkdirSync(fakeCurlDirectory);
  writeFileSync(
    fakeCurl,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$UNDERSTUDY_FAKE_CURL_LOG"',
      'output=""',
      'url=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --output|--proto|--retry)',
      '      [ "$#" -ge 2 ] || exit 64',
      '      [ "$1" != "--output" ] || output="$2"',
      '      shift 2',
      '      ;;',
      '    --fail|--location|--silent|--show-error)',
      '      shift',
      '      ;;',
      '    --*)',
      '      exit 64',
      '      ;;',
      '    *)',
      '      [ -z "$url" ] || exit 64',
      '      url="$1"',
      '      shift',
      '      ;;',
      '  esac',
      'done',
      '[ -n "$output" ] || exit 64',
      '[ -n "$url" ] || exit 64',
      'latest_url="https://github.com/understudylabs/understudy-cli-releases/releases/latest/download/install.sh"',
      'release_url="https://github.com/understudylabs/understudy-cli-releases/releases/download/v${UNDERSTUDY_FAKE_RELEASE_VERSION}"',
      'case "$url" in',
      '  "$latest_url")',
      '    [ "${UNDERSTUDY_FAKE_CURL_FAIL_INSTALLER:-}" != "1" ] || exit 42',
      '    source="$UNDERSTUDY_FAKE_INSTALLER"',
      '    ;;',
      '  "$release_url/understudy-darwin-arm64")',
      '    source="$UNDERSTUDY_FAKE_RELEASE_DIR/understudy-darwin-arm64"',
      '    ;;',
      '  "$release_url/SHA256SUMS")',
      '    source="$UNDERSTUDY_FAKE_RELEASE_DIR/SHA256SUMS"',
      '    ;;',
      '  *)',
      '    exit 65',
      '    ;;',
      'esac',
      '[ ! -e "$output" ] || exit 73',
      '/bin/cp "$source" "$output"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const networkInstallerText = installerText.replace(
    "curl_bin=/usr/bin/curl",
    `curl_bin=${fakeCurl}`,
  );
  assert.notEqual(networkInstallerText, installerText);
  writeFileSync(networkInstaller, networkInstallerText, { mode: 0o755 });
  const publicBootstrap = [
    "(",
    "  set -eu",
    '  temporary_directory=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/understudy-installer.XXXXXX")',
    '  installer="$temporary_directory/install.sh"',
    "  cleanup() {",
    '    /bin/rm -f "$installer"',
    '    /bin/rmdir "$temporary_directory" 2>/dev/null || :',
    "  }",
    "  trap cleanup EXIT HUP INT TERM",
    "  curl \\",
    "    --fail \\",
    "    --location \\",
    "    --silent \\",
    "    --show-error \\",
    "    --proto '=https' \\",
    "    --retry 3 \\",
    '    --output "$installer" \\',
    "    https://github.com/understudylabs/understudy-cli-releases/releases/latest/download/install.sh",
    '  /bin/sh "$installer"',
    ")",
    "",
  ].join("\n");
  const remoteEnvironment = {
    ...executionEnvironment,
    PATH: `${fakeCurlDirectory}:/usr/bin:/bin`,
    TMPDIR: scratch,
    UNDERSTUDY_FAKE_CURL_LOG: fakeCurlLog,
    UNDERSTUDY_FAKE_RELEASE_VERSION: packageVersion,
    UNDERSTUDY_FAKE_RELEASE_DIR: artifacts,
    UNDERSTUDY_FAKE_INSTALLER: networkInstaller,
    UNDERSTUDY_INSTALLER_TEST_TEAM_ID: "not set",
    UNDERSTUDY_INSTALL_DIR: remoteInstallDirectory,
  };
  const remoteInstall = run("/bin/sh", ["-c", publicBootstrap], {
    env: remoteEnvironment,
    cwd: isolatedHome,
  });
  assert.equal(remoteInstall.status, 0, remoteInstall.stderr);
  assert.equal(
    digest(path.join(remoteInstallDirectory, "understudy")),
    digest(binary),
  );
  const fakeCurlArguments = readFileSync(fakeCurlLog, "utf8")
    .trim()
    .split("\n");
  const releaseUrl = `https://github.com/understudylabs/understudy-cli-releases/releases/download/v${packageVersion}`;
  assert.deepEqual(
    fakeCurlArguments.map((arguments_) => arguments_.split(" ").at(-1)),
    [
      "https://github.com/understudylabs/understudy-cli-releases/releases/latest/download/install.sh",
      `${releaseUrl}/understudy-darwin-arm64`,
      `${releaseUrl}/SHA256SUMS`,
    ],
  );
  for (const arguments_ of fakeCurlArguments) {
    assert.match(
      arguments_,
      /^--fail --location --silent --show-error --proto =https --retry 3 --output /,
    );
    assert.doesNotMatch(arguments_, /auth|authorization|token/i);
  }
  assert.equal(
    readdirSync(scratch).some((name) => name.startsWith("understudy-download.")),
    false,
  );
  assert.equal(
    readdirSync(scratch).some((name) => name.startsWith("understudy-installer.")),
    false,
  );

  const failedRemoteInstall = run("/bin/sh", ["-c", publicBootstrap], {
    env: {
      ...remoteEnvironment,
      UNDERSTUDY_FAKE_CURL_LOG: path.join(
        scratch,
        "failed-curl-arguments.txt",
      ),
      UNDERSTUDY_FAKE_CURL_FAIL_INSTALLER: "1",
      UNDERSTUDY_INSTALL_DIR: failedRemoteInstallDirectory,
    },
    cwd: isolatedHome,
  });
  assert.equal(failedRemoteInstall.status, 42);
  assert.equal(existsSync(failedRemoteInstallDirectory), false);
  assert.equal(
    readdirSync(scratch).some((name) => name.startsWith("understudy-installer.")),
    false,
  );

  const installerEnvironment = {
    ...executionEnvironment,
    BUN_OPTIONS: "--version",
    BUN_BE_BUN: "1",
    UNDERSTUDY_INSTALLER_TEST_TEAM_ID: "not set",
  };
  const poisonedBin = path.join(scratch, "poisoned path");
  const poisonedPathSentinel = path.join(scratch, "poisoned-tool-ran.txt");
  mkdirSync(poisonedBin);
  for (const command of [
    "chmod",
    "codesign",
    "cp",
    "curl",
    "dirname",
    "grep",
    "mkdir",
    "mktemp",
    "mv",
    "rm",
    "rmdir",
    "sed",
    "shasum",
  ]) {
    writeFileSync(
      path.join(poisonedBin, command),
      '#!/bin/sh\nprintf "executed\\n" > "$POISONED_PATH_SENTINEL"\nexit 99\n',
      { mode: 0o755 },
    );
  }
  installerEnvironment.PATH = poisonedBin;
  installerEnvironment.POISONED_PATH_SENTINEL = poisonedPathSentinel;
  const install = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    { env: installerEnvironment, cwd: isolatedHome },
  );
  assert.equal(install.status, 0, install.stderr);
  assert.match(
    install.stdout,
    new RegExp(`Installed Understudy CLI ${escapeRegExp(packageVersion)}`),
  );
  assert.equal(existsSync(poisonedPathSentinel), false);
  const refresh = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    { env: installerEnvironment, cwd: isolatedHome },
  );
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.match(
    refresh.stdout,
    new RegExp(`Installed Understudy CLI ${escapeRegExp(packageVersion)}`),
  );
  const pathAwareRefresh = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    {
      env: {
        ...executionEnvironment,
        PATH: `${installDirectory}:/usr/bin:/bin`,
        UNDERSTUDY_INSTALLER_TEST_TEAM_ID: "not set",
      },
      cwd: isolatedHome,
    },
  );
  assert.equal(pathAwareRefresh.status, 0, pathAwareRefresh.stderr);
  assert.doesNotMatch(pathAwareRefresh.stdout, /Add .* to PATH/);
  const olderBin = path.join(scratch, "synthetic-older-bin");
  mkdirSync(olderBin);
  const oldCommand = path.join(olderBin, "understudy");
  writeFileSync(oldCommand, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  const shadowedInstall = run(installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    { env: { ...executionEnvironment, PATH: `${olderBin}:${installDirectory}:/usr/bin:/bin`, UNDERSTUDY_INSTALLER_TEST_TEAM_ID: "not set" }, cwd: isolatedHome });
  assert.equal(shadowedInstall.status, 0, shadowedInstall.stderr);
  assert.match(shadowedInstall.stdout, /Another understudy command takes precedence:/);
  assert.ok(shadowedInstall.stdout.includes(oldCommand));
  assert.equal(readFileSync(oldCommand, "utf8"), '#!/bin/sh\nexit 97\n');
  assert.deepEqual(readdirSync(installDirectory), ["understudy"]);
  assert.equal(readFileSync(stateSentinel, "utf8"), '{"synthetic":true}\n');
  const storedSession = readFileSync(oauthSession, "utf8");
  assert.equal(statSync(stateDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(stateSentinel).mode & 0o777, 0o600);
  assert.equal(statSync(oauthSession).mode & 0o777, 0o600);

  const installedBinary = path.join(installDirectory, "understudy");
  const installedDigest = digest(installedBinary);
  assert.equal(installedDigest, digest(binary));
  execFileSync("codesign", ["--verify", "--strict", installedBinary]);
  assertExecution(
    installedBinary,
    ["--version"],
    `${packageVersion}\n`,
    executionEnvironment,
  );
  assert.deepEqual(
    JSON.parse(
      assertExecution(
        installedBinary,
        ["--json", "auth", "status"],
        undefined,
        executionEnvironment,
      ),
    ),
    { authenticated: true, method: "oauth", verification: "local", pending: false, expiresAt: null },
  );

  const wrongSigningTeam = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    {
      env: {
        ...executionEnvironment,
        UNDERSTUDY_INSTALLER_TEST_TEAM_ID: "WRONGTEAM1",
      },
      cwd: isolatedHome,
    },
  );
  assert.equal(wrongSigningTeam.status, 1);
  assert.match(wrongSigningTeam.stderr, /not signed by the expected team/);
  assert.equal(digest(installedBinary), installedDigest);

  writeFileSync(binary, "corrupted release\n", { mode: 0o755 });
  const badChecksum = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    { env: installerEnvironment, cwd: isolatedHome },
  );
  assert.equal(badChecksum.status, 1);
  assert.match(badChecksum.stderr, /failed checksum verification/);
  assert.equal(digest(installedBinary), installedDigest);

  writeFileSync(binary, binaryBytes, { mode: 0o755 });
  writeFileSync(sourceChecksum, `${digest(binary)}  elsewhere\n`);
  const wrongChecksumTarget = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    { env: installerEnvironment, cwd: isolatedHome },
  );
  assert.equal(wrongChecksumTarget.status, 1);
  assert.match(wrongChecksumTarget.stderr, /checksum manifest is invalid/);
  assert.equal(digest(installedBinary), installedDigest);

  writeFileSync(binary, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  writeFileSync(
    sourceChecksum,
    `${digest(binary)}  understudy-darwin-arm64\n`,
  );
  const incompatibleTarget = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    { env: installerEnvironment, cwd: isolatedHome },
  );
  assert.equal(incompatibleTarget.status, 1);
  assert.match(incompatibleTarget.stderr, /invalid code signature/);
  assert.equal(digest(installedBinary), installedDigest);
  assert.deepEqual(readdirSync(installDirectory), ["understudy"]);

  writeFileSync(binary, binaryBytes, { mode: 0o755 });
  writeFileSync(
    sourceChecksum,
    `${digest(binary)}  understudy-darwin-arm64\n`,
  );
  writeFileSync(installedBinary, '#!/bin/sh\nprintf "999.0.0\\n"\n', {
    mode: 0o755,
  });
  assertExecution(
    installedBinary,
    ["--version"],
    "999.0.0\n",
    executionEnvironment,
  );
  const rollback = run(
    installer,
    ["--release-dir", artifacts, "--install-dir", installDirectory],
    { env: installerEnvironment, cwd: isolatedHome },
  );
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(
    rollback.stdout,
    new RegExp(`Installed Understudy CLI ${escapeRegExp(packageVersion)}`),
  );
  assert.equal(digest(installedBinary), installedDigest);
  assertExecution(
    installedBinary,
    ["--version"],
    `${packageVersion}\n`,
    executionEnvironment,
  );
  assert.equal(readFileSync(stateSentinel, "utf8"), '{"synthetic":true}\n');
  assert.equal(readFileSync(oauthSession, "utf8"), storedSession);
} finally {
  writeFileSync(binary, binaryBytes, { mode: 0o755 });
  writeFileSync(sourceChecksum, checksumBytes);
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`Standalone binary ${packageVersion} passed smoke checks.\n`);

function run(executable, arguments_, options) {
  return spawnSync(executable, arguments_, {
    encoding: "utf8",
    ...options,
  });
}

function assertExecution(executable, arguments_, expected, env, cwd = env.HOME) {
  const result = run(executable, arguments_, { env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  if (expected !== undefined) assert.equal(result.stdout, expected);
  return result.stdout;
}

function digest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertBundledSkills(binary, environment, scratch) {
  const directory = path.join(realpathSync(scratch), "standalone skills");
  mkdirSync(directory);
  const copiedBinary = path.join(directory, "understudy");
  copyFileSync(binary, copiedBinary);
  chmodSync(copiedBinary, 0o755);
  const replayHelp = assertExecution(copiedBinary, ["replay", "--help"], undefined, environment, directory);
  for (const contract of ["module.exports", "appendToolResults", "simulateTool", "recordedTools", "stateSchema", "preflight.json"]) {
    assert.ok(replayHelp.includes(contract), contract);
  }
  assert.equal(replayHelp.includes("](replay-"), false);
  const skills = JSON.parse(assertExecution(
    copiedBinary, ["skills", "list", "--json"], undefined, environment, directory,
  ));
  assert.equal(skills.cliVersion, packageVersion);
  const reviewedFiles = {
    "adapt-model-api": ["SKILL.md"],
    "compare-models": ["SKILL.md", "references/bundled-comparison.md", "references/comparison-view.md", "references/demo.md", "scripts/compare.mjs", "scripts/present.mjs", "templates/demo-adapter.mjs"],
    "setup-understudy": [
      "SKILL.md", "references/anthropic-messages.md", "references/mastra.md",
      "references/openai-compatible.md", "references/request-correlation.md", "references/vercel-ai-sdk.md",
    ],
    "try-models": ["SKILL.md", "references/spot-check-view.md", "references/upgrade.md"],
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
  assert.deepEqual(skills.skills.map(skill => skill.name).sort(), Object.keys(reviewedFiles).sort());
  for (const skill of skills.skills) {
    assert.equal(skill.entrypoint, "SKILL.md");
    assert.deepEqual(skill.files.map(file => file.path).sort(), reviewedFiles[skill.name]);
  }
  const assertSkill = (installed, skill, destination, status) => {
    assert.equal(installed.cliVersion, packageVersion);
    assert.equal(installed.name, skill.name);
    assert.equal(installed.version, skill.version);
    assert.equal(installed.status, status);
    assert.equal(installed.directory, path.join(destination, skill.name));
    assert.equal(installed.entrypoint, path.join(installed.directory, "SKILL.md"));
    assert.deepEqual(installed.files, skill.files);
    for (const file of installed.files) {
      const installedPath = path.join(installed.directory, file.path);
      const source = path.join(root, "skills", skill.name, file.path);
      const actual = readFileSync(installedPath);
      assert.deepEqual(actual, readFileSync(source));
      assert.equal(digest(installedPath), file.sha256);
      if (!file.path.endsWith(".md")) continue;
      for (const match of actual.toString("utf8").matchAll(/\]\(([^\s)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          assert.equal(existsSync(path.resolve(installed.directory, path.dirname(file.path), target)), true);
        }
      }
    }
  };
  const destinations = [
    { args: [], path: path.join(environment.HOME, ".agents", "skills"), status: "installed" },
    { args: ["--harness", "codex"], path: path.join(environment.HOME, ".agents", "skills"), status: "unchanged" },
    { args: ["--harness", "claude"], path: path.join(environment.HOME, ".claude", "skills"), status: "installed" },
    { args: ["--harness", "cursor"], path: path.join(environment.HOME, ".cursor", "skills"), status: "installed" },
    { args: ["--harness", "opencode"], path: path.join(environment.HOME, ".config", "opencode", "skills"), status: "installed" },
  ];
  for (const destination of destinations) {
    const args = ["skills", "install", ...destination.args, "--json"];
    const installed = JSON.parse(assertExecution(copiedBinary, args, undefined, environment, directory));
    assert.equal(installed.cliVersion, packageVersion);
    assert.equal(installed.target.directory, destination.path);
    assert.deepEqual(installed.skills.map(skill => skill.name), skills.skills.map(skill => skill.name));
    for (const skill of skills.skills) {
      assertSkill(installed.skills.find(value => value.name === skill.name), skill, destination.path, destination.status);
    }
    const repeated = JSON.parse(assertExecution(copiedBinary, args, undefined, environment, directory));
    assert.deepEqual(repeated, { ...installed, skills: installed.skills.map(skill => ({ ...skill, status: "unchanged" })) });
  }
  const destination = path.join(directory, "agent skills [literal]");
  for (const skill of skills.skills) {
    const args = ["skills", "install", skill.name, "--directory", destination, "--json"];
    const installed = JSON.parse(assertExecution(copiedBinary, args, undefined, environment, directory));
    assertSkill(installed, skill, destination, "installed");
    assert.equal("target" in installed, false);
    const repeated = JSON.parse(assertExecution(copiedBinary, args, undefined, environment, directory));
    assert.deepEqual(repeated, { ...installed, status: "unchanged" });
  }
  assert.equal(existsSync(path.join(environment.HOME, ".understudy")), false);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertCompiledOAuthLoopback(binary, environment, directory) {
  const fakeBin = path.join(directory, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeOpen = path.join(fakeBin, "open");
  writeFileSync(fakeOpen, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const oauthEnvironment = {
    ...environment,
    PATH: `${fakeBin}:/usr/bin:/bin`,
  };
  for (const runtime of ["node", "bun"]) {
    const lookup = spawnSync(runtime, ["--version"], {
      encoding: "utf8",
      cwd: directory,
      env: oauthEnvironment,
    });
    assert.equal(lookup.error?.code, "ENOENT");
  }

  const child = spawn(binary, ["login"], {
    cwd: directory,
    env: oauthEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const authorizationUrl = await waitForAuthorizationUrl(child);
    const redirectValue = authorizationUrl.searchParams.get("redirect_uri");
    assert.ok(redirectValue, "OAuth authorization URL omitted redirect_uri");
    const redirect = new URL(redirectValue);
    assert.equal(redirect.protocol, "http:");
    assert.equal(redirect.hostname, "127.0.0.1");
    assert.equal(redirect.pathname, "/callback");

    const probe = new URL("/compiled-runtime-probe", redirect);
    const response = await getLocal(probe);
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /Not found\./);
  } finally {
    await terminate(child);
  }
}

function waitForAuthorizationUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const inspect = () => {
      const match = stdout.match(/https:\/\/[^\s]+/);
      if (match) finish(() => resolve(new URL(match[0])));
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Compiled OAuth login did not expose its authorization URL. stderr: ${stderr}`,
            ),
          ),
        ),
      10_000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) =>
      finish(() =>
        reject(
          new Error(
            `Compiled OAuth login exited before the loopback probe (${code ?? signal}). stderr: ${stderr}`,
          ),
        ),
      ),
    );
  });
}

function getLocal(url) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({ statusCode: response.statusCode, body }),
      );
    });
    request.setTimeout(2_000, () =>
      request.destroy(new Error("Compiled OAuth loopback probe timed out")),
    );
    request.once("error", reject);
  });
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;
  const forcedExit = once(child, "exit");
  child.kill("SIGKILL");
  await forcedExit;
}
