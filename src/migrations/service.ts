import path from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.js";
import { exportDay, exportInventory, exportWindow, importCaptures, inventoryCaptures, readIndex, selectCaptureWindow, verifyCaptures, type CaptureSelection, type CaptureProgress } from "./captures.js";
import { scopeSchema, type Run } from "./contracts.js";
import { captureEvidence } from "./evidence.js";
import { reconstruct, readReconstruction, readTask } from "./reconstruct.js";
import { runHarness, type HarnessInput } from "./harness.js";
import type { ExecutionOptions } from "./transport.js";

import { profileTasks, queryTasks, type TaskQuery } from "./inspection.js";
import { migrationSession, resolveScope, validateScopeInput, type ScopeOptions, type SessionOptions } from "./scope.js";
import { MigrationStorage } from "./storage.js";
export interface MigrationOptions extends SessionOptions, ExecutionOptions {
    cwd?: string;
    onCaptureProgress?: (event: CaptureProgress) => void;
}
export function createMigrationService(options: MigrationOptions = {}) {
    const storage = new MigrationStorage(options.cwd);
    const session = () => migrationSession(options);
    async function operation<T>(runId: string, action: (run: Run) => Promise<T>): Promise<T> {
        await storage.readRun(runId);
        return storage.locked(runId, async () => action(await storage.readRun(runId)));
    }
    async function init(input: ScopeOptions & CaptureSelection & {
        runId?: string;
    }) {
        validateScopeInput(input);
        const captureWindow = selectCaptureWindow(input);
        const runId = input.runId ?? `mapping-${randomUUID()}`;
        const base = storage.runPath(runId);
        return storage.locked(runId, async () => {
            try {
                await storage.read(path.join(base, "run.json"));
                throw new CliError("That run already exists. Resume the saved migration to inspect it.");
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
            const scope = await resolveScope(input, await session());
            const run: Run = { schemaVersion: 1, runId, createdAt: new Date().toISOString(), scope, mode: "mapping_only", ...(captureWindow ? { captureWindow } : {}) };
            await storage.writeJson(path.join(base, "scope.json"), scope);
            await storage.writeJson(path.join(base, "run.json"), run);
            return { ...run, directory: base, nextCommand: `understudy migrate --project ${scope.project.id} --workload ${scope.workload.id} --resume ${runId} --json` };
        });
    }
    return {
        init,
        async importRun(input: { scope: string; index: string; runId?: string }) {
            const parsed = scopeSchema.safeParse(await storage.json(input.scope));
            if (!parsed.success) throw new CliError("Provide an exact organization, project, and workload scope with the private export.");
            const scope = parsed.data, runId = input.runId ?? `mapping-${randomUUID()}`, base = storage.runPath(runId);
            return storage.locked(runId, async () => {
                try { await storage.read(path.join(base, "run.json")); throw new CliError("That run already exists. Choose a unique run id."); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                const run: Run = { schemaVersion: 1, runId, createdAt: new Date().toISOString(), scope, scopeOrigin: "private_export", mode: "mapping_only" };
                await storage.writeJson(path.join(base, "scope.json"), scope); await storage.writeJson(path.join(base, "run.json"), run);
                const imported = await importCaptures(storage, run, input.index);
                return { ...run, ...imported, directory: base, liveScopeVerified: false, nextCommand: `understudy migrate --project ${scope.project.id} --workload ${scope.workload.id} --resume ${runId} --json` };
            });
        },
        async migrate(input: ScopeOptions & CaptureSelection & { resume?: string }) {
            validateScopeInput(input);
            if (input.resume && [input.lastDays, input.from, input.to].some(value => value !== undefined))
                throw new CliError("Resume uses the run's saved date range. Omit --last-days, --from, and --to.");
            const run = input.resume ? await storage.readRun(input.resume) : await init(input);
            const resumeCommand = `understudy migrate --project ${shellWord(run.scope.project.id)} --workload ${shellWord(run.scope.workload.id)} --resume ${shellWord(run.runId)}`;
            try {
                return await operation(run.runId, async (saved) => {
                    const activeSession = saved.scopeOrigin === "private_export" ? null : await session();
                    if (input.resume && activeSession) {
                        const scope = await resolveScope(input, activeSession);
                        if (scope.organization.id !== saved.scope.organization.id || scope.project.id !== saved.scope.project.id || scope.workload.id !== saved.scope.workload.id)
                            throw new CliError("The selected workload does not match the saved migration run.");
                    }
                    if (!activeSession && (!([saved.scope.project.id, saved.scope.project.slug, saved.scope.project.name].includes(input.project)) || ![saved.scope.workload.id, saved.scope.workload.name].includes(input.workload) || (input.org && input.org !== saved.scope.organization.id))) throw new CliError("The selectors do not match the imported workload scope.");
                    let imported = false;
                    try {
                        await storage.read(path.join(storage.runPath(saved.runId), "captures.json"));
                        imported = (await readIndex(storage, saved)).provenance === "private_import";
                    }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                    if (!imported) {
                        if (!activeSession) throw new CliError("Import the capture index before mapping this private export.");
                        // A partial captures.json is not proof that every export day completed.
                        if (saved.captureWindow) await exportWindow(storage, saved, activeSession, options.fetchImplementation, options.onCaptureProgress);
                        else await exportInventory(storage, saved, activeSession, options.fetchImplementation, options.onCaptureProgress);
                    }
                    const index = await readIndex(storage, saved);
                    options.onCaptureProgress?.({ phase: "reconstruct", saved: index.rows.length, bytes: index.rows.reduce((sum, row) => sum + row.bytes, 0), unavailable: index.gaps.length });
                    const reconstruction = await reconstruct(storage, saved);
                    const evidence = await captureEvidence(storage, saved, reconstruction);
                    return { ...evidence, runId: saved.runId, directory: storage.runPath(saved.runId), resumeCommand };
                });
            } catch (error) {
                const message = error instanceof CliError ? error.message : "The migration could not finish preparing its captured interactions.";
                throw new CliError(`${message} Saved run: ${run.runId}. Resume with: ${resumeCommand}`);
            }
        },
        inventory: (runId: string) => operation(runId, async (run) => inventoryCaptures(storage, run, await session())),
        export: (runId: string, date: string) => operation(runId, async (run) => exportDay(storage, run, date, await session(), options.fetchImplementation)),
        exportAll: (runId: string) => operation(runId, async (run) => exportInventory(storage, run, await session(), options.fetchImplementation)),
        import: (runId: string, index: string) => operation(runId, (run) => importCaptures(storage, run, index)),
        verify: (runId: string) => operation(runId, async (run) => {
            const result = await verifyCaptures(storage, run);
            return { verified: result.index.rows.length, sourceDigest: result.sourceDigest, gaps: result.index.gaps };
        }),
        reconstruct: (runId: string) => operation(runId, async (run) => {
            const result = await reconstruct(storage, run);
            return { requests: result.requests, tasks: result.tasks.length, unresolvedGroups: result.unresolved.length, taskDigest: result.taskDigest, artifact: path.join(storage.runPath(runId), "tasks.json") };
        }),
        evidence: (runId: string) => operation(runId, run => captureEvidence(storage, run)),
        prepareCaptures: (runId: string) => operation(runId, async run => captureEvidence(storage, run, await reconstruct(storage, run))),
        profile: (runId: string) => operation(runId, run => profileTasks(storage, run)),
        tasks: (runId: string, query: TaskQuery = {}) => operation(runId, async run => queryTasks(await readReconstruction(storage, run), query)),
        inspect: (runId: string, taskId: string) => operation(runId, async run => {
            const reconstruction = await readReconstruction(storage, run);
            const task = reconstruction.tasks.find(t => t.id === taskId);
            if (!task) throw new CliError("That task is not present in this reconstruction.");
            return { taskDigest: reconstruction.taskDigest, task: await readTask(storage, run, task) };
        }),
        replay: (runId: string, input: HarnessInput, target?: { project: string; workload: string }) => operation(runId, run => runHarness(storage, run, input, { ...options, target: target ?? options.target })),
    };
}
export type MigrationService = ReturnType<typeof createMigrationService>;

export function executionTarget(input: { targetProject?: string; targetWorkload?: string }) {
    if (Boolean(input.targetProject) !== Boolean(input.targetWorkload)) throw new CliError("Supply both execution target project and workload.");
    return input.targetProject && input.targetWorkload ? { project: input.targetProject, workload: input.targetWorkload } : undefined;
}

function shellWord(value: string): string {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
