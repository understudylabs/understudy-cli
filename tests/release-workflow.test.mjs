import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL(
  "../.github/workflows/binary-release.yml",
  import.meta.url,
);

const assetNames = [
  "SHA256SUMS",
  "THIRD_PARTY_NOTICES.txt",
  "install.sh",
  "latest.json",
  "understudy-darwin-arm64",
];
const releaseMarker = "understudy-release-run:123:synthetic";
const releaseTarget = "b".repeat(40);
const assetDigest = "sha256:" + "a".repeat(64);
const expectedDigests = Object.fromEntries(
  assetNames.map((name) => [name, assetDigest]),
);

function extractPublishScript(workflow) {
  const step = "      - name: Stage, verify, and publish the public release\n";
  const stepStart = workflow.indexOf(step);
  assert.notEqual(stepStart, -1, "publish step is missing");

  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, "publish run block is missing");

  const nextJob = "\n  smoke-public-install:\n";
  const runEnd = workflow.indexOf(nextJob, runStart);
  assert.notEqual(runEnd, -1, "public smoke job is missing");

  return workflow
    .slice(runStart + runMarker.length, runEnd)
    .split("\n")
    .map((line) => {
      assert.ok(
        line.length === 0 || line.startsWith("          "),
        "unexpected publish-script indentation: " + line,
      );
      return line.slice(10);
    })
    .join("\n");
}

function extractMarked(script, name) {
  const startMarker = "# " + name + ":start\n";
  const endMarker = "# " + name + ":end";
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);

  assert.notEqual(start, -1, name + " start marker is missing");
  assert.notEqual(end, -1, name + " end marker is missing");
  return script.slice(start + startMarker.length, end);
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function readPublishScript() {
  return extractPublishScript(await readFile(workflowUrl, "utf8"));
}

function extractStepScript(workflow, stepName) {
  const step = `      - name: ${stepName}\n`;
  const stepStart = workflow.indexOf(step);
  assert.notEqual(stepStart, -1, `${stepName} step is missing`);

  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, `${stepName} run block is missing`);

  const remainder = workflow.slice(runStart + runMarker.length);
  const boundary = remainder.search(/\n(?:      - name: |  [a-zA-Z0-9_-]+:\n)/);

  return workflow
    .slice(
      runStart + runMarker.length,
      boundary === -1 ? workflow.length : runStart + runMarker.length + boundary,
    )
    .split("\n")
    .map((line) => {
      assert.ok(
        line.length === 0 || line.startsWith("          "),
        `unexpected ${stepName} indentation: ${line}`,
      );
      return line.slice(10);
    })
    .join("\n");
}

async function runManualApprovalScenario({ ref, releaseTag, confirmation }) {
  const workflow = await readFile(workflowUrl, "utf8");
  const script = extractStepScript(workflow, "Validate manual release approval");
  return spawnSync("/bin/bash", [], {
    input: [
      "GITHUB_REF=" + shellQuote(ref),
      "RELEASE_TAG=" + shellQuote(releaseTag),
      "RELEASE_CONFIRMATION=" + shellQuote(confirmation),
      script,
      "",
    ].join("\n"),
    encoding: "utf8",
  });
}

async function runNotarizationScenario({ status, id }) {
  const workflow = await readFile(workflowUrl, "utf8");
  const script = extractStepScript(workflow, "Notarize the executable").replaceAll(
    "/usr/bin/ditto",
    "mock_ditto",
  );
  const cleanupScript = extractStepScript(
    workflow,
    "Remove any remaining release credentials",
  );
  const scratch = await mkdtemp(path.join(tmpdir(), "understudy-notarization-"));
  const binary = path.join(scratch, "understudy-darwin-arm64");
  const cleanupMarker = path.join(scratch, "cleanup-complete");

  try {
    await writeFile(binary, "synthetic binary\n");
    const response = JSON.stringify({ status, id });
    const harness = [
      "RUNNER_TEMP=" + shellQuote(scratch),
      "RELEASE_BINARY=" + shellQuote(binary),
      "NOTARY_KEY_P8_BASE64=" +
        shellQuote(Buffer.from("synthetic key\n").toString("base64")),
      "NOTARY_KEY_ID=ABCDEFGHIJ",
      "NOTARY_ISSUER_ID=12345678-1234-1234-1234-1234567890ab",
      ": > \"$RUNNER_TEMP/understudy-developer-id.p12\"",
      ": > \"$RUNNER_TEMP/understudy-signing.keychain-db\"",
      "mock_ditto() {",
      "  test \"$#\" = 5 || return 1",
      "  test \"$1\" = -c || return 1",
      "  test \"$2\" = -k || return 1",
      "  test \"$3\" = --keepParent || return 1",
      "  test \"$4\" = \"$RELEASE_BINARY\" || return 1",
      "  test \"$5\" = \"$RUNNER_TEMP/understudy-notarization.zip\" || return 1",
      "  : > \"$5\"",
      "}",
      "xcrun() {",
      "  test \"$#\" = 14 || return 1",
      "  test \"$1\" = notarytool && test \"$2\" = submit || return 1",
      "  test \"$3\" = \"$RUNNER_TEMP/understudy-notarization.zip\" || return 1",
      "  test \"$4\" = --key && test \"$5\" = \"$RUNNER_TEMP/understudy-notary-key.p8\" || return 1",
      "  test \"$6\" = --key-id && test \"$7\" = \"$NOTARY_KEY_ID\" || return 1",
      "  test \"$8\" = --issuer && test \"$9\" = \"$NOTARY_ISSUER_ID\" || return 1",
      "  test \"${10}\" = --wait || return 1",
      "  test \"${11}\" = --timeout && test \"${12}\" = 30m || return 1",
      "  test \"${13}\" = --output-format && test \"${14}\" = json || return 1",
      "  printf '%s\\n' " + shellQuote(response),
      "}",
      "security() {",
      "  test \"$#\" = 2 || return 1",
      "  test \"$1\" = delete-keychain || return 1",
      "  test \"$2\" = \"$RUNNER_TEMP/understudy-signing.keychain-db\" || return 1",
      "  rm -f \"$2\"",
      "}",
      "set +e",
      "( " + script.replaceAll("\n", "\n  ") + " )",
      "notarization_status=$?",
      "set -e",
      cleanupScript,
      "for file in understudy-signing.keychain-db understudy-developer-id.p12 understudy-notary-key.p8 understudy-notarization.zip understudy-notarization.json; do",
      "  test ! -e \"$RUNNER_TEMP/$file\"",
      "done",
      "printf 'complete\\n' > " + shellQuote(cleanupMarker),
      "exit \"$notarization_status\"",
      "",
    ].join("\n");
    const execution = spawnSync("/bin/bash", [], {
      input: harness,
      encoding: "utf8",
    });
    const cleanupCompleted = await readFile(cleanupMarker, "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    return { ...execution, cleanupCompleted: cleanupCompleted === "complete\n" };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function runDiscoveryScenario({
  publishedStatus,
  graphRelease,
  graphPayload,
  publishedRelease = makeRelease(),
  exactRelease = makeRelease(),
  graphFailure = false,
  exactFailure = false,
}) {
  const script = await readPublishScript();
  const discoveryFunction = extractMarked(script, "release-discovery");
  const scratch = await mkdtemp(
    path.join(tmpdir(), "understudy-release-discovery-"),
  );
  const response = path.join(scratch, "release.json");
  const operations = path.join(scratch, "operations");

  try {
    const graphResponse =
      graphPayload ?? { data: { repository: { release: graphRelease } } };
    const harness = [
      "set -euo pipefail",
      "RELEASE_REPOSITORY=understudylabs/understudy-cli-releases",
      "RELEASE_TAG=v0.1.0",
      "RUNNER_TEMP=" + shellQuote(scratch),
      "forced_published_status=" + shellQuote(publishedStatus),
      "published_release=" + shellQuote(JSON.stringify(publishedRelease)),
      "exact_release=" + shellQuote(JSON.stringify(exactRelease)),
      "graph_response=" + shellQuote(JSON.stringify(graphResponse)),
      "graph_failure=" + (graphFailure ? "true" : "false"),
      "exact_failure=" + (exactFailure ? "true" : "false"),
      "github_request_status() {",
      "  local method=\"$1\"",
      "  local endpoint=\"$2\"",
      "  local output=\"$3\"",
      "  test \"$method\" = GET",
      "  test -n \"$endpoint\"",
      "  printf 'published\\n' >> \"$RUNNER_TEMP/operations\"",
      "  if [ \"$forced_published_status\" = transport ]; then",
      "    return 1",
      "  fi",
      "  if [ \"$forced_published_status\" = 200 ]; then",
      "    printf '%s\\n' \"$published_release\" > \"$output\"",
      "  else",
      "    printf '{}\\n' > \"$output\"",
      "  fi",
      "  printf '%s' \"$forced_published_status\"",
      "}",
      "gh() {",
      "  test \"$1\" = api",
      "  shift",
      "  if [ \"$1\" = graphql ]; then",
      "    printf 'graphql\\n' >> \"$RUNNER_TEMP/operations\"",
      "    if [ \"$graph_failure\" = true ]; then",
      "      return 1",
      "    fi",
      "    printf '%s\\n' \"$graph_response\"",
      "    return 0",
      "  fi",
      "  printf 'exact\\n' >> \"$RUNNER_TEMP/operations\"",
      "  if [ \"$exact_failure\" = true ]; then",
      "    return 1",
      "  fi",
      "  printf '%s\\n' \"$exact_release\"",
      "}",
      discoveryFunction,
      "set +e",
      "result=\"$(find_release_status " + shellQuote(response) + ")\"",
      "status=$?",
      "set -e",
      "printf '%s\\n%s\\n' \"$status\" \"$result\"",
      "",
    ].join("\n");
    const execution = spawnSync("/bin/bash", [], {
      input: harness,
      encoding: "utf8",
    });
    const [status, result] = execution.stdout.trimEnd().split("\n");
    const operationLog = await readFile(operations, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    const responseBody = await readFile(response, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });

    assert.equal(execution.signal, null, execution.stderr);
    return {
      status: Number(status),
      result: result ?? "",
      stderr: execution.stderr,
      operations: operationLog.trim()
        ? operationLog.trim().split("\n")
        : [],
      response: responseBody.trim(),
    };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

function makeRelease(overrides = {}) {
  return {
    id: 123,
    tag_name: "v0.1.0",
    name: "Understudy CLI 0.1.0",
    target_commitish: releaseTarget,
    body: "Synthetic release.\n\n<!-- " + releaseMarker + " -->",
    draft: true,
    prerelease: false,
    immutable: false,
    assets: assetNames.map((name) => ({
      name,
      state: "uploaded",
      size: 1,
      digest: assetDigest,
    })),
    ...overrides,
  };
}

async function runValidationScenario(release, expectedState) {
  const script = await readPublishScript();
  const validationFunction = extractMarked(script, "validate-release-state");
  const scratch = await mkdtemp(
    path.join(tmpdir(), "understudy-release-validation-"),
  );
  const response = path.join(scratch, "release.json");

  try {
    await writeFile(response, JSON.stringify(release) + "\n");
    const harness = [
      "set -euo pipefail",
      "RELEASE_TAG=v0.1.0",
      "RELEASE_VERSION=0.1.0",
      "target_main_sha=" + shellQuote(releaseTarget),
      "release_marker=" + shellQuote(releaseMarker),
      "release_notes=" +
        shellQuote("Synthetic release.\n\n<!-- " + releaseMarker + " -->"),
      "expected_asset_digests=" +
        shellQuote(JSON.stringify(expectedDigests)),
      validationFunction,
      "set +e",
      "validate_release_state " +
        shellQuote(response) +
        " " +
        shellQuote(expectedState),
      "status=$?",
      "set -e",
      "printf '%s' \"$status\"",
      "",
    ].join("\n");
    const execution = spawnSync("/bin/bash", [], {
      input: harness,
      encoding: "utf8",
    });

    assert.equal(execution.signal, null, execution.stderr);
    return {
      status: Number(execution.stdout),
      stderr: execution.stderr,
    };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function runTagScenario({ status, allowAbsent, sha = releaseTarget }) {
  const script = await readPublishScript();
  const tagFunction = extractMarked(script, "verify-release-tag");
  const scratch = await mkdtemp(path.join(tmpdir(), "understudy-release-tag-"));
  const response = path.join(scratch, "tag.json");

  try {
    const harness = [
      "set -euo pipefail",
      "RELEASE_REPOSITORY=understudylabs/understudy-cli-releases",
      "RELEASE_TAG=v0.1.0",
      "target_main_sha=" + shellQuote(releaseTarget),
      "forced_status=" + shellQuote(status),
      "forced_sha=" + shellQuote(sha),
      "github_request_status() {",
      "  local method=\"$1\"",
      "  local endpoint=\"$2\"",
      "  local output=\"$3\"",
      "  test \"$method\" = GET",
      "  test -n \"$endpoint\"",
      "  if [ \"$forced_status\" = transport ]; then",
      "    return 1",
      "  fi",
      "  if [ \"$forced_status\" = 200 ]; then",
      "    printf '{\"object\":{\"type\":\"commit\",\"sha\":\"%s\"}}\\n' \\",
      "      \"$forced_sha\" > \"$output\"",
      "  else",
      "    printf '{}\\n' > \"$output\"",
      "  fi",
      "  printf '%s' \"$forced_status\"",
      "}",
      tagFunction,
      "set +e",
      "verify_release_tag " +
        shellQuote(response) +
        " " +
        (allowAbsent ? "true" : "false"),
      "result=$?",
      "set -e",
      "printf '%s' \"$result\"",
      "",
    ].join("\n");
    const execution = spawnSync("/bin/bash", [], {
      input: harness,
      encoding: "utf8",
    });

    assert.equal(execution.signal, null, execution.stderr);
    return {
      status: Number(execution.stdout),
      stderr: execution.stderr,
    };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function runWorkflowScenario(
  initialState,
  {
    graphVisibilityDelay = 0,
    immutabilityStates = [true, true],
  } = {},
) {
  const script = (await readPublishScript()).replaceAll(
    "/usr/bin/curl",
    "mock_curl",
  );
  const scratch = await mkdtemp(path.join(tmpdir(), "understudy-release-e2e-"));
  const stateFile = path.join(scratch, "state");
  const operationLog = path.join(scratch, "operations");
  const graphLookups = path.join(scratch, "graph-lookups");
  const immutabilityLookups = path.join(scratch, "immutability-lookups");
  const digestFile = path.join(scratch, "SHA256SUMS");
  const releaseBody =
    "Standalone macOS arm64 release of Understudy CLI 0.1.0.\n\n<!-- " +
    releaseMarker +
    " -->";
  const draft = makeRelease({ body: releaseBody });
  const published = makeRelease({
    body: releaseBody,
    draft: false,
    immutable: true,
  });

  try {
    await writeFile(stateFile, initialState + "\n");
    await writeFile(graphLookups, "0\n");
    await writeFile(immutabilityLookups, "0\n");
    await writeFile(
      digestFile,
      assetNames
        .map((name) => "a".repeat(64) + "  " + name)
        .join("\n") + "\n",
    );
    const harness = [
      "set -euo pipefail",
      "RUNNER_TEMP=" + shellQuote(scratch),
      "RELEASE_DIRECTORY=" + shellQuote(scratch),
      "EXPECTED_RELEASE_DIGESTS=" + shellQuote(digestFile),
      "RELEASE_REPOSITORY=understudylabs/understudy-cli-releases",
      "RELEASE_VERSION=0.1.0",
      "RELEASE_TAG=v0.1.0",
      "GITHUB_RUN_ID=123",
      "GITHUB_SHA=synthetic",
      "GH_TOKEN=synthetic",
      "graph_visibility_delay=" + graphVisibilityDelay,
      "forced_repository_json=" +
        shellQuote(
          JSON.stringify({
            private: false,
            visibility: "public",
            default_branch: "main",
            archived: false,
            disabled: false,
          }),
        ),
      "forced_main_json=" +
        shellQuote(
          JSON.stringify({
            object: { type: "commit", sha: releaseTarget },
          }),
        ),
      "forced_tag_json=" +
        shellQuote(
          JSON.stringify({
            object: { type: "commit", sha: releaseTarget },
          }),
        ),
      "forced_draft_json=" + shellQuote(JSON.stringify(draft)),
      "forced_published_json=" + shellQuote(JSON.stringify(published)),
      "forced_graph_draft=" +
        shellQuote(
          JSON.stringify({
            data: {
              repository: {
                release: { databaseId: 123, isDraft: true },
              },
            },
          }),
        ),
      "forced_graph_absent=" +
        shellQuote(
          JSON.stringify({ data: { repository: { release: null } } }),
        ),
      "forced_initial_immutability=" +
        shellQuote(JSON.stringify({ enabled: immutabilityStates[0] })),
      "forced_publish_immutability=" +
        shellQuote(JSON.stringify({ enabled: immutabilityStates[1] })),
      "mock_curl() {",
      "  local output=''",
      "  local endpoint=''",
      "  local state",
      "  local status",
      "  local body",
      "  while [ \"$#\" -gt 0 ]; do",
      "    case \"$1\" in",
      "      --request|--output|--write-out|--header)",
      "        if [ \"$1\" = --output ]; then output=\"$2\"; fi",
      "        shift 2",
      "        ;;",
      "      https://api.github.com/*)",
      "        endpoint=\"${1#https://api.github.com/}\"",
      "        shift",
      "        ;;",
      "      *) shift ;;",
      "    esac",
      "  done",
      "  state=\"$(<\"$RUNNER_TEMP/state\")\"",
      "  case \"$endpoint\" in",
      "    repos/*/releases/tags/*)",
      "      if [ \"$state\" = published ]; then",
      "        status=200; body=\"$forced_published_json\"",
      "      else",
      "        status=404; body='{}'",
      "      fi",
      "      ;;",
      "    repos/*/git/ref/tags/*)",
      "      if [ \"$state\" = published ]; then",
      "        status=200; body=\"$forced_tag_json\"",
      "      else",
      "        status=404; body='{}'",
      "      fi",
      "      ;;",
      "    *) status=500; body='{}' ;;",
      "  esac",
      "  printf '%s\n' \"$body\" > \"$output\"",
      "  printf '%s' \"$status\"",
      "}",
      "gh() {",
      "  printf '%s\n' \"$*\" >> \"$RUNNER_TEMP/operations\"",
      "  if [ \"$1\" = release ]; then",
      "    test \"$2\" = create",
      "    test \"$(<\"$RUNNER_TEMP/state\")\" = absent",
      "    printf 'draft\n' > \"$RUNNER_TEMP/state\"",
      "    return 0",
      "  fi",
      "  test \"$1\" = api",
      "  shift",
      "  if [ \"$1\" = graphql ]; then",
      "    if [ \"$(<\"$RUNNER_TEMP/state\")\" = draft ]; then",
      "      graph_lookups=\"$(<\"$RUNNER_TEMP/graph-lookups\")\"",
      "      graph_lookups=$((graph_lookups + 1))",
      "      printf '%s\n' \"$graph_lookups\" > \"$RUNNER_TEMP/graph-lookups\"",
      "      if [ \"$graph_lookups\" -gt \"$graph_visibility_delay\" ]; then",
      "        printf '%s\n' \"$forced_graph_draft\"",
      "      else",
      "        printf '%s\n' \"$forced_graph_absent\"",
      "      fi",
      "    else",
      "      printf '%s\n' \"$forced_graph_absent\"",
      "    fi",
      "    return 0",
      "  fi",
      "  if [ \"$1\" = --method ]; then",
      "    test \"$2\" = PATCH",
      "    test \"$(<\"$RUNNER_TEMP/state\")\" = draft",
      "    printf 'published\n' > \"$RUNNER_TEMP/state\"",
      "    printf '%s\n' \"$forced_published_json\"",
      "    return 0",
      "  fi",
      "  case \"$1\" in",
      "    repos/understudylabs/understudy-cli-releases)",
      "      printf '%s\n' \"$forced_repository_json\"",
      "      ;;",
      "    repos/*/immutable-releases)",
      "      immutability_lookups=\"$(<\"$RUNNER_TEMP/immutability-lookups\")\"",
      "      immutability_lookups=$((immutability_lookups + 1))",
      "      printf '%s\n' \"$immutability_lookups\" > \"$RUNNER_TEMP/immutability-lookups\"",
      "      if [ \"$immutability_lookups\" -eq 1 ]; then",
      "        printf '%s\n' \"$forced_initial_immutability\"",
      "      else",
      "        printf '%s\n' \"$forced_publish_immutability\"",
      "      fi",
      "      ;;",
      "    repos/*/git/ref/heads/main)",
      "      printf '%s\n' \"$forced_main_json\"",
      "      ;;",
      "    repos/*/releases/123)",
      "      if [ \"$(<\"$RUNNER_TEMP/state\")\" = published ]; then",
      "        printf '%s\n' \"$forced_published_json\"",
      "      else",
      "        printf '%s\n' \"$forced_draft_json\"",
      "      fi",
      "      ;;",
      "    repos/*/releases/latest)",
      "      test \"$(<\"$RUNNER_TEMP/state\")\" = published",
      "      printf 'v0.1.0\n'",
      "      ;;",
      "    *) return 1 ;;",
      "  esac",
      "}",
      "sleep() { :; }",
      script,
      "",
    ].join("\n");
    const execution = spawnSync("/bin/bash", [], {
      input: harness,
      encoding: "utf8",
    });
    const operations = await readFile(operationLog, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });

    return {
      status: execution.status,
      stderr: execution.stderr,
      state: (await readFile(stateFile, "utf8")).trim(),
      operations: operations.trim() ? operations.trim().split("\n") : [],
    };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

test("release publication requires an explicit manual tag confirmation", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const previewJob = workflow.slice(
    workflow.indexOf("  build:\n"),
    workflow.indexOf("\n  sign-release:\n"),
  );
  const approvalScript = extractStepScript(
    workflow,
    "Validate manual release approval",
  );
  const syntax = spawnSync("/bin/bash", ["-n"], {
    input: approvalScript,
    encoding: "utf8",
  });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /\n  push:\n\s+tags:/);
  assert.doesNotMatch(
    workflow,
    /^\s+environment:\s+(binary-release|public-binary-release)$/m,
  );
  assert.doesNotMatch(previewJob, /secrets\./);
  assert.equal(
    workflow.match(/if: github\.event_name == 'workflow_dispatch'/g)?.length,
    6,
  );

  const accepted = await runManualApprovalScenario({
    ref: "refs/heads/main",
    releaseTag: "v0.1.0",
    confirmation: "publish-v0.1.0",
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const scenario of [
    {
      ref: "refs/heads/release-candidate",
      releaseTag: "v0.1.0",
      confirmation: "publish-v0.1.0",
    },
    {
      ref: "refs/heads/main",
      releaseTag: "v0.1.0",
      confirmation: "publish-v0.1.1",
    },
    {
      ref: "refs/heads/main",
      releaseTag: "vnext",
      confirmation: "publish-vnext",
    },
  ]) {
    const rejected = await runManualApprovalScenario(scenario);
    assert.notEqual(rejected.status, 0, JSON.stringify(scenario));
  }
});

test("Developer ID output is notarized before release code executes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const signIndex = workflow.indexOf("      - name: Sign the executable\n");
  const notarizeIndex = workflow.indexOf("      - name: Notarize the executable\n");
  const removeIndex = workflow.indexOf(
    "      - name: Remove release credentials before executing release code\n",
  );
  const executeIndex = workflow.indexOf(
    "      - name: Verify and package the final release\n",
  );
  const notarizeScript = extractStepScript(workflow, "Notarize the executable");
  const cleanupScript = extractStepScript(
    workflow,
    "Remove release credentials before executing release code",
  );
  const finalCleanupScript = extractStepScript(
    workflow,
    "Remove any remaining release credentials",
  );
  const packageScript = extractStepScript(
    workflow,
    "Verify and package the final release",
  );
  const syntax = spawnSync("/bin/bash", ["-n"], {
    input: notarizeScript,
    encoding: "utf8",
  });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.ok(signIndex > -1 && signIndex < notarizeIndex);
  assert.ok(notarizeIndex < removeIndex && removeIndex < executeIndex);
  assert.match(workflow, /secrets\.APPLE_NOTARY_KEY_P8_BASE64/);
  assert.match(workflow, /vars\.APPLE_NOTARY_KEY_ID/);
  assert.match(workflow, /vars\.APPLE_NOTARY_ISSUER_ID/);
  assert.match(notarizeScript, /notarytool submit/);
  assert.match(notarizeScript, /--wait/);
  assert.match(notarizeScript, /--timeout 30m/);
  assert.match(notarizeScript, /\.status == "Accepted"/);
  assert.match(notarizeScript, /umask 077/);
  assert.match(
    extractStepScript(workflow, "Import release signing credentials"),
    /umask 077/,
  );
  const smokeEnd = packageScript.indexOf("# installed-cli-smoke:end");
  assert.ok(smokeEnd > -1);
  assert.ok(
    packageScript.lastIndexOf('shasum -a 256 "$RELEASE_BINARY"') > smokeEnd,
  );
  assert.equal(packageScript.match(/codesign --verify/g)?.length, 2);
  for (const credential of [
    "understudy-developer-id.p12",
    "understudy-notary-key.p8",
    "understudy-notarization.zip",
    "understudy-notarization.json",
  ]) {
    assert.match(cleanupScript, new RegExp(credential.replaceAll(".", "\\.")));
    assert.match(
      finalCleanupScript,
      new RegExp(credential.replaceAll(".", "\\.")),
    );
  }

  const accepted = await runNotarizationScenario({
    status: "Accepted",
    id: "12345678-1234-1234-1234-1234567890ab",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.cleanupCompleted, true);

  for (const response of [
    {
      status: "Invalid",
      id: "12345678-1234-1234-1234-1234567890ab",
    },
    { status: "Accepted", id: "not-a-submission-id" },
  ]) {
    const rejected = await runNotarizationScenario(response);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.cleanupCompleted, true);
  }
});

test("signed and public releases verify the same source-independent installed CLI contract", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const signed = extractStepScript(workflow, "Verify and package the final release");
  const published = extractStepScript(workflow, "Install the published release without GitHub credentials");
  const signedSmoke = extractMarked(signed, "installed-cli-smoke");
  assert.equal(extractMarked(published, "installed-cli-smoke"), signedSmoke);
  for (const script of [signed, published]) {
    const syntax = spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("installed release smoke accepts the current bundled skill catalog and installed files", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const smoke = extractMarked(extractStepScript(workflow, "Verify and package the final release"), "installed-cli-smoke");
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "understudy-release-skills-")));
  try {
    const installDirectory = path.join(scratch, "bin");
    await mkdir(installDirectory);
    const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    // Exercise the workflow assertions against real CLI output in source CI.
    // Binary smoke separately proves the compiled command needs no Node/Bun.
    await writeFile(path.join(installDirectory, "understudy"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`,
      { mode: 0o755 });
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const result = spawnSync("/bin/bash", [], {
      input: ["set -euo pipefail", `test_home=${shellQuote(scratch)}`,
        `install_directory=${shellQuote(installDirectory)}`, `version=${shellQuote(version)}`, smoke].join("\n"),
      encoding: "utf8", cwd: scratch,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});

test("release skill validation accepts future inventory and rejects missing or inconsistent evidence", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const validation = extractMarked(extractStepScript(workflow, "Verify and package the final release"), "installed-skills");
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "synthetic-release-inventory-")));
  try {
    const directory = path.join(scratch, "agent skills");
    const names = ["setup-understudy", "build-evals", "synthetic-future-skill"];
    const skills = [];
    for (const name of names) {
      const content = `# Wholly synthetic ${name}\n`;
      await mkdir(path.join(directory, name), { recursive: true });
      await writeFile(path.join(directory, name, "SKILL.md"), content);
      skills.push({ name, version: "a".repeat(64), entrypoint: "SKILL.md", files: [
        { path: "SKILL.md", sha256: createHash("sha256").update(content).digest("hex") },
      ] });
    }
    const listed = { cliVersion: "0.1.0", skills };
    const installation = status => ({ cliVersion: "0.1.0", directory, skills: skills.map(skill => ({
      ...skill, status, directory: path.join(directory, skill.name), entrypoint: path.join(directory, skill.name, "SKILL.md"),
    })) });
    const run = async (catalog = listed, installed = installation("installed"), repeated = installation("unchanged")) => {
      await writeFile(path.join(scratch, "skills.json"), JSON.stringify(catalog));
      await writeFile(path.join(scratch, "installed-skills.json"), JSON.stringify(installed));
      await writeFile(path.join(scratch, "repeated-skills.json"), JSON.stringify(repeated));
      return spawnSync("/bin/bash", [], {
        input: ["set -euo pipefail", `test_home=${shellQuote(scratch)}`, "version=0.1.0", validation].join("\n"),
        encoding: "utf8",
      });
    };
    assert.equal((await run()).status, 0);
    assert.notEqual((await run({ ...listed, skills: [] })).status, 0);
    assert.notEqual((await run({ ...listed, skills: skills.filter(skill => skill.name !== "build-evals") })).status, 0);
    assert.notEqual((await run({ ...listed, skills: [...skills, skills[0]] })).status, 0);
    const missing = installation("installed");
    missing.skills.pop();
    assert.notEqual((await run(listed, missing)).status, 0);
    const stale = installation("installed");
    stale.skills[0].version = "b".repeat(64);
    assert.notEqual((await run(listed, stale)).status, 0);
    const wrongLocation = installation("installed");
    wrongLocation.skills[0].directory = path.join(scratch, "synthetic-wrong-location");
    assert.notEqual((await run(listed, wrongLocation)).status, 0);
    assert.notEqual((await run(listed, installation("unchanged"))).status, 0);
    assert.notEqual((await run(listed, installation("installed"), installation("installed"))).status, 0);
    const unsafe = structuredClone(listed);
    unsafe.skills[0].files[0].path = "../SKILL.md";
    assert.notEqual((await run(unsafe)).status, 0);
    const file = path.join(directory, "synthetic-future-skill", "SKILL.md");
    await writeFile(file, "Synthetic changed bytes\n");
    assert.notEqual((await run()).status, 0);
    await rm(file);
    assert.notEqual((await run()).status, 0);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});

test("release smoke accepts the current fresh-install status and rejects authentication or incomplete output", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const smoke = extractMarked(extractStepScript(workflow, "Verify and package the final release"), "unauthenticated-status");
  const scratch = await mkdtemp(path.join(tmpdir(), "understudy-release-status-"));
  try {
    const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const runCli = (args) => spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8", cwd: scratch,
      env: { HOME: scratch, USERPROFILE: scratch, PATH: "/usr/bin:/bin" },
    });
    const auth = runCli(["--json", "auth", "status"]);
    const status = runCli(["status", "--json"]);
    assert.equal(auth.status, 0, auth.stderr);
    assert.equal(status.status, 1, status.stderr);
    const authOutput = JSON.parse(auth.stdout);
    const statusOutput = JSON.parse(status.stdout);
    const check = async (authValue, statusValue = statusOutput) => {
      await writeFile(path.join(scratch, "auth.json"), JSON.stringify(authValue));
      await writeFile(path.join(scratch, "status.json"), JSON.stringify(statusValue));
      return spawnSync("/bin/bash", [], {
        input: "set -euo pipefail\ntest_home=" + shellQuote(scratch) + "\n" + smoke,
        encoding: "utf8",
      });
    };
    const current = await check(authOutput);
    assert.equal(current.status, 0, current.stderr);
    const additive = await check({ ...authOutput, syntheticExtra: true });
    assert.equal(additive.status, 0, additive.stderr);
    for (const value of [
      { authenticated: false, method: null },
      { ...authOutput, authenticated: true },
      { ...authOutput, pending: true },
      { ...authOutput, verification: "local-invalid" },
    ]) assert.notEqual((await check(value)).status, 0);
    assert.notEqual((await check(authOutput, { ...statusOutput, ready: true })).status, 0);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});

test("runtime absence checks fail closed when Node or Bun resolves", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const runtimeCheck = extractMarked(extractStepScript(workflow, "Verify and package the final release"), "runtime-absence");
  const scratch = await mkdtemp(path.join(tmpdir(), "understudy-release-runtime-"));
  try {
    const check = () => spawnSync("/bin/sh", ["-eu", "-c", runtimeCheck], {
      encoding: "utf8", env: { PATH: scratch },
    });
    assert.equal(check().status, 0);
    for (const runtime of ["node", "bun"]) {
      const executable = path.join(scratch, runtime);
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const rejected = check();
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, new RegExp("Unexpected runtime.*" + runtime));
      await rm(executable);
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});

test("the public release state machine is valid and non-destructive", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const script = extractPublishScript(workflow);
  const syntax = spawnSync("/bin/bash", ["-n"], {
    input: script,
    encoding: "utf8",
  });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(workflow, /permission-administration: read/);
  assert.equal(script.match(/immutable-releases/g)?.length, 2);
  assert.match(script, /query RepositoryReleaseByTag/);
  assert.match(script, /databaseId isDraft/);
  assert.match(script, /release_marker/);
  assert.match(script, /wait_for_created_release/);
  assert.doesNotMatch(script, /--paginate|wait_for_release_status/);
  assert.match(
    script,
    /published_json="\$\(gh api --method PATCH \\\n\s+"repos\/\$\{RELEASE_REPOSITORY\}\/releases\/\$\{release_id\}"/,
  );
  assert.match(
    script,
    /"repos\/\$\{RELEASE_REPOSITORY\}\/releases\/\$\{release_id\}" \\\n\s+> "\$release_response"/,
  );
  assert.doesNotMatch(script, /--method DELETE|gh release delete|gh release edit/);
  assert.ok(
    script.lastIndexOf('validate_release_state "$release_response" draft') <
      script.indexOf('published_json="$(gh api --method PATCH'),
  );
  assert.ok(
    script.lastIndexOf('verify_release_tag "$tag_response" true') >
      script.lastIndexOf("immutable-releases"),
  );
  assert.ok(
    script.lastIndexOf('verify_release_tag "$tag_response" true') <
      script.indexOf('published_json="$(gh api --method PATCH'),
  );
});

test("the full workflow accepts an exact immutable release", async () => {
  const result = await runWorkflowScenario("published");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, "published");
  assert.equal(result.operations.some((line) => line.startsWith("release create")), false);
  assert.equal(result.operations.some((line) => line.includes("--method PATCH")), false);
});

test("the full workflow resumes and publishes an exact draft", async () => {
  const result = await runWorkflowScenario("draft");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, "published");
  assert.equal(result.operations.some((line) => line.startsWith("release create")), false);
  assert.equal(result.operations.filter((line) => line.includes("--method PATCH")).length, 1);
});

test("the full workflow creates and publishes an absent release", async () => {
  const result = await runWorkflowScenario("absent", {
    graphVisibilityDelay: 2,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, "published");
  assert.equal(result.operations.filter((line) => line.startsWith("release create")).length, 1);
  assert.equal(result.operations.filter((line) => line.includes("--method PATCH")).length, 1);
});

test("the full workflow preserves a draft that stays invisible", async () => {
  const result = await runWorkflowScenario("absent", {
    graphVisibilityDelay: 99,
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.state, "draft");
  assert.equal(result.operations.filter((line) => line.startsWith("release create")).length, 1);
  assert.equal(result.operations.some((line) => line.includes("--method PATCH")), false);
  assert.match(result.stderr, /did not become visible/);
});

test("the full workflow rechecks immutability before publication", async () => {
  const result = await runWorkflowScenario("absent", {
    immutabilityStates: [true, false],
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.state, "draft");
  assert.equal(result.operations.filter((line) => line.startsWith("release create")).length, 1);
  assert.equal(result.operations.some((line) => line.includes("--method PATCH")), false);
});

test("release discovery returns a published REST release directly", async () => {
  const published = makeRelease({ draft: false, immutable: true });
  const result = await runDiscoveryScenario({
    publishedStatus: "200",
    graphRelease: null,
    publishedRelease: published,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result, "200");
  assert.deepEqual(result.operations, ["published"]);
  assert.deepEqual(JSON.parse(result.response), published);
});

test("release discovery finds a draft through the exact GraphQL tag", async () => {
  const draft = makeRelease();
  const result = await runDiscoveryScenario({
    publishedStatus: "404",
    graphRelease: { databaseId: 123, isDraft: true },
    exactRelease: draft,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result, "200");
  assert.deepEqual(result.operations, ["published", "graphql", "exact"]);
  assert.deepEqual(JSON.parse(result.response), draft);
});

test("release discovery reports an exact absence", async () => {
  const result = await runDiscoveryScenario({
    publishedStatus: "404",
    graphRelease: null,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result, "404");
  assert.deepEqual(result.operations, ["published", "graphql"]);
  assert.equal(result.response, "{}");
});

test("release discovery rejects an unexpected GraphQL lifecycle", async () => {
  const result = await runDiscoveryScenario({
    publishedStatus: "404",
    graphRelease: { databaseId: 123, isDraft: false },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.operations, ["published", "graphql"]);
});

for (const [name, graphPayload] of [
  ["missing data", {}],
  ["missing repository", { data: { repository: null } }],
  [
    "GraphQL errors",
    {
      errors: [{ message: "synthetic" }],
      data: { repository: { release: null } },
    },
  ],
]) {
  test("release discovery rejects " + name, async () => {
    const result = await runDiscoveryScenario({
      publishedStatus: "404",
      graphRelease: null,
      graphPayload,
    });
    assert.equal(result.status, 1);
    assert.deepEqual(result.operations, ["published", "graphql"]);
  });
}

for (const publishedStatus of ["401", "403", "429", "500", "transport"]) {
  test(
    "release discovery fails closed on published API " + publishedStatus,
    async () => {
      const result = await runDiscoveryScenario({
        publishedStatus,
        graphRelease: null,
      });
      assert.equal(result.status, 1);
      assert.deepEqual(result.operations, ["published"]);
    },
  );
}

test("release discovery fails closed on a GraphQL error", async () => {
  const result = await runDiscoveryScenario({
    publishedStatus: "404",
    graphRelease: null,
    graphFailure: true,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(result.operations, ["published", "graphql"]);
});

test("release discovery fails closed when an exact draft fetch fails", async () => {
  const result = await runDiscoveryScenario({
    publishedStatus: "404",
    graphRelease: { databaseId: 123, isDraft: true },
    exactFailure: true,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(result.operations, ["published", "graphql", "exact"]);
});

test("release validation accepts the exact owned draft", async () => {
  const result = await runValidationScenario(makeRelease(), "draft");
  assert.equal(result.status, 0, result.stderr);
});

test("release validation accepts the exact immutable publication", async () => {
  const result = await runValidationScenario(
    makeRelease({ draft: false, immutable: true }),
    "published",
  );
  assert.equal(result.status, 0, result.stderr);
});

test("immutable resume rejects a release for another mirror commit", async () => {
  const result = await runValidationScenario(
    makeRelease({
      target_commitish: "c".repeat(40),
      draft: false,
      immutable: true,
    }),
    "published",
  );
  assert.equal(result.status, 1);
});

test("release validation rejects a different workflow run", async () => {
  const result = await runValidationScenario(
    makeRelease({ body: "Synthetic unowned release." }),
    "draft",
  );
  assert.equal(result.status, 1);
});

test("release validation rejects changed notes with the same run marker", async () => {
  const result = await runValidationScenario(
    makeRelease({
      body:
        "Changed public text.\n\n<!-- " + releaseMarker + " -->",
    }),
    "draft",
  );
  assert.equal(result.status, 1);
});

test("release validation rejects changed assets", async () => {
  const result = await runValidationScenario(
    makeRelease({ assets: makeRelease().assets.slice(1) }),
    "draft",
  );
  assert.equal(result.status, 1);
});

test("release validation rejects the wrong lifecycle state", async () => {
  const result = await runValidationScenario(
    makeRelease({ draft: false, immutable: true }),
    "draft",
  );
  assert.equal(result.status, 1);
});

test("tag verification accepts the exact mirror commit", async () => {
  const result = await runTagScenario({ status: "200", allowAbsent: false });
  assert.equal(result.status, 0, result.stderr);
});

test("tag verification allows absence only before publication", async () => {
  const before = await runTagScenario({ status: "404", allowAbsent: true });
  const after = await runTagScenario({ status: "404", allowAbsent: false });

  assert.equal(before.status, 0, before.stderr);
  assert.equal(after.status, 1);
});

test("tag verification rejects a moved tag", async () => {
  const result = await runTagScenario({
    status: "200",
    allowAbsent: true,
    sha: "c".repeat(40),
  });
  assert.equal(result.status, 1);
});

for (const status of ["401", "403", "429", "500", "transport"]) {
  test("tag verification fails closed on GitHub " + status, async () => {
    const result = await runTagScenario({ status, allowAbsent: true });
    assert.equal(result.status, 1);
  });
}
