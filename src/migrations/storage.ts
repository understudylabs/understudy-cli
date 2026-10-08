import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { runSchema, type Run } from "./contracts.js";
import { projectDirectory, protectProjectState } from "./project.js";
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export class MigrationStorage {
    readonly root: string;
    readonly project: string;
    private protection?: Promise<void>;
    constructor(cwd = process.cwd()) {
        this.project = projectDirectory(cwd);
        this.root = path.join(this.project, ".understudy");
    }
    runPath(runId: string): string {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(runId))
            throw new CliError("Use a run id containing only letters, digits, underscores, or hyphens.");
        return path.join(this.root, "migrations", runId);
    }
    async check(file: string, createParents = false): Promise<string> {
        const absolute = path.resolve(file);
        const relative = path.relative(this.root, absolute);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new CliError("Migration inputs and outputs must be inside the project's .understudy private state.");
        try {
            if ((await lstat(this.root)).isSymbolicLink()) throw new CliError("Migration state cannot use symlinks.");
        } catch (error) { if (!missing(error)) throw error; }
        await (this.protection ??= protectProjectState(this.project));
        const parts = relative ? relative.split(path.sep) : [];
        for (let index = 0; index <= parts.length; index++) {
            const current = path.join(this.root, ...parts.slice(0, index));
            const directory = index < parts.length;
            let entry;
            try {
                entry = await lstat(current);
            }
            catch (error) {
                if (!missing(error))
                    throw error;
                if (createParents && (directory || current === this.root)) {
                    try { await mkdir(current, { mode: 0o700 }); }
                    catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") throw creationError; }
                    entry = await lstat(current);
                }
                else
                    continue;
            }
            if (entry.isSymbolicLink() || (directory && !entry.isDirectory()) || (!entry.isFile() && !entry.isDirectory()))
                throw new CliError("Migration paths must be regular private files or directories, without symlinks.");
            if (process.platform !== "win32" && ((entry.mode & 0o777) !== (entry.isDirectory() ? 0o700 : 0o600) || entry.uid !== process.getuid?.()))
                throw new CliError("Migration state must be owner-only: directories 0700 and files 0600.");
            if (entry.isDirectory()) {
                try {
                    await lstat(path.join(current, ".git"));
                    throw new CliError("Migration state must be outside source repositories.");
                }
                catch (error) {
                    if (!missing(error))
                        throw error;
                }
            }
        }
        return absolute;
    }
    async read(file: string, maxBytes?: number): Promise<Buffer> {
        const target = await this.check(file);
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1)
                throw new CliError("Migration inputs must be regular files with a single link.");
            if (maxBytes !== undefined && info.size > maxBytes)
                throw new CliError("Capture integrity verification exceeded its declared byte size.");
            return await handle.readFile();
        }
        finally {
            await handle.close();
        }
    }
    async json(file: string): Promise<unknown> {
        try {
            return JSON.parse((await this.read(file)).toString("utf8"));
        }
        catch (error) {
            if (error instanceof CliError)
                throw error;
            throw new CliError("A required private migration artifact is missing or invalid.");
        }
    }
    async write(file: string, value: string | Uint8Array): Promise<void> {
        const target = await this.check(file, true);
        const temporary = path.join(path.dirname(target), `.write-${randomUUID()}`);
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(value);
            await handle.sync();
            await handle.close();
            await rename(temporary, target);
        }
        finally {
            await handle.close().catch(() => undefined);
            await rm(temporary, { force: true });
        }
    }
    async writeJson(file: string, value: unknown): Promise<void> { await this.write(file, `${JSON.stringify(value, null, 2)}\n`); }
    async readRun(id: string): Promise<Run> {
        const run = runSchema.parse(await this.json(path.join(this.runPath(id), "run.json")));
        if (run.runId !== id)
            throw new CliError("Migration run identity does not match its directory.");
        return run;
    }
    async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
        this.protection = undefined;
        const lock = await this.check(path.join(this.runPath(id), ".lock"), true);
        let handle;
        try {
            handle = await open(lock, "wx", 0o600);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
                throw new CliError("This run is already in use. If interrupted, inspect and remove its private .lock file before retrying.");
            throw error;
        }
        try {
            return await operation();
        }
        finally {
            await handle.close();
            await rm(lock);
        }
    }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
