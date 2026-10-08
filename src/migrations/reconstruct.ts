import path from "node:path";
import { CliError } from "../errors.js";
import { decodeCapture, verifyCaptures } from "./captures.js";
import { reconstructPartitioned } from "./partition.js";
import { object, type Exchange, type Reconstruction, type Run, type Task } from "./contracts.js";
import { canonical, completedCallKeys, interaction, outputCallKeys, parseArguments, type Interaction, type Message } from "./interactions.js";
import { digest, MigrationStorage } from "./storage.js";
export async function reconstruct(storage: MigrationStorage, run: Run): Promise<Reconstruction> {
    const { index, sourceDigest } = await verifyCaptures(storage, run);
    if (index.rows.reduce((sum, row) => sum + row.bytes, 0) > 32 * 1024 * 1024)
        return reconstructPartitioned(storage, run, index, sourceDigest, reconstructInteractions);
    const input: Interaction[] = [];
    for (const row of index.rows)
        input.push(interaction(decodeCapture(await storage.read(path.join(storage.runPath(run.runId), row.file)), run.scope, row.requestId)));
    const result = reconstructInteractions(input, sourceDigest);
    await storage.writeJson(path.join(storage.runPath(run.runId), "tasks.json"), result);
    return result;
}
export function reconstructInteractions(input: Interaction[], sourceDigest: string): Reconstruction {
    input.sort((a, b) => (Number.isFinite(a.timestamp) ? a.timestamp : 0) - (Number.isFinite(b.timestamp) ? b.timestamp : 0) || a.requestId.localeCompare(b.requestId));
    const groups: Interaction[][] = [];
    const owner = new Map<string, number>();
    const responses = new Map<string, Interaction[]>();
    for (const row of input) {
        if (row.responseId) responses.set(row.responseId, [...(responses.get(row.responseId) ?? []), row]);
    }
    const byRequest = new Map(input.map((i) => [i.requestId, i]));
    const unresolved: Reconstruction["unresolved"] = [];
    const retryParents = new Map<string, string>();
    const outputCalls = new Map(input.map(row => [row, row.streamDiagnostic ? [] : outputCallKeys(row.output)]));
    const explicitParent = (row: Interaction) => row.parentRequestId ? byRequest.get(row.parentRequestId)
        : row.previousResponseId && responses.get(row.previousResponseId)?.length === 1 ? responses.get(row.previousResponseId)![0] : undefined;
    for (const row of dependencyOrder(input, explicitParent)) {
        if (!row.history.length && !row.previousResponseId) {
            unresolved.push({ requestIds: [row.requestId], technicalCauses: ["unsupported_or_missing_request_history"] });
            continue;
        }
        const explicit = explicitParent(row);
        const known = input.filter((prior) => owner.has(prior.requestId));
        let parents: Interaction[] = [];
        if (explicit)
            parents = [explicit];
        else if (row.explicitTaskId)
            parents = known.filter((prior) => prior.explicitTaskId === row.explicitTaskId).slice(-1);
        else {
            const eligible = known.filter(prior => prior.traceId === row.traceId && !prior.terminal && groups[owner.get(prior.requestId)!]?.at(-1) === prior);
            const completed = completedCallKeys(row.history);
            parents = eligible.filter(prior => outputCalls.get(prior)!.some(key => completed.has(key)));
            if (!parents.length) {
                parents = eligible.filter((prior) => (row.traceId !== null || prior.output.some((m) => m.content.some((b) => object(b).type === "call"))) && ((prior.failed && JSON.stringify(prior.history) === JSON.stringify(row.history)) || (!prior.streamDiagnostic && prefix([...prior.history, ...prior.output], row.history))));
                const longest = Math.max(0, ...parents.map((p) => p.history.length + p.output.length));
                parents = parents.filter((p) => p.history.length + p.output.length === longest);
            }
        }
        if ((row.parentRequestId || row.previousResponseId) && !explicit) {
            unresolved.push({ requestIds: [row.requestId], technicalCauses: [row.previousResponseId && (responses.get(row.previousResponseId)?.length ?? 0) > 1 ? "ambiguous_explicit_response_identity" : "missing_explicit_parent"] });
            continue;
        }
        if (parents.length > 1 || (parents[0] && !owner.has(parents[0].requestId))) {
            unresolved.push({ requestIds: [row.requestId], technicalCauses: ["ambiguous_or_unordered_parent"] });
            continue;
        }
        let parent: Interaction | undefined = parents[0];
        // A completed objective followed by a new user turn starts a new task.
        if (parent?.terminal && !row.explicitTaskId) {
            const preceding = [...parent.history, ...parent.output];
            const appended = prefix(preceding, row.history) ? row.history.slice(preceding.length) : row.history;
            if (appended.some((m) => m.role === "user"))
                parent = undefined;
        }
        let group = parent ? owner.get(parent.requestId) : undefined;
        if (group === undefined) {
            group = groups.length;
            groups.push([]);
        }
        if (parent?.failed && JSON.stringify(parent.history) === JSON.stringify(row.history))
            retryParents.set(row.requestId, parent.requestId);
        groups[group]!.push(row);
        owner.set(row.requestId, group);
    }
    const tasks = groups.map((group): Task => {
        const id = `task-${digest(group.map((r) => r.requestId).sort().join("\n")).slice(0, 24)}`;
        const turns = group.map((row, i) => ({ id: `turn-${i + 1}`, requestId: row.requestId, messages: row.history, response: row.response, retryOf: retryParents.get(row.requestId) ?? null, terminal: row.terminal,
            ...(row.streamDiagnostic ? { streamDiagnostic: row.streamDiagnostic, rawResponse: row.rawResponse } : {}) }));
        const exchanges = extractExchanges(id, group, turns.map((t) => t.id));
        const last = group.at(-1)!;
        const causes = [...new Set(exchanges.flatMap((e) => e.technicalCauses))];
        if (!last.terminal)
            causes.push("terminal_response_not_observed");
        if (group.some((r) => !Number.isFinite(r.timestamp)))
            causes.push("capture_timestamp_missing");
        if (group.some(r => r.streamComplete === false) && !causes.includes("capture_stream_incomplete")) causes.push("capture_stream_incomplete");
        if (group.some(r => r.streamDiagnostic && r.streamComplete !== false) && !causes.includes("capture_stream_decode_error")) causes.push("capture_stream_decode_error");
        return { id, requestIds: group.map((r) => r.requestId), turns, exchanges, terminalResponse: last.terminal ? last.response : null,
            complete: last.terminal && causes.length === 0, confidence: causes.length ? "low" : "high", technicalCauses: causes };
    });
    const result: Reconstruction = { schemaVersion: 1, sourceDigest, taskDigest: digest(JSON.stringify(tasks)), requests: input.length, traceCount: new Set(input.map((i) => i.traceId).filter(Boolean)).size, tasks, unresolved };
    return result;
}
function dependencyOrder(input: Interaction[], parentOf: (row: Interaction) => Interaction | undefined): Interaction[] {
    const ordered: Interaction[] = [];
    const active = new Set<Interaction>(), emitted = new Set<Interaction>();
    for (const root of input) {
        const stack: { row: Interaction; exit: boolean }[] = [{ row: root, exit: false }];
        while (stack.length) {
            const { row, exit } = stack.pop()!;
            if (emitted.has(row)) continue;
            if (exit) {
                active.delete(row);
                emitted.add(row);
                ordered.push(row);
                continue;
            }
            if (active.has(row)) continue;
            active.add(row);
            stack.push({ row, exit: true });
            const parent = parentOf(row);
            if (parent) stack.push({ row: parent, exit: false });
        }
    }
    return ordered;
}
function prefix(parent: Message[], child: Message[]): boolean {
    return parent.length > 0 && child.length > parent.length && parent.every((m, i) => JSON.stringify(m) === JSON.stringify(child[i]));
}
function extractExchanges(taskId: string, group: Interaction[], turns: string[]): Exchange[] {
    const exchanges: Exchange[] = [];
    const byId = new Map<string, Exchange>();
    const seenObservations = new Set<string>();
    group.forEach((row, position) => {
        const all = [...row.history, ...row.output];
        all.forEach((message, messageIndex) => message.content.forEach((raw, blockIndex) => {
            const block = object(raw);
            if (block.type !== "call" && block.type !== "result")
                return;
            const legacyResult = block.legacy === true && block.type === "result"
                ? exchanges.findLast((exchange) => exchange.callId.startsWith("legacy-") && exchange.toolName === block.name && !exchange.hasResult) : undefined;
            const legacyId = block.legacy === true && block.type === "call" ? `legacy-${messageIndex}-${blockIndex}` : legacyResult?.callId;
            const callId = typeof block.id === "string" && block.id ? block.id : legacyId ?? `unlinked-${position}-${messageIndex}-${blockIndex}`;
            const observation = JSON.stringify({ role: message.role, messageIndex, blockIndex, block });
            const existing = byId.get(callId);
            if (seenObservations.has(observation) && messageIndex < row.history.length) {
                if (existing && !existing.sourceRequestIds.includes(row.requestId))
                    existing.sourceRequestIds.push(row.requestId);
                return;
            }
            seenObservations.add(observation);
            if (block.type === "call") {
                let args = block.arguments;
                let normalized: string | null = null;
                const causes: string[] = [];
                // A partial response call stays unusable even if a later request
                // supplies its result. Valid request history is separate evidence.
                if (row.streamDiagnostic && messageIndex >= row.history.length)
                    causes.push(row.streamComplete === false ? "capture_stream_incomplete" : "capture_stream_decode_error");
                try {
                    args = parseArguments(args);
                    normalized = canonical(args);
                }
                catch {
                    causes.push("invalid_tool_arguments");
                }
                if (typeof block.name !== "string" || !block.name)
                    causes.push("missing_tool_name");
                if (callId.startsWith("unlinked-"))
                    causes.push("missing_tool_call_identity");
                if (existing) {
                    if (messageIndex < row.history.length && existing.toolName === block.name && normalized !== null && existing.normalizedArguments === normalized) {
                        if (!existing.sourceRequestIds.includes(row.requestId)) existing.sourceRequestIds.push(row.requestId);
                        return;
                    }
                    existing.technicalCauses.push("reused_tool_call_identity");
                    causes.push("reused_tool_call_identity");
                }
                const exchange: Exchange = { taskId, turnId: turns[position]!, callId, toolName: typeof block.name === "string" ? block.name : "", occurrence: exchanges.length, arguments: args ?? null, normalizedArguments: normalized, result: null, hasResult: false, resultIsError: false, sourceRequestIds: [row.requestId], technicalCauses: causes };
                exchanges.push(exchange);
                byId.set(callId, exchange);
            }
            else if (existing) {
                if (existing.hasResult && (JSON.stringify(existing.result) !== JSON.stringify(block.result) || existing.resultIsError !== (block.isError === true)))
                    existing.technicalCauses.push("conflicting_tool_results");
                existing.result = block.result ?? null;
                existing.hasResult = true;
                existing.resultIsError = block.isError === true;
                if (!existing.sourceRequestIds.includes(row.requestId))
                    existing.sourceRequestIds.push(row.requestId);
            }
            else {
                const exchange: Exchange = { taskId, turnId: turns[position]!, callId, toolName: "", occurrence: exchanges.length, arguments: null, normalizedArguments: null, result: block.result ?? null, hasResult: true, resultIsError: block.isError === true, sourceRequestIds: [row.requestId], technicalCauses: ["tool_result_without_call"] };
                exchanges.push(exchange);
                byId.set(callId, exchange);
            }
        }));
    });
    for (const e of exchanges)
        if (!e.hasResult)
            e.technicalCauses.push("tool_result_not_observed");
    return exchanges;
}
export async function readReconstruction(storage: MigrationStorage, run: Run): Promise<Reconstruction> {
    const { sourceDigest } = await verifyCaptures(storage, run);
    const raw = object(await storage.json(path.join(storage.runPath(run.runId), "tasks.json")));
    if (![1, 2].includes(Number(raw.schemaVersion)) || raw.sourceDigest !== sourceDigest || !Array.isArray(raw.tasks) || raw.taskDigest !== digest(JSON.stringify(raw.tasks)))
        throw new CliError("Task reconstruction is stale or invalid. Reconstruct this run before continuing.");
    return raw as unknown as Reconstruction;
}

export async function readTask(storage: MigrationStorage, run: Run, summary: Task): Promise<Task> {
    if (!summary.detail) return summary;
    const { file, sha256, bytes } = summary.detail;
    if (!/^tasks\/[a-f0-9]{64}\.json$/.test(file) || file !== `tasks/${sha256}.json`) throw new CliError("The task detail reference is invalid.");
    const data = await storage.read(path.join(storage.runPath(run.runId), file));
    if (data.length !== bytes || digest(data) !== sha256) throw new CliError("Task detail integrity verification failed.");
    const task = JSON.parse(data.toString("utf8")) as Task;
    if (task.id !== summary.id || task.detail || canonical(task.requestIds) !== canonical(summary.requestIds)) throw new CliError("The task detail does not match its index.");
    return task;
}
