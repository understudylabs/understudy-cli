import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createInferenceCredentialStore } from "../dist/inference/credentials.js";

const legacyCredentialFileName = "gateway-credential.json";
const legacyLockFileName = "gateway-setup.lock";

test("inference credentials preserve private PR3 storage", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "understudy-inference-test-"));
  const directory = path.join(parent, ".understudy");
  const oauthPath = path.join(directory, "oauth-session.json");
  const credential = {
    version: 1,
    organizationId: "synthetic-organization",
    keyId: "synthetic-key",
    apiKey: ["synthetic", "workload", "credential"].join("-"),
    inferenceUrl: "https://example.test",
  };

  try {
    const store = createInferenceCredentialStore({ directory });
    await store.write(credential);
    await writeFile(oauthPath, "synthetic OAuth state", { mode: 0o600 });

    assert.deepEqual(await store.read(), credential);
    if (process.platform !== "win32") {
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      assert.equal(
        (await lstat(path.join(directory, legacyCredentialFileName))).mode &
          0o777,
        0o600,
      );
    }
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(directory, legacyCredentialFileName), "utf8"),
      ),
      {
        version: 1,
        organizationId: "synthetic-organization",
        keyId: "synthetic-key",
        apiKey: credential.apiKey,
        gatewayUrl: credential.inferenceUrl,
      },
    );

    await store.clear();
    assert.equal(await store.read(), null);
    assert.equal(await readFile(oauthPath, "utf8"), "synthetic OAuth state");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("inference setup lock is private, rejects a live owner, and is released", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "understudy-lock-test-"));
  const directory = path.join(parent, ".understudy");
  const store = createInferenceCredentialStore({ directory });
  const operationError = new Error("synthetic setup failure");

  try {
    await assert.rejects(
      store.withSetupLock(async () => {
        if (process.platform !== "win32") {
          assert.equal(
            (await lstat(path.join(directory, legacyLockFileName))).mode &
              0o777,
            0o600,
          );
        }
        await assert.rejects(
          store.withSetupLock(async () => undefined),
          /already running/i,
        );
        throw operationError;
      }),
      operationError,
    );

    await store.withSetupLock(async () => undefined);
    await assert.rejects(
      lstat(path.join(directory, legacyLockFileName)),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("inference setup reclaims a stale same-host owner lock", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "understudy-stale-lock-test-"));
  const directory = path.join(parent, ".understudy");
  const lockPath = path.join(directory, legacyLockFileName);
  const store = createInferenceCredentialStore({ directory });

  try {
    await store.withSetupLock(async () => undefined);

    const exitedProcess = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const stalePid = exitedProcess.pid;
    assert.ok(stalePid);
    await once(exitedProcess, "exit");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        hostname: hostname(),
        pid: stalePid,
      })}\n`,
      { mode: 0o600 },
    );

    await store.withSetupLock(async () => {
      const owner = JSON.parse(await readFile(lockPath, "utf8"));
      assert.equal(owner.hostname, hostname());
      assert.equal(owner.pid, process.pid);
    });
    await assert.rejects(
      lstat(lockPath),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
