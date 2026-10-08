import { execFile } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CliError } from "../errors.js";

const execute = promisify(execFile);

export function projectDirectory(cwd: string): string {
    const start = path.resolve(cwd);
    let existingState: string | undefined;
    for (let directory = start;; directory = path.dirname(directory)) {
        if (exists(path.join(directory, ".git"))) return directory;
        if (!existingState && directory !== path.resolve(homedir()) && exists(path.join(directory, ".understudy"))) existingState = directory;
        if (path.dirname(directory) === directory) return existingState ?? start;
    }
}

// Run Git without inherited directory/index/config overrides. Never invoke hooks.
async function git(directory: string, args: string[]) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    return execute("git", ["-C", directory, ...args], { env, maxBuffer: 1024 * 1024 });
}

export async function protectProjectState(directory: string): Promise<void> {
    const repository = exists(path.join(directory, ".git"));
    if (repository) {
        const tracked = await git(directory, ["ls-files", "--cached", "-z", "--", ".understudy"]);
        if (tracked.stdout) throw new CliError("Project .understudy files are already tracked. Remove them from the Git index before writing private migration state.");
    }
    const handle = await open(path.join(directory, ".gitignore"), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new CliError("The project's .gitignore must be a regular file before preparing private migration state.");
        const text = await handle.readFile("utf8");
        // Put the rule last so earlier negations cannot expose runtime files.
        const lastRule = text.split(/\r?\n/).filter(line => line && !line.startsWith("#")).at(-1);
        if (lastRule !== "/.understudy/" && lastRule !== ".understudy/") {
            await handle.writeFile(`${text && !text.endsWith("\n") ? "\n" : ""}/.understudy/\n`);
            await handle.sync();
        }
    } finally { await handle.close(); }
    if (repository) {
        try { await git(directory, ["check-ignore", "--quiet", "--", ".understudy/migrations/private-state"]); }
        catch { throw new CliError("Git must ignore the project's .understudy directory before writing private migration state."); }
    }
}

function exists(file: string): boolean {
    try { lstatSync(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
