import path from "node:path";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { z } from "zod";
import { CliError } from "../errors.js";
import { routableModelIdPattern } from "../models/service.js";
import { object, type Run } from "./contracts.js";
import { decodeCapture, readIndex } from "./captures.js";
import { canonical, parseArguments, interaction } from "./interactions.js";
import { readReconstruction, readTask } from "./reconstruct.js";
import { appendResults, compileSchema, decodeCandidate, protocolOf, ReplayDependency } from "./protocol.js";
import { boundedRequest, modelTransport, snapshotInput, type ExecutionOptions } from "./transport.js";
import { loadToolEnvironment } from "./tool-environment.js";
import { digest, MigrationStorage } from "./storage.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
const protocol = z.enum(["messages", "chat", "responses"]);
const inputSchema = z.object({ harness: z.string().min(1), model: z.string().regex(routableModelIdPattern).optional(),
    maxCalls: z.number().int().min(1).max(10000).optional(), maxOutputTokens: z.number().int().min(1).max(32768).optional(), id: id.optional(),
    environment: z.string().min(1).optional(), offline: z.boolean().default(false), maxToolCalls: z.number().int().min(1).max(10000).default(1000) }).strict().superRefine((value, ctx) => {
        if (value.offline ? value.model !== undefined || value.maxCalls !== undefined || value.maxOutputTokens !== undefined : !value.model || !value.maxCalls || !value.maxOutputTokens)
            ctx.addIssue({ code: "custom", message: "Offline replay omits model limits; inference requires a model and explicit limits." });
    });
export type HarnessInput = z.input<typeof inputSchema>;
const requestSchema = z.object({ id, taskId: z.string().min(1), protocol, body: z.record(z.string(), z.unknown()) }).strict();
const toolSchema = z.object({ id, caseId: id, taskId: z.string().min(1), turnId: z.string().min(1),
    call: z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() }).strict(),
    schema: z.unknown().optional(), effectiveArguments: z.unknown().optional() }).strict();
const simulationSchema = toolSchema.omit({ schema: true, effectiveArguments: true }).extend({ attemptId: id, context: z.record(z.string(), z.unknown()).optional() });
type Entry = { id: string; kind: "model" | "tool" | "simulation"; input: unknown; inputDigest: string; state: "pending" | "recorded"; output?: unknown; outputDigest?: string };
interface Journal { schemaVersion: 1 | 2; id: string; identity: unknown; calls: number; entries: Entry[]; harnessResult?: unknown; stop?: { code: string; message: string } }
const hash = (value: unknown) => digest(canonical(value));
const mismatch = () => new CliError("The replay journal does not match the harness, evidence, tool environment, model, target, request environment, or limits. Use a new replay id for changed settings.");

// Trusted private code supplies workflow and semantics. This host owns transport,
// serialized effects, validation, and evidence; vm is not a security sandbox.
export async function runHarness(storage: MigrationStorage, run: Run, raw: HarnessInput, options: ExecutionOptions = {}) {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) throw new CliError("Select a private harness and either offline replay or a model with explicit positive call and output-token limits.");
    const input = parsed.data, source = await storage.read(input.harness);
    if (!input.harness.endsWith(".cjs") || source.length > 1024 * 1024) throw new CliError("Use a private JavaScript .cjs harness of at most one megabyte.");
    const tasks = await readReconstruction(storage, run), index = await readIndex(storage, run);
    const replayId = input.id ?? `replay-${randomUUID()}`, directory = path.join(storage.runPath(run.runId), "replays", replayId);
    const artifact = path.join(directory, "journal.json"), reportArtifact = path.join(directory, "environment-validation.json"), preflightPath = path.join(directory, "preflight.json");
    const environmentArtifact = input.environment ? reportArtifact : null;
    let saved: Journal | undefined;
    try {
        saved = JSON.parse((await storage.read(artifact)).toString("utf8"));
        if (!saved || ![1, 2].includes(saved.schemaVersion) || saved.id !== replayId || !Array.isArray(saved.entries) || !Number.isSafeInteger(saved.calls) || saved.calls < 0 || saved.calls !== saved.entries.filter(e => e.kind === "model").length || new Set(saved.entries.map(e => e.id)).size !== saved.entries.length) throw mismatch();
        for (const entry of saved.entries) if (!id.safeParse(entry.id).success || !["model", "tool", ...(saved.schemaVersion === 2 ? ["simulation"] : [])].includes(entry.kind) || entry.inputDigest !== hash(entry.input) || !["pending", "recorded"].includes(entry.state) || (entry.state === "pending" && entry.kind !== "model") || (entry.state === "recorded" && entry.outputDigest !== hash(entry.output))) throw new CliError("The replay journal has changed.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    async function optionalEvidence(file: string): Promise<unknown> {
        try { return JSON.parse((await storage.read(file)).toString("utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw new CliError("The replay preflight or validation evidence has changed or cannot be read.");
        }
    }
    const priorPreflight = await optionalEvidence(preflightPath), priorReport = await optionalEvidence(reportArtifact);
    const legacy = saved?.schemaVersion === 1;
    if (legacy && (input.environment || input.offline || raw.maxToolCalls !== undefined)) throw mismatch();
    const cache = new Map<string, Awaited<ReturnType<typeof loadTask>>>();
    async function loadTask(taskId: string) {
        const summary = tasks.tasks.find(t => t.id === taskId);
        if (!summary) throw new CliError("Select a task from this capture set.");
        const task = await readTask(storage, run, summary), requests = [];
        for (const turn of task.turns) {
            const row = index.rows.find(r => r.requestId === turn.requestId);
            if (!row) throw new CliError("A captured request is missing from the index.");
            const bytes = await storage.read(path.join(storage.runPath(run.runId), row.file));
            if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new CliError("A captured request has changed.");
            const envelope = decodeCapture(bytes, run.scope, row.requestId), body = interaction(envelope).request;
            requests.push({ turnId: turn.id, body, protocol: envelope.endpoint === "/v1/messages" ? "messages" as const : protocolOf(body) });
        }
        return { task, requests };
    }
    async function task(taskId: string) {
        if (!cache.has(taskId)) cache.set(taskId, await loadTask(taskId));
        return structuredClone(cache.get(taskId)!);
    }
    const definitions = (request: Awaited<ReturnType<typeof loadTask>>["requests"][number] | undefined) => Array.isArray(request?.body.tools) ? request.body.tools.map(item => request.protocol === "chat" ? object(object(item).function) : object(item)) : [];
    const declared = new Set<string>();
    if (input.environment) for (const summary of tasks.tasks) for (const request of (await loadTask(summary.id)).requests) for (const tool of definitions(request)) if (typeof tool.name === "string") declared.add(tool.name);
    const environment = input.environment ? await loadToolEnvironment(storage, input.environment, [...declared]) : undefined;
    const baseIdentity = { runId: run.runId, sourceDigest: tasks.sourceDigest, taskDigest: tasks.taskDigest, harnessDigest: digest(source), model: input.model ?? null,
        maxCalls: input.maxCalls ?? 0, maxOutputTokens: input.maxOutputTokens ?? 0 };
    const semantics = legacy ? {} : { toolSemantics: "explicit-environment-v1", offline: input.offline, maxToolCalls: input.maxToolCalls, environmentDigest: environment?.digest ?? null, initialStateDigest: environment ? hash(environment.initialState) : null };
    // Check changed source/settings before a new invalid environment can replace
    // any existing validation report or journal.
    if (saved) for (const [key, value] of Object.entries({ ...baseIdentity, ...semantics })) if (canonical(object(saved.identity)[key]) !== canonical(value)) throw mismatch();
    if (environment && saved) for (const entry of saved.entries) {
        const name = object(object(entry.input).call).name;
        if (entry.kind === "tool" && !environment.recordedTools.includes(String(name)) && object(entry.output).provenance !== "environment_gap")
            throw new CliError("A recorded tool operation does not match the declared environment mode. Preserve this journal and use a new replay id.");
    }
    const preflightIdentity = { ...baseIdentity, ...semantics, requestedTarget: options.target ?? null };
    let preflightArtifact: string | null = null;
    if (priorPreflight !== undefined) {
        const evidence = object(priorPreflight), bound = object(evidence.identity);
        if (evidence.schemaVersion !== 1 || evidence.id !== replayId || typeof evidence.harnessSourceBase64 !== "string" || typeof evidence.environmentSourceBase64 !== "string" || !Object.hasOwn(evidence, "report") || typeof evidence.reportDigest !== "string" ||
            digest(Buffer.from(evidence.harnessSourceBase64, "base64")) !== bound.harnessDigest || digest(Buffer.from(evidence.environmentSourceBase64, "base64")) !== bound.environmentDigest || hash(evidence.report) !== evidence.reportDigest)
            throw new CliError("The replay preflight evidence has changed.");
        if (canonical(evidence.identity) !== canonical(preflightIdentity)) throw mismatch();
        if (!environment || hash(environment.report) !== evidence.reportDigest) throw new CliError("The environment validation no longer matches its saved preflight evidence.");
        preflightArtifact = preflightPath;
    } else if (!saved && priorReport !== undefined) {
        throw new CliError("Validation evidence already exists without a bound replay identity. Preserve it and use a new replay id.");
    }
    if (environment && priorReport !== undefined && hash(priorReport) !== hash(environment.report)) throw new CliError("The saved environment validation evidence has changed.");
    if (environment && !saved && priorPreflight === undefined) {
        // Pin even failed validation before writing derived reports or opening
        // transport. One atomic artifact retains its identity, sources and report.
        await storage.writeJson(preflightPath, { schemaVersion: 1, id: replayId, identity: preflightIdentity,
            harnessSourceBase64: source.toString("base64"), environmentSourceBase64: environment.source.toString("base64"),
            report: environment.report, reportDigest: hash(environment.report) });
        preflightArtifact = preflightPath;
    }
    const saveReport = async () => { if (environment && priorReport === undefined) await storage.writeJson(reportArtifact, environment.report); };
    if (environment && !environment.report.valid) {
        await saveReport();
        return { schemaVersion: 1, replayId, model: input.model ?? null, requestEnvironment: input.offline ? "offline" : null, modelCalls: 0, artifact,
            environmentArtifact, preflightArtifact, environmentValidation: environment.report, status: "stopped", stop: { code: "tool_environment_invalid", message: "Review the environment coverage, contracts, and reproducibility report before replay." }, harnessResult: null };
    }
    // Offline validation and simulation never initialize authentication/transport.
    const transport = input.offline ? undefined : await modelTransport(storage, run, input.model!, options);
    const identity = { ...baseIdentity, target: transport?.target ?? null, requestEnvironment: transport?.requestEnvironment ?? "offline", ...semantics };
    if (saved && canonical(saved.identity) !== canonical(identity)) throw mismatch();
    let journal: Journal = saved ?? { schemaVersion: 2, id: replayId, identity, calls: 0, entries: [] };
    let persistenceFailed = false;
    async function commit(next: Journal) {
        try { await storage.writeJson(artifact, next); }
        catch { persistenceFailed = true; throw new ReplayDependency("replay_persistence_failed", "The journal commit could not be confirmed. Resume from the saved evidence before another operation."); }
        journal = next;
    }
    const receipt = () => ({ schemaVersion: 1, replayId, model: input.model ?? null, requestEnvironment: identity.requestEnvironment, modelCalls: journal.calls, artifact,
        environmentArtifact, preflightArtifact, environmentValidation: environment?.report ?? null, status: journal.stop ? "stopped" : "recorded", stop: journal.stop ?? null, harnessResult: journal.harnessResult ?? null });
    const environmentStop = { code: "unverified_request_environment", message: "The response did not confirm the test environment. Inspect the recorded environment and HTTP evidence before continuing." };
    let environmentUnverified = journal.entries.some(e => e.kind === "model" && e.state === "recorded" && object(e.output).requestEnvironment !== identity.requestEnvironment);
    if (environmentUnverified || journal.entries.some(e => e.state === "pending")) {
        await commit({ ...journal, stop: environmentUnverified ? environmentStop : { code: "inference_outcome_unknown", message: "Reconcile the pending request. Resuming will not send it again." } });
        return receipt();
    }
    const states = new Map<string, unknown>();
    const caseKey = (value: Record<string, unknown>) => canonical([value.taskId, value.caseId, value.attemptId]);
    for (const entry of journal.entries.filter(e => e.kind === "simulation")) {
        const output = object(entry.output);
        if (output.provenance === "environment_gap" && !output.receipt) continue;
        const value = object(entry.input), evidence = object(output.receipt), key = caseKey(value), before = states.has(key) ? states.get(key) : environment?.initialState;
        if (!environment || !["simulated", "environment_gap"].includes(String(output.provenance)) || output.productionAction !== false || evidence.kind !== "simulated" || evidence.environmentDigest !== environment.digest || evidence.contractVersion !== environment.version ||
            evidence.taskId !== value.taskId || evidence.caseId !== value.caseId || evidence.attemptId !== value.attemptId || evidence.stateBeforeDigest !== hash(evidence.stateBefore) || evidence.stateAfterDigest !== hash(evidence.stateAfter) || hash(before) !== evidence.stateBeforeDigest ||
            !["success", "tool_rejection", "application_failure", "environment_gap"].includes(String(evidence.outcome)) || (evidence.outcome !== "success" && evidence.stateBeforeDigest !== evidence.stateAfterDigest)) throw new CliError("The replay journal simulation state chain has changed.");
        states.set(key, snapshotInput(evidence.stateAfter));
    }
    const seen = new Set<string>(), consumed = new Set<string>(journal.entries.filter(e => e.kind === "tool").map(e => object(e.output).fixtureKey).filter((key): key is string => typeof key === "string"));
    const originalEntries = journal.entries.length;
    let cursor = 0, gapStop: { code: string; message: string } | undefined;
    function existing(key: string, kind: Entry["kind"], value: unknown) {
        if (seen.has(key)) throw new CliError("Harness operation ids must be unique within an invocation.");
        seen.add(key);
        const entry = journal.entries.find(e => e.id === key);
        if (!legacy && cursor < originalEntries && journal.entries[cursor]?.id !== key) throw new CliError("A resumed operation changed the recorded order. Use a new replay id.");
        if (entry && (entry.kind !== kind || entry.inputDigest !== hash(value))) throw new CliError("A resumed operation changed its recorded input. Use a new replay id for a changed harness.");
        if (entry) cursor++;
        return entry;
    }
    function expose(output: unknown) {
        const value = object(output), evidence = object(value.receipt);
        if (value.provenance === "environment_gap" || evidence.outcome === "environment_gap") {
            gapStop = { code: String(value.code ?? evidence.code ?? "tool_environment_gap"), message: String(value.message ?? evidence.message ?? "Review the tool environment before continuing.") };
            throw new ReplayDependency(gapStop.code, gapStop.message);
        }
        return snapshotInput(value);
    }
    function record(entry: Entry, output: unknown) {
        entry.output = snapshotInput(output); entry.outputDigest = hash(entry.output); entry.state = "recorded";
    }
    async function recordTool(kind: "tool" | "simulation", value: { id: string }, output: unknown) {
        const next = snapshotInput(journal), entry: Entry = { id: value.id, kind, input: snapshotInput(value), inputDigest: hash(value), state: "pending" };
        record(entry, output); next.entries.push(entry); await commit(next);
        return expose(entry.output);
    }
    function toolBudget() {
        if (!legacy && journal.entries.filter(e => e.kind !== "model").length >= input.maxToolCalls) throw new ReplayDependency("tool_budget_exhausted", "The tool-call limit is exhausted.");
    }
    const gap = (callId: string, code: string, message: string) => ({ id: callId, provenance: "environment_gap", code, message });
    const rejection = (callId: string, code: string, message: string) => ({ id: callId, isError: true, fixtureKey: null, result: { error: { code, source: "replay", retryable: true, message } } });
    let queue: Promise<unknown> = Promise.resolve(), accepting = true;
    function serial<T>(operation: () => Promise<T>): Promise<T> {
        if (!accepting) return Promise.reject(new CliError("The harness invocation has ended."));
        const next = queue.then(() => {
            if (persistenceFailed) throw new ReplayDependency("replay_persistence_failed", "Resume from saved evidence before another operation.");
            if (gapStop) throw new ReplayDependency(gapStop.code, gapStop.message);
            if (environmentUnverified) throw new ReplayDependency(environmentStop.code, environmentStop.message);
            if (journal.entries.some(entry => entry.state === "pending")) throw new ReplayDependency("inference_outcome_unknown", "Reconcile the pending model request before another operation.");
            return operation();
        });
        queue = next.catch(() => undefined); return next;
    }
    // Capture values synchronously at invocation, before joining the async queue.
    // Return the handled queue promise itself, avoiding abandoned wrapper promises.
    function prepare<T>(capture: () => T, operation: (value: T) => Promise<unknown>) {
        try { const value = capture(); return serial(() => operation(value)); }
        catch (error) { return serial(async () => { throw error; }); }
    }
    async function request(value: z.infer<typeof requestSchema>) {
        if (!transport) throw new ReplayDependency("offline_model_request", "Offline replay cannot send model requests.");
        if (environmentUnverified) throw new ReplayDependency(environmentStop.code, environmentStop.message);
        await task(value.taskId);
        const payload = boundedRequest(value.body, value.protocol, input.model!, input.maxOutputTokens!);
        const evidenceInput = { ...value, body: payload, requestEnvironment: identity.requestEnvironment }, previous = existing(value.id, "model", evidenceInput);
        let output;
        if (previous) output = object(previous.output);
        else {
            if (journal.entries.some(entry => entry.state === "pending")) throw new ReplayDependency("inference_outcome_unknown", "Reconcile the pending model request before making another.");
            if (journal.calls >= input.maxCalls!) throw new ReplayDependency("call_budget_exhausted", "The model-call limit is exhausted.");
            const next = snapshotInput(journal), entry: Entry = { id: value.id, kind: "model", input: snapshotInput(evidenceInput), inputDigest: hash(evidenceInput), state: "pending" };
            next.calls++; next.entries.push(entry); await commit(next);
            try { output = await transport.send(payload, value.protocol); }
            catch { throw new ReplayDependency("inference_outcome_unknown", "Reconcile the pending model request before retrying."); }
            const completed = snapshotInput(journal); record(completed.entries[completed.entries.length - 1]!, output); await commit(completed);
        }
        if (output.requestEnvironment !== identity.requestEnvironment) { environmentUnverified = true; throw new ReplayDependency(environmentStop.code, environmentStop.message); }
        if (typeof output.status !== "number" || output.status < 200 || output.status >= 300) throw new ReplayDependency(`inference_http_${output.status}`, "Inspect the recorded HTTP response before another request.");
        if (typeof output.raw !== "string" || !output.requestId || output.effectiveModel !== input.model) throw new ReplayDependency("unverified_model_provenance", "Verify which model served the recorded request before reviewing it.");
        return snapshotInput({ ...decodeCandidate(output.raw, value.protocol), receipt: { ...output, requestDigest: hash(payload), responseDigest: digest(output.raw) } });
    }
    async function mockTool(value: z.infer<typeof toolSchema>) {
        const loaded = await task(value.taskId), previous = existing(value.id, "tool", value);
        if (previous) return expose(previous.output);
        toolBudget();
        if (environment && !environment.recordedTools.includes(value.call.name)) return recordTool("tool", value, gap(value.call.id, "tool_environment_mode_mismatch", "This tool is not declared for recorded replay. Use its reviewed simulation handler."));
        const sourceRequest = loaded.requests.find(r => r.turnId === value.turnId), definition = definitions(sourceRequest).find(item => item.name === value.call.name);
        const observed = loaded.task.exchanges.some(e => e.turnId === value.turnId && e.toolName === value.call.name);
        const error = (code: string, message: string) => rejection(value.call.id, code, message);
        const unavailable = (code: string, message: string) => legacy ? error(code, message) : gap(value.call.id, code, message);
        let output: Record<string, unknown>;
        if (!sourceRequest) output = unavailable("tool_source_unavailable", "The selected replay step has no captured tool contract.");
        else if (!definition && !observed) output = error("unexpected_tool_call", "This tool is not declared or recorded at the selected replay step.");
        else {
            const schema = value.schema ?? (sourceRequest.protocol === "messages" ? definition?.input_schema : definition?.parameters);
            let validate: ReturnType<typeof compileSchema> | undefined;
            if (schema === undefined) output = unavailable("tool_schema_unavailable", "Supply a reviewed tool schema in the local harness.");
            else {
                try { validate = compileSchema(schema); }
                catch (failure) { output = unavailable(failure instanceof ReplayDependency ? failure.code : "unsupported_tool_schema", "The local tool schema is unsupported. Review the environment contract."); }
                if (validate) {
                    let args: unknown, valid = false;
                    try { args = parseArguments(Object.hasOwn(value, "effectiveArguments") ? value.effectiveArguments : value.call.arguments); valid = !!validate(args); } catch { /* Supported contract rejects malformed arguments. */ }
                    if (!valid) output = error("invalid_tool_arguments", "Arguments do not match the tool schema. Correct the call using the task context.");
                    else {
                        const normalized = canonical(args);
                        const fixture = loaded.task.exchanges.find(e => e.turnId === value.turnId && e.toolName === value.call.name && e.normalizedArguments === normalized && e.hasResult && !e.technicalCauses.length && !consumed.has(canonical([value.caseId, value.taskId, value.turnId, e.toolName, normalized, e.occurrence])));
                        if (!fixture) output = unavailable("recorded_result_unavailable", "No unused exact recorded result matches this call. Add a reviewed environment handler or recording before replay.");
                        else {
                            const fixtureKey = canonical([value.caseId, value.taskId, value.turnId, fixture.toolName, normalized, fixture.occurrence]);
                            output = { id: value.call.id, result: fixture.result, isError: fixture.resultIsError, fixtureKey, ...(legacy ? {} : { provenance: "recorded" }) };
                        }
                    }
                }
            }
        }
        const result = await recordTool("tool", value, output!);
        if (typeof result.fixtureKey === "string") consumed.add(result.fixtureKey);
        return result;
    }
    async function simulateTool(value: z.infer<typeof simulationSchema>) {
        const loaded = await task(value.taskId), previous = existing(value.id, "simulation", value);
        if (previous) return expose(previous.output);
        toolBudget();
        if (!environment) return recordTool("simulation", value, gap(value.call.id, "tool_environment_missing", "Supply a reviewed tool environment for simulation."));
        if (environment.recordedTools.includes(value.call.name)) return recordTool("simulation", value, gap(value.call.id, "tool_environment_mode_mismatch", "This tool is declared for strict recorded replay and has no simulation handler."));
        const sourceRequest = loaded.requests.find(r => r.turnId === value.turnId);
        if (!sourceRequest) return recordTool("simulation", value, gap(value.call.id, "tool_source_unavailable", "The selected replay step has no captured tool contract."));
        const key = caseKey(value), before = states.has(key) ? states.get(key) : environment.initialState;
        const declaredTool = definitions(sourceRequest).some(tool => tool.name === value.call.name);
        const transition = declaredTool ? environment.execute(value.call.name, value.call.arguments, before, { ...environment.context, ...value.context }, { id: value.id, taskId: value.taskId, turnId: value.turnId, caseId: value.caseId, attemptId: value.attemptId }) :
            { kind: "environment_gap", stateBefore: before, stateAfter: before, handlerVersion: null, contractVersion: environment.version, code: "tool_handler_unavailable", message: "The selected replay step has no declared tool contract for this handler." };
        const output = { id: value.call.id, isError: transition.kind !== "success", provenance: transition.kind === "environment_gap" ? "environment_gap" : "simulated", productionAction: false,
            ...(transition.kind === "environment_gap" ? {} : { result: "result" in transition ? transition.result : rejection(value.call.id, transition.code!, transition.message!).result }),
            receipt: { kind: "simulated", outcome: transition.kind, taskId: value.taskId, caseId: value.caseId, attemptId: value.attemptId,
                environmentDigest: environment.digest, contractVersion: transition.contractVersion, handlerVersion: transition.handlerVersion,
                stateBefore: transition.stateBefore, stateAfter: transition.stateAfter, stateBeforeDigest: hash(transition.stateBefore), stateAfterDigest: hash(transition.stateAfter),
                ...(transition.code ? { code: transition.code, message: transition.message } : {}) } };
        const result = await recordTool("simulation", value, output);
        states.set(key, snapshotInput(transition.stateAfter));
        return result;
    }
    await storage.write(path.join(directory, "harness.cjs"), source);
    if (environment) { await storage.write(path.join(directory, "environment.cjs"), environment.source); await saveReport(); }
    await commit({ ...journal });
    delete journal.stop; delete journal.harnessResult;
    try {
        const module = { exports: undefined as unknown };
        new Script(source.toString("utf8"), { filename: "private-harness.cjs" }).runInNewContext({ module, URL, TextEncoder, TextDecoder, structuredClone }, { timeout: 5000 });
        if (typeof module.exports !== "function") throw new CliError("The private harness must assign an async function to module.exports.");
        const result = await module.exports(Object.freeze({ model: input.model ?? null, taskIds: tasks.tasks.map(t => t.id), task,
            environment: environment ? snapshotInput({ version: environment.version, digest: environment.digest, context: environment.context, validation: environment.report }) : null,
            request: (value: unknown) => prepare(() => snapshotInput(requestSchema.parse(value)), request),
            mockTool: (value: unknown) => prepare(() => snapshotInput(toolSchema.parse(value)), mockTool),
            simulateTool: (value: unknown) => prepare(() => snapshotInput(simulationSchema.parse(value)), simulateTool), appendToolResults: appendResults }));
        accepting = false; await queue;
        if (!legacy && cursor < originalEntries) throw new CliError("The resumed harness did not consume every recorded operation in order.");
        journal.harnessResult = snapshotInput(result ?? null);
    } catch (error) {
        accepting = false; await queue;
        journal.stop = { code: error instanceof ReplayDependency ? error.code : "harness_error", message: error instanceof CliError ? error.message : "Inspect and revise the private harness before resuming." };
    }
    if (persistenceFailed) throw new ReplayDependency("replay_persistence_failed", "The journal commit could not be confirmed. Resume from saved evidence before another operation.");
    if (environmentUnverified) { journal.stop = environmentStop; delete journal.harnessResult; }
    if (journal.entries.some(entry => entry.state === "pending")) { journal.stop = { code: "inference_outcome_unknown", message: "Reconcile the pending request. Resuming will not send it again." }; delete journal.harnessResult; }
    if (gapStop) { journal.stop = gapStop; delete journal.harnessResult; }
    await commit({ ...journal }); return receipt();
}
