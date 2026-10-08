import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCredentialStore } from "../dist/auth/credentials.js";

const credentialsFileName = "oauth-session.json";

async function withTemporaryStore(run) {
  const parent = await mkdtemp(path.join(tmpdir(), "understudy-auth-test-"));
  const directory = path.join(parent, ".understudy");
  try {
    await run(createCredentialStore({ directory }), directory);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("credential storage is global, private, and round-trips OAuth", async () => {
  await withTemporaryStore(async (store, directory) => {
    const credentials = {
      version: 1,
      method: "oauth",
      accessToken: ["synthetic", "access"].join("-"),
      refreshToken: ["synthetic", "refresh"].join("-"),
    };

    await store.write(credentials);

    assert.deepEqual(await store.read(), credentials);
    if (process.platform !== "win32") {
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      assert.equal(
        (await lstat(path.join(directory, credentialsFileName))).mode & 0o777,
        0o600,
      );
    }
  });
});

test("clearing authentication removes the credential file", async () => {
  await withTemporaryStore(async (store, directory) => {
    await store.write({
      version: 1,
      method: "oauth",
      accessToken: ["synthetic", "access"].join("-"),
    });

    await store.clear();

    assert.equal(await store.read(), null);
    await assert.rejects(lstat(path.join(directory, credentialsFileName)), {
      code: "ENOENT",
    });
  });
});

test(
  "a legacy state directory without an OAuth session is unauthenticated",
  { skip: process.platform === "win32" },
  async () => {
    await withTemporaryStore(async (store, directory) => {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o755);

      assert.equal(await store.read(), null);
    });
  },
);

test("invalid stored content fails without echoing it", async () => {
  await withTemporaryStore(async (store, directory) => {
    const invalidContent = "this content must not appear in an error";
    await store.write({
      version: 1,
      method: "oauth",
      accessToken: ["synthetic", "access"].join("-"),
    });
    await writeFile(path.join(directory, credentialsFileName), invalidContent);

    await assert.rejects(store.read(), (error) => {
      assert.doesNotMatch(error.message, new RegExp(invalidContent));
      return true;
    });
  });
});

test("the credential file contains only the OAuth session", async () => {
  await withTemporaryStore(async (store, directory) => {
    await store.write({
      version: 1,
      method: "oauth",
      accessToken: ["synthetic", "access"].join("-"),
    });

    const stored = JSON.parse(
      await readFile(path.join(directory, credentialsFileName), "utf8"),
    );
    assert.deepEqual(Object.keys(stored).sort(), [
      "accessToken",
      "method",
      "version",
    ]);
  });
});

test("OAuth login and logout leave application credentials untouched", async () => {
  await withTemporaryStore(async (store, directory) => {
    const applicationCredentials = path.join(directory, "credentials.json");
    const original = '{"api_key":"synthetic-application-key"}\n';
    await mkdir(directory, { mode: 0o700 });
    await writeFile(applicationCredentials, original, { mode: 0o600 });

    await store.write({
      version: 1,
      method: "oauth",
      accessToken: "synthetic-access",
    });
    await store.clear();

    assert.equal(await readFile(applicationCredentials, "utf8"), original);
  });
});

test(
  "credential operations refuse a symbolic-link session file",
  { skip: process.platform === "win32" },
  async () => {
    await withTemporaryStore(async (store, directory) => {
      const target = path.join(path.dirname(directory), "do-not-touch.json");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(target, "preserve me");
      await symlink(target, path.join(directory, credentialsFileName));

      await assert.rejects(store.read(), /authentication is unreadable/i);
      await assert.rejects(
        store.write({
          version: 1,
          method: "oauth",
          accessToken: "synthetic-access",
        }),
        /refusing to replace/i,
      );
      await assert.rejects(store.clear(), /refusing to remove/i);
      assert.equal(await readFile(target, "utf8"), "preserve me");
    });
  },
);

test(
  "credential operations refuse a symbolic-link state directory",
  { skip: process.platform === "win32" },
  async () => {
    await withTemporaryStore(async (store, directory) => {
      const target = path.join(path.dirname(directory), "other-directory");
      await mkdir(target);
      await symlink(target, directory, "dir");

      await assert.rejects(store.read(), /not a private directory/i);
      await assert.rejects(
        store.write({
          version: 1,
          method: "oauth",
          accessToken: "synthetic-access",
        }),
        /not a private directory/i,
      );
      await assert.rejects(store.clear(), /not a private directory/i);
    });
  },
);

test("credential writes refuse a non-directory state path", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "understudy-auth-test-"));
  const directory = path.join(parent, ".understudy");
  try {
    await writeFile(directory, "not a directory");
    const store = createCredentialStore({ directory });

    await assert.rejects(
      store.write({
        version: 1,
        method: "oauth",
        accessToken: "synthetic-access",
      }),
      /not a private directory/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test(
  "credential reads reject permissive POSIX storage",
  { skip: process.platform === "win32" },
  async () => {
    await withTemporaryStore(async (store, directory) => {
      await store.write({
        version: 1,
        method: "oauth",
        accessToken: "synthetic-access",
      });

      await chmod(directory, 0o755);
      await assert.rejects(store.read(), /directory is not private/i);

      await chmod(directory, 0o700);
      await chmod(path.join(directory, credentialsFileName), 0o644);
      await assert.rejects(store.read(), /file is not private/i);
    });
  },
);
