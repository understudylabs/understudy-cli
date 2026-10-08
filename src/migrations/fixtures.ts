import path from "node:path";
import { modelOutcomes, type Exchange, type Reconstruction, type Run } from "./contracts.js";
import { canonical, parseArguments } from "./interactions.js";
import { readReconstruction } from "./reconstruct.js";
import { MigrationStorage } from "./storage.js";
export interface FixturePlan {
    schemaVersion: 1;
    taskDigest: string;
    exchanges: Exchange[];
    required: number;
    usable: number;
    missing: number;
    invalid: number;
    normalization: string;
    matchKey: string[];
    missingPolicy: string;
}
export async function planFixtures(storage: MigrationStorage, run: Run, reconstruction?: Reconstruction): Promise<FixturePlan> {
    const tasks = reconstruction ?? await readReconstruction(storage, run);
    const exchanges = tasks.tasks.flatMap((t) => t.exchanges);
    const plan: FixturePlan = { schemaVersion: 1, taskDigest: tasks.taskDigest, exchanges,
        required: exchanges.length, usable: exchanges.filter((e) => e.hasResult && !e.technicalCauses.length).length,
        missing: exchanges.filter((e) => !e.hasResult).length, invalid: exchanges.filter((e) => e.technicalCauses.some((c) => c !== "tool_result_not_observed")).length,
        normalization: "strict-json-v1: sorted object keys; preserved array order, case and types; finite IEEE-754 numbers with safe integers; duplicate string argument keys rejected",
        matchKey: ["taskId", "turnId", "toolName", "normalizedArguments", "occurrence"],
        missingPolicy: "Return model-visible replay errors: unexpected_tool_call for undeclared tools, invalid_tool_arguments for schema violations, and recorded_result_unavailable for unmatched or unusable recordings. Allow bounded recovery at the same step; never execute a real tool or synthesize success." };
    await storage.writeJson(path.join(storage.runPath(run.runId), "tool-fixture-plan.json"), plan);
    return plan;
}
// Pure fixture lookup, useful to verify a plan before a later replay stage exists.
export function matchFixture(plan: FixturePlan, call: {
    taskId: string;
    turnId: string;
    toolName: string;
    arguments: unknown;
    occurrence: number;
}, consumed = new Set<string>()) {
    let normalized;
    try {
        normalized = canonical(parseArguments(call.arguments));
    }
    catch {
        return { ok: false as const, category: "Format", message: modelOutcomes.Format, code: "invalid_tool_protocol" };
    }
    const key = canonical([call.taskId, call.turnId, call.toolName, normalized, call.occurrence]);
    const matches = plan.exchanges.filter((e) => e.taskId === call.taskId && e.turnId === call.turnId && e.toolName === call.toolName && e.normalizedArguments === normalized && e.occurrence === call.occurrence);
    if (consumed.has(key) || !matches.length)
        return { ok: false as const, category: null, message: "No unused recorded result matches this call. Let the candidate recover within the current replay step.", code: "fixture_unavailable" };
    const fixture = matches[0]!;
    if (fixture.record)
        return { ok: false as const, category: null, message: "Load the task's verified detail record before fixture matching.", code: "fixture_reference_required" };
    if (matches.length !== 1 || !fixture.hasResult || fixture.technicalCauses.length)
        return { ok: false as const, category: null, message: "Replay requires a complete captured tool exchange.", code: "fixture_unavailable" };
    consumed.add(key);
    return { ok: true as const, result: fixture.result, isError: fixture.resultIsError };
}
