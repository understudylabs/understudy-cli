import path from "node:path";
import { createHash } from "node:crypto";
import { decodeCapture } from "./captures.js";
import { object, type CaptureIndex, type Reconstruction, type Run, type Task } from "./contracts.js";
import { completedCallKeys, interaction, outputCallKeys, type Interaction, type Message } from "./interactions.js";
import { digest, MigrationStorage } from "./storage.js";

interface Link {
    requestId: string; traceId: string | null; taskId: string | null;
    parentRequestId: string | null; previousResponseId: string | null; responseId: string | null;
    outputPrefix: string | null; retryHistory: string | null;
}
function prefixes(messages: Message[]): string[] {
    const hash = createHash("sha256"), values: string[] = [];
    for (const message of messages) { hash.update(JSON.stringify(message)).update("\n"); values.push(hash.copy().digest("hex")); }
    return values;
}

// Partitions are only candidate search spaces. The logical-task algorithm still
// resolves exact links, ambiguous histories, retries, and terminal boundaries.
export async function reconstructPartitioned(storage: MigrationStorage, run: Run, index: CaptureIndex, sourceDigest: string,
    reconstruct: (interactions: Interaction[], sourceDigest: string) => Reconstruction,
    maximumComponentBytes = 64 * 1024 * 1024): Promise<Reconstruction> {
    const base = storage.runPath(run.runId), links: Link[] = [];
    const parents = index.rows.map((_, i) => i), sizes = index.rows.map(() => 1);
    const root = (value: number): number => { let current = value; while (parents[current] !== current) { parents[current] = parents[parents[current]!]!; current = parents[current]!; } return current; };
    const union = (a: number, b: number) => { let x = root(a), y = root(b); if (x === y) return; if (sizes[x]! < sizes[y]!) [x,y] = [y,x]; parents[y] = x; sizes[x]! += sizes[y]!; };
    const read = async (position: number) => { const row = index.rows[position]!; return interaction(decodeCapture(await storage.read(path.join(base, row.file)), run.scope, row.requestId)); };
    const traces = new Set<string>(), explicitTasks = new Map<string, number>(), responses = new Map<string, number[]>();
    const outputs = new Map<string, number[]>(), retries = new Map<string, number[]>(), calls = new Map<string, number[]>();
    const add = (map: Map<string, number[]>, key: string | null, i: number) => { if (key) { const entries = map.get(key); if (entries) entries.push(i); else map.set(key, [i]); } };
    const scoped = (traceId: string | null, hash: string) => JSON.stringify([traceId, hash]);
    const joinKey = (map: Map<string, number>, key: string | null, i: number) => { if (key) { const first = map.get(key); if (first !== undefined) union(first, i); else map.set(key, i); } };
    for (let i = 0; i < index.rows.length; i++) {
        const row = await read(i);
        const canParent = !row.terminal && (row.traceId !== null || row.output.some(message => message.content.some(block => object(block).type === "call")));
        const outputPrefix = canParent && !row.streamDiagnostic ? prefixes([...row.history, ...row.output]).at(-1) ?? null : null;
        const retryHistory = canParent && row.failed ? prefixes(row.history).at(-1) ?? null : null;
        links.push({ requestId: row.requestId, traceId: row.traceId, taskId: row.explicitTaskId, parentRequestId: row.parentRequestId, previousResponseId: row.previousResponseId, responseId: row.responseId, outputPrefix, retryHistory });
        if (row.traceId) traces.add(row.traceId);
        joinKey(explicitTasks, row.explicitTaskId, i); add(responses, row.responseId, i);
        add(outputs, outputPrefix ? scoped(row.traceId, outputPrefix) : null, i); add(retries, retryHistory ? scoped(row.traceId, retryHistory) : null, i);
        if (!row.terminal && !row.streamDiagnostic) for (const key of outputCallKeys(row.output)) add(calls, scoped(row.traceId, digest(key)), i);
    }
    const requests = new Map(links.map((link, i) => [link.requestId, i]));
    for (const [i, link] of links.entries()) {
        if (link.parentRequestId && requests.has(link.parentRequestId)) union(i, requests.get(link.parentRequestId)!);
        if (link.previousResponseId) for (const parent of responses.get(link.previousResponseId) ?? []) union(i, parent);
        if (outputs.size || retries.size || calls.size) {
            const row = await read(i), history = prefixes(row.history);
            for (const value of history.slice(0, -1)) for (const parent of outputs.get(scoped(link.traceId, value)) ?? []) union(i, parent);
            for (const parent of retries.get(scoped(link.traceId, history.at(-1) ?? "")) ?? []) union(i, parent);
            for (const key of completedCallKeys(row.history)) for (const parent of calls.get(scoped(link.traceId, digest(key))) ?? []) union(i, parent);
        }
    }
    const components = new Map<number, number[]>();
    for (let i = 0; i < links.length; i++) { const key = root(i), group = components.get(key); if (group) group.push(i); else components.set(key, [i]); }
    const tasks: Task[] = [], unresolved: Reconstruction["unresolved"] = [];
    for (const component of components.values()) {
        if (component.reduce((sum, i) => sum + index.rows[i]!.bytes, 0) > maximumComponentBytes) {
            unresolved.push({ requestIds: component.map(i => index.rows[i]!.requestId), technicalCauses: ["reconstruction_component_exceeds_memory_budget"] }); continue;
        }
        const input: Interaction[] = [];
        for (const i of component) input.push(await read(i));
        const reconstructed = reconstruct(input, sourceDigest);
        unresolved.push(...reconstructed.unresolved);
        for (const task of reconstructed.tasks) {
            const content = Buffer.from(JSON.stringify(task)), sha256 = digest(content), file = `tasks/${sha256}.json`;
            await storage.write(path.join(base, file), content);
            tasks.push({ ...task, detail: { file, sha256, bytes: content.length }, terminalResponse: undefined,
                turns: task.turns.map(({ messages, response, rawResponse, ...turn }) => turn),
                exchanges: task.exchanges.map(exchange => ({ ...exchange, arguments: undefined, result: undefined, record: { file, sha256 } })),
            });
        }
    }
    tasks.sort((a,b) => a.id.localeCompare(b.id));
    unresolved.sort((a,b) => a.requestIds[0]!.localeCompare(b.requestIds[0]!));
    const result: Reconstruction = { schemaVersion: 2, sourceDigest, taskDigest: digest(JSON.stringify(tasks)), requests: index.rows.length, traceCount: traces.size, tasks, unresolved };
    await storage.writeJson(path.join(base, "tasks.json"), result);
    return result;
}
