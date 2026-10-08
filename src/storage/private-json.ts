import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { CliError } from "../errors.js";

export interface PrivateJsonStore<T> {
  read(): Promise<T | null>;
  write(value: T): Promise<void>;
  clear(): Promise<void>;
}

interface PrivateJsonStoreOptions<T> {
  directory: string;
  fileName: string;
  label: string;
  schema: z.ZodType<T>;
}

export function createPrivateJsonStore<T>(
  options: PrivateJsonStoreOptions<T>,
): PrivateJsonStore<T> {
  const directory = path.resolve(options.directory);
  const filePath = path.join(directory, options.fileName);

  return {
    async read() {
      const directoryEntry = await inspectPath(directory);
      if (!directoryEntry) return null;
      assertPrivateDirectory(directoryEntry);

      const storedEntry = await inspectPath(filePath);
      if (!storedEntry) return null;

      assertPrivatePermissions(
        directoryEntry,
        0o700,
        `Stored ${options.label} directory is not private. Set its permissions to 0700 and retry.`,
      );

      let handle;
      try {
        handle = await open(
          filePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const entry = await handle.stat();
        if (!entry.isFile()) {
          throw new CliError(
            `Stored ${options.label} is not a regular private file. Remove it and retry.`,
          );
        }
        assertPrivatePermissions(
          entry,
          0o600,
          `Stored ${options.label} file is not private. Set its permissions to 0600 and retry.`,
        );
        return options.schema.parse(
          JSON.parse(await handle.readFile("utf8")),
        );
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return null;
        if (error instanceof CliError) throw error;
        throw new CliError(`Stored ${options.label} is unreadable. Remove it and retry.`);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    async write(value) {
      const parsed = options.schema.parse(value);
      await ensurePrivateDirectory(directory);

      const current = await inspectPath(filePath);
      if (current && (!current.isFile() || current.isSymbolicLink())) {
        throw new CliError(
          `Refusing to replace ${options.label} storage that is not a regular file.`,
        );
      }

      const temporaryPath = path.join(
        directory,
        `.${options.fileName}.${process.pid}.${randomUUID()}`,
      );
      let handle;
      try {
        handle = await open(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await makePrivate(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    },

    async clear() {
      const directoryEntry = await inspectPath(directory);
      if (!directoryEntry) return;
      assertPrivateDirectory(directoryEntry);

      const entry = await inspectPath(filePath);
      if (!entry) return;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new CliError(
          `Refusing to remove ${options.label} storage that is not a regular file.`,
        );
      }
      await unlink(filePath);
    },
  };
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
  const entry = await lstat(directory);
  assertPrivateDirectory(entry);
  await makePrivate(directory, 0o700);
}

function assertPrivateDirectory(entry: import("node:fs").Stats): void {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new CliError(
      "Understudy's global state path is not a private directory.",
    );
  }
}

function assertPrivatePermissions(
  entry: import("node:fs").Stats,
  expectedMode: number,
  message: string,
): void {
  if (process.platform !== "win32" && (entry.mode & 0o777) !== expectedMode) {
    throw new CliError(message);
  }
}

async function inspectPath(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

async function makePrivate(filePath: string, mode: number): Promise<void> {
  if (process.platform !== "win32") await chmod(filePath, mode);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
