import path from "node:path";
import { CliError } from "../errors.js";
import type { Reconstruction, Run, Task } from "./contracts.js";
import { canonical } from "./interactions.js";
import { readReconstruction } from "./reconstruct.js";
import { digest, MigrationStorage } from "./storage.js";

function toolsOf(task: Task): string[] { return [...new Set(task.exchanges.map(exchange => exchange.toolName).filter(Boolean))].sort(); }
function counted(values: string[]) {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].map(([value, count]) => ({ value, count })).sort((a,b) => b.count - a.count || a.value.localeCompare(b.value));
}
export interface TaskQuery { limit?: number; cursor?: string; tool?: string; cause?: string; complete?: boolean }
export function queryTasks(reconstruction: Reconstruction, query: TaskQuery = {}) {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CliError("Choose a task page size between 1 and 100.");
    const filter = { tool: query.tool ?? null, cause: query.cause ?? null, complete: query.complete ?? null };
    const queryDigest = digest(canonical({ taskDigest: reconstruction.taskDigest, filter }));
    let offset = 0;
    if (query.cursor) {
        try {
            if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
            const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
            if (parsed.queryDigest !== queryDigest || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error();
            offset = parsed.offset;
        } catch { throw new CliError("The task cursor is invalid or belongs to different evidence or filters. Start a new task listing."); }
    }
    const selected = reconstruction.tasks.filter(task => (filter.complete === null || task.complete === filter.complete)
        && (!filter.tool || task.exchanges.some(exchange => exchange.toolName === filter.tool))
        && (!filter.cause || task.technicalCauses.includes(filter.cause))).sort((a,b) => a.id.localeCompare(b.id));
    if (offset > selected.length) throw new CliError("The task cursor is outside this result set.");
    const tasks = selected.slice(offset, offset + limit).map(task => ({
        id: task.id, requests: task.requestIds.length, turns: task.turns.length, complete: task.complete, confidence: task.confidence,
        observedTools: toolsOf(task), fixtures: { required: task.exchanges.length, usable: task.exchanges.filter(exchange => exchange.hasResult && !exchange.technicalCauses.length).length },
        technicalCauses: task.technicalCauses,
    }));
    return { schemaVersion: 1, taskDigest: reconstruction.taskDigest, totalTasks: reconstruction.tasks.length, matchedTasks: selected.length, filter, tasks,
        nextCursor: offset + limit < selected.length ? Buffer.from(JSON.stringify({ queryDigest, offset: offset + limit })).toString("base64url") : null };
}
export async function profileTasks(storage: MigrationStorage, run: Run) {
    const reconstruction = await readReconstruction(storage, run), tasks = reconstruction.tasks;
    const groups = new Map<string, { tools: string[]; taskCount: number; completeTasks: number; representativeTaskIds: string[] }>();
    for (const task of [...tasks].sort((a,b) => a.id.localeCompare(b.id))) {
        const tools = toolsOf(task), key = canonical(tools);
        const group = groups.get(key) ?? { tools, taskCount: 0, completeTasks: 0, representativeTaskIds: [] };
        group.taskCount++; if (task.complete) group.completeTasks++;
        if (group.representativeTaskIds.length < 3) group.representativeTaskIds.push(task.id);
        groups.set(key, group);
    }
    const toolSets = [...groups.values()].sort((a,b) => b.taskCount - a.taskCount || canonical(a.tools).localeCompare(canonical(b.tools)));
    const result = { schemaVersion: 1, taskDigest: reconstruction.taskDigest, requests: reconstruction.requests, traces: reconstruction.traceCount,
        tasks: tasks.length, completeTasks: tasks.filter(task => task.complete).length,
        unresolvedGroups: reconstruction.unresolved.length, unresolvedRequests: reconstruction.unresolved.reduce((sum, group) => sum + group.requestIds.length, 0),
        toolsByTaskCount: counted(tasks.flatMap(toolsOf)), turnsPerTask: counted(tasks.map(task => String(task.turns.length))),
        technicalCauses: counted(tasks.flatMap(task => task.technicalCauses)), unresolvedCauses: counted(reconstruction.unresolved.flatMap(group => group.technicalCauses)),
        observedToolSets: toolSets,
        interpretation: "Structural observations across all reconstructed tasks. Tool sets are inspection facets, not task clusters or success judgments.",
    };
    const artifact = path.join(storage.runPath(run.runId), "task-profile.json");
    await storage.writeJson(artifact, result);
    return { ...result, observedToolSets: toolSets.slice(0, 20), omittedToolSets: Math.max(0, toolSets.length - 20), artifact };
}
