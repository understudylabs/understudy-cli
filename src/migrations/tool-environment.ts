import { Script, createContext, type Context } from "node:vm";
import type { ValidateFunction } from "ajv";
import { CliError } from "../errors.js";
import { canonical, parseArguments } from "./interactions.js";
import { compileSchema } from "./protocol.js";
import { digest, type MigrationStorage } from "./storage.js";

export interface EnvironmentTransition {
    kind: "success" | "tool_rejection" | "application_failure" | "environment_gap";
    stateBefore: unknown;
    stateAfter: unknown;
    handlerVersion: string | null;
    contractVersion: string;
    result?: unknown;
    code?: string;
    message?: string;
}
export interface EnvironmentReport {
    valid: boolean;
    version: string;
    digest: string;
    coverage: { name: string; mode: "recorded" | "simulated"; status: "verified" | "assumed" | "unsupported"; reason: string }[];
    tests: { id: string; passed: boolean; reproducible: boolean; tools: string[]; message?: string }[];
    problems: string[];
    scope: string;
}
export interface ToolEnvironment {
    source: Buffer;
    digest: string;
    version: string;
    initialState: unknown;
    context: Record<string, unknown>;
    recordedTools: string[];
    report: EnvironmentReport;
    execute(name: string, argumentsInput: unknown, state: unknown, context: unknown, operation: unknown): EnvironmentTransition;
}
type JsonObject = Record<string, unknown>;
type ToolContract = {
    version: string;
    input: ValidateFunction;
    output: ValidateFunction;
    failures: Map<string, ValidateFunction>;
};
const executionTimeout = 1000;
const maximumJsonLength = 4 * 1024 * 1024;

// This function is also installed inside each VM. It has no external references.
// Validate before JSON serialization so undefined, sparse arrays, accessors and
// non-JSON objects cannot silently disappear or acquire different meanings.
function jsonSnapshot(input: unknown): unknown {
    const ancestors = new Set<object>();
    function copy(value: unknown): unknown {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number") {
            if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("unsupported_number");
            return value;
        }
        if (!value || typeof value !== "object") throw new Error("non_json_value");
        if (ancestors.has(value)) throw new Error("cyclic_json_value");
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if (!array && prototype !== null && (Object.getPrototypeOf(prototype) !== null || Object.getOwnPropertyDescriptor(prototype, "constructor")?.value?.name !== "Object")) throw new Error("non_json_object");
        ancestors.add(value);
        const output: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
        if (array) for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new Error("sparse_json_array");
        for (const key of Reflect.ownKeys(value)) {
            if (array && key === "length") continue;
            if (typeof key !== "string") throw new Error("non_json_key");
            if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error("non_json_array_property");
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("non_json_property");
            (output as Record<string, unknown>)[key] = copy(descriptor.value);
        }
        ancestors.delete(value);
        return output;
    }
    const serialized = JSON.stringify(copy(input));
    if (serialized.length > 4 * 1024 * 1024) throw new Error("environment_json_size_limit");
    return JSON.parse(serialized);
}
const asObject = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const validVersion = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 120;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

function realm(source: string): Context {
    const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
    new Script(`
        globalThis.module = { exports: undefined };
        Object.defineProperty(globalThis, "__snapshot", { value: (${jsonSnapshot.toString()}), writable: false, configurable: false });
        globalThis.Date = undefined;
        globalThis.Intl = undefined;
        globalThis.Promise = undefined;
        globalThis.WeakRef = undefined;
        globalThis.FinalizationRegistry = undefined;
        Object.defineProperty(Math, "random", { value() { throw new Error("Supply explicit reproducible inputs instead of Math.random."); }, writable: false, configurable: false });
    `).runInContext(context, { timeout: executionTimeout });
    // A VM removes ambient capabilities and resets module globals. Reviewed code
    // is still required: node:vm is not an operating-system security sandbox.
    new Script(source, { filename: "private-tool-environment.cjs" }).runInContext(context, { timeout: executionTimeout });
    return context;
}
function exportedMetadata(context: Context): JsonObject {
    const serialized = new Script(`JSON.stringify(__snapshot((() => {
        const value = module.exports;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The environment must export an object.");
        const tools = Object.create(null);
        if (value.tools && typeof value.tools === "object" && !Array.isArray(value.tools)) {
            for (const name of Object.keys(value.tools)) {
                const tool = value.tools[name];
                if (!tool || typeof tool !== "object" || Array.isArray(tool)) { tools[name] = null; continue; }
                tools[name] = { hasHandler: typeof tool.handler === "function" && Object.prototype.toString.call(tool.handler) !== "[object AsyncFunction]" };
                for (const field of ["version", "inputSchema", "outputSchema", "failures"]) if (Object.hasOwn(tool, field)) tools[name][field] = tool[field];
            }
        }
        const metadata = { tools };
        for (const field of ["schemaVersion", "version", "stateSchema", "initialState", "context", "recordedTools", "tests"]) if (Object.hasOwn(value, field)) metadata[field] = value[field];
        return metadata;
    })()))`).runInContext(context, { timeout: executionTimeout });
    if (typeof serialized !== "string" || serialized.length > maximumJsonLength) throw new Error("invalid_environment_metadata");
    return JSON.parse(serialized) as JsonObject;
}

export async function loadToolEnvironment(storage: MigrationStorage, file: string, declaredTools: string[]): Promise<ToolEnvironment> {
    if (!file.endsWith(".cjs")) throw new CliError("Use a reviewed private .cjs tool environment.");
    const bytes = await storage.read(file, 1024 * 1024), source = bytes.toString("utf8"), sourceDigest = digest(bytes);
    let metadata: JsonObject = {}, stateSchema: ValidateFunction | undefined;
    const problems: string[] = [], unsupported = new Map<string, string>(), contracts = new Map<string, ToolContract>();
    try { metadata = exportedMetadata(realm(source)); }
    catch { problems.push("The private environment could not be loaded as bounded synchronous JSON metadata."); }
    const version = validVersion(metadata.version) ? metadata.version : "invalid";
    if (metadata.schemaVersion !== 1 || !validVersion(metadata.version)) problems.push("Declare schemaVersion 1 and a nonempty environment version.");
    let initialState: unknown = null, defaultContext: JsonObject = {};
    try {
        initialState = jsonSnapshot(metadata.initialState);
        stateSchema = compileSchema(metadata.stateSchema);
        if (!stateSchema(initialState)) problems.push("The initial state does not satisfy stateSchema.");
    } catch { problems.push("Declare a serializable initial state and a supported self-contained stateSchema."); }
    try {
        defaultContext = asObject(jsonSnapshot(metadata.context ?? {}))!;
        if (!defaultContext) throw new Error();
    } catch { defaultContext = {}; problems.push("The environment context must be a serializable JSON object."); }
    const tools = asObject(metadata.tools) ?? {};
    const recordedTools = Array.isArray(metadata.recordedTools) && metadata.recordedTools.every(name => typeof name === "string") ? metadata.recordedTools as string[] : [];
    if (metadata.recordedTools !== undefined && (!Array.isArray(metadata.recordedTools) || recordedTools.length !== metadata.recordedTools.length)) problems.push("recordedTools must list tool names explicitly reserved for strict recorded replay.");
    if (new Set(recordedTools).size !== recordedTools.length || recordedTools.some(name => !declaredTools.includes(name) || Object.hasOwn(tools, name))) problems.push("Recorded-only tools must be unique, declared in source evidence, and have no simulated handler definition.");
    for (const name of new Set([...declaredTools, ...Object.keys(tools)])) {
        if (recordedTools.includes(name)) continue;
        const tool = asObject(tools[name]);
        if (!tool || tool.hasHandler !== true) { unsupported.set(name, "No synchronous handler is declared for this tool."); continue; }
        if (!validVersion(tool.version)) { unsupported.set(name, "Declare a nonempty handler version."); continue; }
        try {
            const failures = new Map<string, ValidateFunction>();
            if (tool.failures !== undefined && !asObject(tool.failures)) throw new Error();
            for (const [code, schema] of Object.entries(asObject(tool.failures) ?? {})) {
                if (!validVersion(code)) throw new Error();
                failures.set(code, compileSchema(schema));
            }
            contracts.set(name, { version: tool.version, input: compileSchema(tool.inputSchema), output: compileSchema(tool.outputSchema), failures });
        } catch { unsupported.set(name, "The input, output, or declared failure schema is unsupported."); }
    }
    const metadataValid = problems.length === 0;
    function execute(name: string, argumentsInput: unknown, state: unknown, contextInput: unknown, operationInput: unknown): EnvironmentTransition {
        const contract = contracts.get(name);
        let before: unknown;
        try { before = jsonSnapshot(state); }
        catch { return { kind: "environment_gap", stateBefore: null, stateAfter: null, contractVersion: version, handlerVersion: contract?.version ?? null, code: "invalid_environment_state", message: "The case state is not serializable JSON." }; }
        const failure = (kind: EnvironmentTransition["kind"], code: string, message: string): EnvironmentTransition => ({
            kind, stateBefore: jsonSnapshot(before), stateAfter: jsonSnapshot(before), handlerVersion: contract?.version ?? null, contractVersion: version, code, message,
        });
        if (!metadataValid || !stateSchema || !stateSchema(before)) return failure("environment_gap", "invalid_environment_state", "Review the environment metadata and case-state contract.");
        if (!contract) return failure("environment_gap", "tool_handler_unavailable", unsupported.get(name) ?? "No reviewed handler is declared for this tool.");
        let args: unknown, context: unknown, operation: unknown;
        try { args = jsonSnapshot(parseArguments(argumentsInput)); }
        catch { return failure("tool_rejection", "invalid_tool_arguments", "Arguments must be valid JSON matching the supported tool contract."); }
        if (!contract.input(args)) return failure("tool_rejection", "invalid_tool_arguments", "Arguments do not match the supported tool contract.");
        try {
            context = jsonSnapshot(contextInput ?? defaultContext);
            operation = jsonSnapshot(operationInput ?? {});
            if (!asObject(context) || !asObject(operation)) throw new Error();
        } catch { return failure("environment_gap", "invalid_environment_context", "Supply serializable objects for deterministic context and operation identity."); }
        let result: JsonObject;
        try {
            const vm = realm(source);
            // Only a string enters the VM; parse it there so handlers cannot
            // retain or mutate host-owned state, arguments, or context objects.
            vm.__operationJson = JSON.stringify({ name, arguments: args, state: before, context, operation });
            const encoded = new Script(`(() => {
                const input = JSON.parse(__operationJson);
                const tool = module.exports.tools[input.name];
                if (typeof tool.handler !== "function" || Object.prototype.toString.call(tool.handler) === "[object AsyncFunction]") throw new Error("Asynchronous handlers are unsupported.");
                const output = tool.handler({ arguments: input.arguments, state: input.state, context: input.context, operation: input.operation });
                if (output && typeof output.then === "function") {
                    output.then(undefined, () => undefined);
                    throw new Error("Asynchronous handlers are unsupported.");
                }
                return JSON.stringify(__snapshot(output));
            })()`).runInContext(vm, { timeout: executionTimeout });
            if (typeof encoded !== "string" || encoded.length > maximumJsonLength) throw new Error();
            const parsed = asObject(JSON.parse(encoded));
            if (!parsed) throw new Error();
            result = parsed;
        } catch { return failure("environment_gap", "tool_handler_failed", "The reviewed handler threw, timed out, or returned an unsupported value."); }
        if (Object.hasOwn(result, "failure")) {
            const validateFailure = typeof result.failure === "string" ? contract.failures.get(result.failure) : undefined;
            if (!validateFailure || !Object.hasOwn(result, "result") || Object.keys(result).some(key => !["failure", "result"].includes(key)) || !validateFailure(result.result))
                return failure("environment_gap", "invalid_simulated_failure", "The handler failure is undeclared or does not satisfy its failure contract.");
            return { ...failure("application_failure", result.failure as string, "The test environment deliberately simulated a declared application failure."), result: jsonSnapshot(result.result) };
        }
        if (!Object.hasOwn(result, "result") || !Object.hasOwn(result, "state") || Object.keys(result).some(key => !["result", "state"].includes(key)) || !contract.output(result.result) || !stateSchema(result.state))
            return failure("environment_gap", "invalid_simulated_output", "The handler result or state does not satisfy the declared contract.");
        return { kind: "success", stateBefore: jsonSnapshot(before), stateAfter: jsonSnapshot(result.state), result: jsonSnapshot(result.result), handlerVersion: contract.version, contractVersion: version };
    }
    const testReports: EnvironmentReport["tests"] = [], verified = new Set<string>(), failedTools = new Set<string>();
    const tests = Array.isArray(metadata.tests) ? metadata.tests : [];
    if (!Array.isArray(metadata.tests) && [...new Set([...declaredTools, ...Object.keys(tools)])].some(name => !recordedTools.includes(name))) problems.push("Declare explicit sequential environment contract tests.");
    const testIds = new Set<string>();
    for (const [index, raw] of tests.entries()) {
        const test = asObject(raw), testId = test && validVersion(test.id) ? test.id : `invalid-test-${index + 1}`;
        const steps = Array.isArray(test?.steps) ? test.steps : [];
        const names = [...new Set(steps.map(step => asObject(step)?.tool).filter((name): name is string => typeof name === "string"))];
        let malformed = !test || !validVersion(test.id) || testIds.has(testId) || steps.length === 0;
        testIds.add(testId);
        const passes: { transitions: EnvironmentTransition[]; passed: boolean }[] = [];
        for (let pass = 0; pass < 2; pass++) {
            let state = jsonSnapshot(initialState), passed = !malformed;
            const transitions: EnvironmentTransition[] = [];
            for (const [stepIndex, rawStep] of steps.entries()) {
                const step = asObject(rawStep), expect = asObject(step?.expect);
                if (!step || typeof step.tool !== "string" || !Object.hasOwn(step, "arguments") || !expect || Object.keys(expect).length === 0 || Object.keys(expect).some(key => !["result", "state", "failure", "rejection"].includes(key)) || (Object.hasOwn(expect, "failure") && Object.hasOwn(expect, "rejection"))) {
                    malformed = true; passed = false; continue;
                }
                const transition = execute(step.tool, step.arguments, state, step.context ?? defaultContext, step.operation ?? { id: `${testId}-${stepIndex + 1}` });
                transitions.push(transition);
                const expectedKind = Object.hasOwn(expect, "rejection") ? "tool_rejection" : Object.hasOwn(expect, "failure") ? "application_failure" : "success";
                if (transition.kind !== expectedKind || (Object.hasOwn(expect, "result") && !same(transition.result ?? null, expect.result)) ||
                    (Object.hasOwn(expect, "state") && !same(transition.stateAfter, expect.state)) ||
                    (Object.hasOwn(expect, "failure") && transition.code !== expect.failure) ||
                    (Object.hasOwn(expect, "rejection") && transition.code !== expect.rejection)) passed = false;
                state = jsonSnapshot(transition.stateAfter);
            }
            passes.push({ transitions, passed });
        }
        const reproducible = same(passes[0]!.transitions, passes[1]!.transitions), passed = passes.every(pass => pass.passed) && reproducible && !malformed;
        testReports.push({ id: testId, passed, reproducible, tools: names, ...(passed ? {} : { message: malformed ? "The contract test is malformed or reuses a test id." : reproducible ? "A declared contract assertion failed." : "Repeated executions did not reproduce the same transitions." }) });
        for (const name of names) (passed ? verified : failedTools).add(name);
    }
    const coverage: EnvironmentReport["coverage"] = [...new Set([...declaredTools, ...Object.keys(tools)])].map((name): EnvironmentReport["coverage"][number] => {
        const mode = recordedTools.includes(name) ? "recorded" : "simulated";
        if (!metadataValid || unsupported.has(name) || failedTools.has(name)) return { name, mode, status: "unsupported", reason: unsupported.get(name) ?? (!metadataValid ? "The environment metadata is invalid." : "A declared contract test failed.") };
        if (mode === "recorded") return { name, mode, status: "assumed", reason: "Only exact captured returns are available; captured examples do not establish other behavior." };
        return verified.has(name) ? { name, mode, status: "verified", reason: "Declared contract assertions passed reproducibly; other behavior remains assumed." } : { name, mode, status: "assumed", reason: "The supported handler has no passing contract assertions." };
    });
    const report: EnvironmentReport = { valid: problems.length === 0 && testReports.every(test => test.passed) && coverage.every(tool => tool.status === "verified" || (tool.mode === "recorded" && tool.status === "assumed")),
        version, digest: sourceDigest, coverage, tests: testReports, problems,
        scope: "Verified means only the explicit contract assertions passed in the local simulation. Captured examples do not establish complete behavior, semantic correctness, or production effects." };
    return { source: Buffer.from(bytes), digest: sourceDigest, version, initialState: jsonSnapshot(initialState), context: jsonSnapshot(defaultContext) as JsonObject, recordedTools: [...recordedTools], report, execute };
}
