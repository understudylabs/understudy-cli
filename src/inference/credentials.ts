import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  createPrivateJsonStore,
  ensurePrivateDirectory,
  type PrivateJsonStore,
} from "../storage/private-json.js";
import { CliError } from "../errors.js";

// Keep the PR3 file name and field on disk so existing setup remains valid.
const credentialFileName = "gateway-credential.json";
const setupLockFileName = "gateway-setup.lock";

const storedInferenceCredentialSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.string().min(1),
    keyId: z.string().min(1),
    apiKey: z.string().min(1),
    gatewayUrl: z.string().url(),
  })
  .strict();

const setupLockOwnerSchema = z
  .object({
    version: z.literal(1),
    hostname: z.string().min(1),
    pid: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

const setupLockMaxBytes = 1_024;

interface SetupLockIdentity {
  dev: number;
  ino: number;
}

type ExistingSetupLock =
  | { identity: SetupLockIdentity; reclaimable: boolean }
  | null;

export interface InferenceCredential {
  version: 1;
  organizationId: string;
  keyId: string;
  apiKey: string;
  inferenceUrl: string;
}

export interface InferenceCredentialStore
  extends PrivateJsonStore<InferenceCredential> {
  withSetupLock<T>(operation: () => Promise<T>): Promise<T>;
}

interface InferenceCredentialStoreOptions {
  directory?: string;
}

export function createInferenceCredentialStore(
  options: InferenceCredentialStoreOptions = {},
): InferenceCredentialStore {
  const directory = path.resolve(
    options.directory ?? path.join(homedir(), ".understudy"),
  );
  const storedCredentials = createPrivateJsonStore({
    directory,
    fileName: credentialFileName,
    label: "inference credential",
    schema: storedInferenceCredentialSchema,
  });
  const lockPath = path.join(directory, setupLockFileName);

  return {
    async read() {
      const stored = await storedCredentials.read();
      return stored === null
        ? null
        : {
            version: stored.version,
            organizationId: stored.organizationId,
            keyId: stored.keyId,
            apiKey: stored.apiKey,
            inferenceUrl: stored.gatewayUrl,
          };
    },
    async write(credential) {
      await storedCredentials.write({
        version: credential.version,
        organizationId: credential.organizationId,
        keyId: credential.keyId,
        apiKey: credential.apiKey,
        gatewayUrl: credential.inferenceUrl,
      });
    },
    clear: storedCredentials.clear,
    async withSetupLock(operation) {
      await ensurePrivateDirectory(directory);

      let identity: SetupLockIdentity;
      try {
        identity = await acquireSetupLock(directory, lockPath);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(
          "Inference setup could not acquire its private lock. Check local storage and retry.",
        );
      }

      try {
        return await operation();
      } finally {
        await removeSetupLock(lockPath, identity);
      }
    },
  };
}

async function acquireSetupLock(
  directory: string,
  lockPath: string,
): Promise<SetupLockIdentity> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const identity = await tryCreateSetupLock(directory, lockPath);
    if (identity) return identity;

    const existing = await inspectSetupLock(lockPath);
    if (!existing) continue;
    if (!existing.reclaimable) {
      throw new CliError(
        "Inference setup is already running. Wait for it to finish and retry.",
      );
    }
    await removeSetupLock(lockPath, existing.identity);
  }

  throw new Error("The inference setup lock changed while it was acquired.");
}

async function tryCreateSetupLock(
  directory: string,
  lockPath: string,
): Promise<SetupLockIdentity | null> {
  const candidatePath = path.join(
    directory,
    `.${setupLockFileName}.${process.pid}.${randomUUID()}`,
  );
  try {
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        version: 1,
        hostname: hostname(),
        pid: process.pid,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    if (process.platform !== "win32") await chmod(candidatePath, 0o600);

    try {
      await link(candidatePath, lockPath);
      return lockIdentity(await lstat(lockPath));
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) return null;
      throw error;
    }
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function inspectSetupLock(lockPath: string): Promise<ExistingSetupLock> {
  let entry: Stats;
  try {
    entry = await lstat(lockPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }

  const identity = lockIdentity(entry);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size > setupLockMaxBytes ||
    (process.platform !== "win32" && (entry.mode & 0o777) !== 0o600)
  ) {
    return { identity, reclaimable: true };
  }

  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!sameLock(identity, lockIdentity(await handle.stat()))) return null;

    let owner: z.infer<typeof setupLockOwnerSchema>;
    try {
      owner = setupLockOwnerSchema.parse(
        JSON.parse(await handle.readFile("utf8")),
      );
    } catch {
      return { identity, reclaimable: true };
    }

    return {
      identity,
      reclaimable:
        owner.hostname === hostname() && processIsDefinitelyGone(owner.pid),
    };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ELOOP")) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function processIsDefinitelyGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isFileSystemError(error, "ESRCH");
  }
}

async function removeSetupLock(
  lockPath: string,
  expected: SetupLockIdentity,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(lockPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  if (!sameLock(expected, lockIdentity(current))) return;
  await unlink(lockPath).catch((error: unknown) => {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  });
}

function lockIdentity(entry: Stats): SetupLockIdentity {
  return { dev: entry.dev, ino: entry.ino };
}

function sameLock(
  left: SetupLockIdentity,
  right: SetupLockIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
