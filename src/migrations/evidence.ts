import path from "node:path";
import { object, type Reconstruction, type Run } from "./contracts.js";
import { planFixtures } from "./fixtures.js";
import { readReconstruction } from "./reconstruct.js";
import { digest, MigrationStorage } from "./storage.js";

async function optional(storage: MigrationStorage, file: string) {
    try { return object(await storage.json(file)); }
    catch (error) {
        // Check absence separately: malformed evidence must never become an empty inventory.
        try { await storage.read(file); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return {}; }
        throw error;
    }
}
export async function captureEvidence(storage: MigrationStorage, run: Run, reconstruction?: Reconstruction) {
    const base = storage.runPath(run.runId), tasks = reconstruction ?? await readReconstruction(storage, run);
    const fixtures = await planFixtures(storage, run, tasks);
    const inventory = await optional(storage, path.join(base, "inventory.json"));
    const coverage = await optional(storage, path.join(base, "export-coverage.json"));
    const captures = object(await storage.json(path.join(base, "captures.json")));
    const current = coverage.sourceDigest === tasks.sourceDigest && coverage.inventoryDigest === (Object.keys(inventory).length ? digest(await storage.read(path.join(base, "inventory.json"))) : null);
    const rows = Array.isArray(inventory.rows) ? inventory.rows.map(object) : null;
    const seen = new Set(tasks.tasks.flatMap(t => t.requestIds).concat(tasks.unresolved.flatMap(g => g.requestIds)));
    const missing = rows?.filter(row => !seen.has(String(row.request_id))).map(row => row.request_id) ?? null;
    const windowCurrent = current && Boolean(run.captureWindow) && JSON.stringify(coverage.window) === JSON.stringify(run.captureWindow);
    const gaps = (current && coverage.completeForInventory === false) || (windowCurrent && coverage.completeForWindow === false) || (missing?.length ?? 0) > 0 || Number(inventory.skippedMalformed ?? 0) > 0 || tasks.unresolved.length > 0 || tasks.tasks.some(t => !t.complete) || (Array.isArray(captures.gaps) && captures.gaps.length > 0);
    const evidence = { schemaVersion: 1, runId: run.runId, sourceDigest: tasks.sourceDigest, taskDigest: tasks.taskDigest,
        status: tasks.requests === 0 ? (rows?.length === 0 && !inventory.skippedMalformed) || (windowCurrent && coverage.completeForWindow === true && coverage.indexedRequests === 0) ? "no_captures" : "needs_capture_evidence" : gaps ? "captured_with_gaps" : "captured",
        counts: { requests: tasks.requests, traces: tasks.traceCount, tasks: tasks.tasks.length, completeTasks: tasks.tasks.filter(t => t.complete).length, incompleteTasks: tasks.tasks.filter(t => !t.complete).length, unresolvedGroups: tasks.unresolved.length, fixturesRequired: fixtures.required, fixturesUsable: fixtures.usable },
        coverage: { inventoryRequests: rows?.length ?? null, missingInventoryRequests: missing, inventorySizeMismatches: current ? coverage.sizeMismatches ?? [] : null, skippedMalformed: inventory.skippedMalformed ?? null, sourceGaps: captures.gaps ?? [], completeForInventory: current ? coverage.completeForInventory : null, snapshotIsolation: false, fullLifetimeProven: false,
            ...(run.captureWindow ? { window: run.captureWindow, indexedRequests: windowCurrent ? coverage.indexedRequests : null, completeForWindow: windowCurrent ? coverage.completeForWindow : null } : {}) },
        integrity: { localHashesVerified: true, serverDigestVerified: false, sourceTrust: captures.provenance === "hosted_export" ? "authenticated_management_manifest_and_https_storage" : "private_import_index" },
        unresolved: tasks.unresolved,
        artifacts: Object.fromEntries(["capture-evidence.json", "tasks.json", "tool-fixture-plan.json"].map(name => [name, path.join(base, name)])) };
    await storage.writeJson(path.join(base, "capture-evidence.json"), evidence);
    return evidence;
}
