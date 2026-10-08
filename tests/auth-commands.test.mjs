import assert from "node:assert/strict";
import test from "node:test";

import { createCli } from "../dist/cli.js";

function createDependencies(stored = null) {
  const output = [];
  let oauthLogins = 0;
  let clears = 0;
  return {
    dependencies: {
      store: {
        read: async () => stored,
        write: async () => undefined,
        clear: async () => {
          clears += 1;
        },
      },
      output: (message) => output.push(message),
      loginWithOAuth: async (progress) => {
        oauthLogins += 1;
        progress("Synthetic OAuth progress.");
      },
    },
    output,
    get oauthLogins() {
      return oauthLogins;
    },
    get clears() {
      return clears;
    },
  };
}

async function run(command, harness) {
  await createCli(harness.dependencies).parseAsync([
    "node",
    "understudy",
    ...command,
  ]);
}

test("login uses browser OAuth", async () => {
  const harness = createDependencies();

  await run(["login"], harness);

  assert.equal(harness.oauthLogins, 1);
  assert.deepEqual(harness.output, [
    "Synthetic OAuth progress.",
    "Signed in with OAuth.",
  ]);
});

test("auth status reports only whether an OAuth session is stored", async () => {
  const signedOut = createDependencies();
  await run(["auth", "status"], signedOut);
  assert.match(signedOut.output[0], /Not authenticated/i);

  const signedIn = createDependencies({
    version: 1,
    method: "oauth",
    accessToken: ["synthetic", "access"].join("-"),
  });
  await run(["auth", "status"], signedIn);
  assert.match(signedIn.output[0], /OAuth/i);
});

test("logout removes the stored OAuth session", async () => {
  const harness = createDependencies();

  await run(["logout"], harness);

  assert.equal(harness.clears, 1);
  assert.deepEqual(harness.output, ["Logged out."]);
});

test("authentication commands support structured output", async () => {
  const harness = createDependencies({
    version: 1,
    method: "oauth",
    accessToken: ["synthetic", "access"].join("-"),
  });

  await run(["--json", "auth", "status"], harness);

  assert.deepEqual(JSON.parse(harness.output[0]), {
    authenticated: true,
    method: "oauth",
    verification: "local",
    pending: false,
    expiresAt: null,
  });
});

test("structured login is rejected before browser OAuth starts", async () => {
  const harness = createDependencies();

  await assert.rejects(
    run(["--json", "login"], harness),
    /interactive.*does not support --json/i,
  );

  assert.equal(harness.oauthLogins, 0);
  assert.deepEqual(harness.output, []);
});
