import { object, type ObjectValue } from "./contracts.js";
export function canonical(value: unknown): string {
    if (value === null || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
            throw new Error("unsupported_number");
        return JSON.stringify(value);
    }
    if (typeof value === "string")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(object(value)[key])}`).join(",")}}`;
    throw new Error("non_json_value");
}
// Parse tool argument strings without allowing duplicate object keys to disappear.
export function parseArguments(input: unknown): unknown {
    if (typeof input !== "string") {
        canonical(input);
        return input;
    }
    let offset = 0;
    const whitespace = () => { while (/[ \t\r\n]/.test(input[offset] ?? "") && offset < input.length)
        offset++; };
    const string = (): string => {
        const start = offset++;
        while (offset < input.length) {
            const char = input[offset++];
            if (char === "\\")
                offset++;
            else if (char === '"')
                return JSON.parse(input.slice(start, offset)) as string;
        }
        throw new Error("invalid_json_string");
    };
    const value = (): unknown => {
        whitespace();
        const char = input[offset];
        if (char === '"')
            return string();
        if (char === "{" || char === "[") {
            offset++;
            const isObject = char === "{";
            const result: ObjectValue = Object.create(null);
            const list: unknown[] = [];
            const seen = new Set<string>();
            whitespace();
            if (input[offset] === (isObject ? "}" : "]")) {
                offset++;
                return isObject ? result : list;
            }
            for (;;) {
                whitespace();
                if (isObject) {
                    if (input[offset] !== '"')
                        throw new Error("invalid_object_key");
                    const key = string();
                    whitespace();
                    if (seen.has(key))
                        throw new Error("duplicate_argument_key");
                    seen.add(key);
                    if (input[offset++] !== ":")
                        throw new Error("invalid_json_object");
                    result[key] = value();
                }
                else
                    list.push(value());
                whitespace();
                const next = input[offset++];
                if (next === (isObject ? "}" : "]"))
                    return isObject ? result : list;
                if (next !== ",")
                    throw new Error("invalid_json_container");
            }
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(offset))?.[0];
        if (!token)
            throw new Error("invalid_json_value");
        offset += token.length;
        return JSON.parse(token);
    };
    const parsed = value();
    whitespace();
    if (offset !== input.length)
        throw new Error("invalid_json_suffix");
    canonical(parsed);
    return parsed;
}
function parseBody(value: unknown): unknown {
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
export interface Message {
    role: string;
    content: unknown[];
}
// A result can retain its causal call even when an application repacks messages.
// Require the captured identity, tool name, and exact normalized arguments.
export function outputCallKeys(messages: Message[]): string[] {
    return messages.flatMap(message => message.content.flatMap(raw => {
        const block = object(raw);
        if (block.type !== "call" || typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name) return [];
        try { return [canonical([block.id, block.name, parseArguments(block.arguments)])]; } catch { return []; }
    }));
}
export function completedCallKeys(messages: Message[]): Set<string> {
    const calls = new Map<string, Set<string>>(), completed = new Set<string>();
    for (const message of messages) for (const raw of message.content) {
        const block = object(raw);
        if (typeof block.id !== "string" || !block.id) continue;
        if (block.type === "call") {
            const keys = calls.get(block.id) ?? new Set<string>();
            for (const key of outputCallKeys([{ role: message.role, content: [block] }])) keys.add(key);
            calls.set(block.id, keys);
            if (keys.size > 1) for (const key of keys) completed.delete(key);
        } else if (block.type === "result") {
            const keys = calls.get(block.id);
            if (keys?.size === 1) completed.add([...keys][0]!);
        }
    }
    return completed;
}
function blocks(value: unknown): unknown[] { return Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [{ type: "text", text: value }]; }
export function messages(value: unknown): Message[] {
    if (typeof value === "string")
        return [{ role: "user", content: blocks(value) }];
    if (!Array.isArray(value))
        return [];
    return value.map((item): Message => {
        const m = object(item);
        if (m.type === "function_call")
            return { role: "assistant", content: [{ type: "call", id: m.call_id ?? m.id ?? null, name: m.name ?? null, arguments: m.arguments ?? null }] };
        if (m.type === "function_call_output")
            return { role: "tool", content: [{ type: "result", id: m.call_id ?? null, result: m.output ?? null }] };
        if (m.role === "function")
            return { role: "tool", content: [{ type: "result", legacy: true, name: m.name ?? null, result: m.content ?? null }] };
        if (m.role === "tool")
            return { role: "tool", content: [{ type: "result", id: m.tool_call_id ?? null, result: m.content ?? null }] };
        const content = blocks(m.content).map((value) => {
            const b = object(value);
            if (b.type === "tool_use")
                return { type: "call", id: b.id ?? null, name: b.name ?? null, arguments: b.input ?? null };
            if (b.type === "tool_result")
                return { type: "result", id: b.tool_use_id ?? null, result: b.content ?? null, isError: b.is_error === true };
            if (["input_text", "output_text", "text"].includes(String(b.type)))
                return { type: "text", text: b.text };
            return b;
        });
        if (m.function_call !== undefined) {
            const fn = object(m.function_call);
            content.push({ type: "call", legacy: true, name: fn.name ?? null, arguments: fn.arguments ?? null });
        }
        for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
            const c = object(call), fn = object(c.function);
            content.push({ type: "call", id: c.id ?? null, name: fn.name ?? null, arguments: fn.arguments ?? null });
        }
        return { role: String(m.role ?? "unknown"), content };
    });
}
export interface StreamDiagnostic { code: string; message: string }
class StreamDecodeError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}
interface StreamCall {
    id?: string; name?: string; arguments: string; hasArguments: boolean;
    index?: number; sealed: boolean;
}
// Only a closed container can establish an indexless boundary. A scalar such
// as `1` could still be the prefix of `12`. Strict argument validation happens
// later: duplicate JSON keys are model output errors, not stream errors.
function closedArguments(call: StreamCall): boolean {
    try {
        const value = JSON.parse(call.arguments);
        return value !== null && typeof value === "object";
    } catch { return false; }
}
function toolCallAssembler() {
    const calls: StreamCall[] = [], indexed = new Map<number, StreamCall>(), identities = new Map<string, StreamCall>();
    const reject = (code: string, message: string): never => { throw new StreamDecodeError(code, message); };
    return {
        add(raw: unknown) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                reject("invalid_tool_call_fragment", "Each streamed tool-call fragment must be a JSON object.");
            const c = object(raw);
            if (c.function !== undefined && (!c.function || typeof c.function !== "object" || Array.isArray(c.function)))
                reject("invalid_tool_call_fragment", "A streamed function fragment must be a JSON object.");
            const fn = object(c.function);
            if (c.index !== undefined && (typeof c.index !== "number" || !Number.isSafeInteger(c.index) || c.index < 0))
                reject("invalid_tool_call_index", "A streamed tool-call index must be a non-negative safe integer.");
            if ((c.id !== undefined && (typeof c.id !== "string" || !c.id)) || (fn.name !== undefined && (typeof fn.name !== "string" || !fn.name)))
                reject("invalid_tool_call_identity", "A streamed tool-call identity or name is invalid.");
            if (fn.arguments !== undefined && typeof fn.arguments !== "string")
                reject("invalid_tool_call_fragment", "Streamed tool arguments must be string fragments.");
            let call: StreamCall | undefined;
            if (c.index !== undefined) call = indexed.get(c.index as number);
            else if (c.id !== undefined) call = identities.get(c.id as string);
            else {
                const open = calls.filter(call => !call.sealed);
                if (fn.name !== undefined || open.length !== 1)
                    reject("ambiguous_tool_call_boundary", "An indexless tool fragment has no unambiguous call identity or boundary.");
                call = open[0];
            }
            if (!call) {
                if (c.index === undefined && (c.id === undefined || fn.name === undefined))
                    reject("missing_tool_call_identity", "A new indexless tool call must supply its identity and name.");
                if (c.id !== undefined && identities.has(c.id as string))
                    reject("duplicate_tool_call_id", "Distinct streamed tool calls reuse an identity.");
                // A new identity closes only complete indexless containers. Any
                // overlapping unfinished calls require explicitly identified fragments.
                for (const prior of calls) if (prior.index === undefined && closedArguments(prior)) prior.sealed = true;
                call = { arguments: "", hasArguments: false, index: c.index as number | undefined, sealed: false };
                calls.push(call);
                if (call.index !== undefined) indexed.set(call.index, call);
            } else {
                if ((c.id !== undefined && call.id !== undefined && c.id !== call.id) || (fn.name !== undefined && call.name !== undefined && fn.name !== call.name))
                    reject("conflicting_tool_call_identity", "A streamed tool call changes its identity or name.");
                if (call.sealed || (c.index === undefined && fn.name !== undefined && call.name !== undefined))
                    reject("duplicate_tool_call_id", "An indexless tool call repeats start metadata or reopens a completed identity.");
            }
            if (c.id !== undefined) {
                const owner = identities.get(c.id as string);
                if (owner && owner !== call) reject("duplicate_tool_call_id", "Distinct streamed tool calls reuse an identity.");
                call.id = c.id as string; identities.set(call.id, call);
            }
            if (fn.name !== undefined) call.name = fn.name as string;
            if (fn.arguments !== undefined) { call.arguments += fn.arguments as string; call.hasArguments = true; }
        },
        calls,
    };
}
interface DecodedStream { response: unknown; streamComplete: boolean | null; streamDiagnostic?: StreamDiagnostic }
function streamed(value: unknown): DecodedStream {
    try { return decodeStream(value); }
    catch (error) {
        if (!(error instanceof StreamDecodeError)) throw error;
        // Never expose guessed calls to shared capture parsing or replay. The
        // original bytes remain the response evidence for a rejected stream.
        return { response: value, streamComplete: null, streamDiagnostic: { code: error.code, message: error.message } };
    }
}
function decodeStream(value: unknown): DecodedStream {
    if (typeof value !== "string") return { response: value, streamComplete: null };
    try { return { response: JSON.parse(value), streamComplete: null }; } catch { /* An event stream is not a JSON document. */ }
    if (!/(^|\r?\n)data:/.test(value)) return { response: value, streamComplete: null };
    const events: ObjectValue[] = [];
    let done = false;
    for (const line of value.split(/\r?\n/).filter(line => line.startsWith("data:"))) {
        const data = line.slice(5).trim();
        if (!data) continue;
        if (done) throw new StreamDecodeError("event_after_stream_completion", "The stream contains data after its completion marker.");
        if (data === "[DONE]") { done = true; continue; }
        let event: unknown;
        try { event = JSON.parse(data); }
        catch { throw new StreamDecodeError("invalid_stream_event", "A stream event is not valid JSON; inspect the retained raw response."); }
        if (!event || typeof event !== "object" || Array.isArray(event)) throw new StreamDecodeError("invalid_stream_event", "A stream event must be a JSON object.");
        events.push(object(event));
    }
    const completed = events.findLast((event) => event.type === "response.completed");
    if (completed)
        return { response: completed.response, streamComplete: true };
    let text = "", finish: unknown = null;
    const assembler = toolCallAssembler();
    const content: ObjectValue[] = [];
    let legacy: { name?: unknown; arguments: string; hasArguments: boolean } | undefined;
    let anthropic = false;
    let id: unknown;
    let usage: ObjectValue | undefined;
    let streamError: unknown;
    for (const e of events) {
        if (e.type === "message_start") {
            anthropic = true;
            id = object(e.message).id;
            usage = object(object(e.message).usage);
        }
        if (e.type === "content_block_start")
            content[Number(e.index)] = { ...object(e.content_block) };
        if (e.type === "content_block_delta") {
            const b = content[Number(e.index)] ?? {};
            const delta = object(e.delta);
            if (delta.type === "text_delta")
                b.text = String(b.text ?? "") + String(delta.text ?? "");
            if (delta.type === "input_json_delta")
                b.partial = String(b.partial ?? "") + String(delta.partial_json ?? "");
            if (delta.type === "thinking_delta")
                b.thinking = String(b.thinking ?? "") + String(delta.thinking ?? "");
            if (delta.type === "signature_delta")
                b.signature = String(b.signature ?? "") + String(delta.signature ?? "");
            content[Number(e.index)] = b;
        }
        if (e.type === "message_delta") {
            finish = object(e.delta).stop_reason;
            if (e.usage) usage = { ...usage, ...object(e.usage) };
        }
        if (e.type === "error" || e.error) streamError = e.error ?? e;
        if (e.usage && e.type !== "message_delta") usage = object(e.usage);
        const choice = object((Array.isArray(e.choices) ? e.choices : [])[0]);
        const delta = object(choice.delta);
        if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls))
            throw new StreamDecodeError("invalid_tool_call_fragment", "Streamed tool calls must be an array of fragments.");
        if (finish && Array.isArray(delta.tool_calls) && delta.tool_calls.length)
            throw new StreamDecodeError("tool_call_after_finish", "The stream contains tool fragments after the choice finished.");
        if (finish && Object.entries(delta).some(([field, part]) => field !== "role" && part !== null && part !== undefined && part !== "" && !(Array.isArray(part) && !part.length)))
            throw new StreamDecodeError("output_after_finish", "The stream contains output after the choice finished.");
        if (typeof delta.content === "string")
            text += delta.content;
        if (delta.function_call !== undefined) {
            if (!delta.function_call || typeof delta.function_call !== "object" || Array.isArray(delta.function_call))
                throw new StreamDecodeError("invalid_tool_call_fragment", "A streamed legacy function fragment must be a JSON object.");
            const fn = object(delta.function_call);
            if (fn.arguments !== undefined && typeof fn.arguments !== "string")
                throw new StreamDecodeError("invalid_tool_call_fragment", "Streamed legacy tool arguments must be string fragments.");
            legacy = { name: fn.name ?? legacy?.name, arguments: (legacy?.arguments ?? "") + (fn.arguments ?? ""), hasArguments: legacy?.hasArguments === true || fn.arguments !== undefined };
        }
        for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            assembler.add(raw);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (anthropic)
        return { response: { id, content: content.filter(Boolean).map(({ partial, ...block }) => block.type === "tool_use" && typeof partial === "string" ? { ...block, input: streamedToolInput(partial) } : block), stop_reason: finish, ...(usage ? { usage } : {}), ...(streamError ? { error: streamError } : {}) }, streamComplete: events.some(event => event.type === "message_stop") };
    const calls = assembler.calls;
    const incompleteCall = calls.some(call => !call.id || !call.name || !call.hasArguments) || !!legacy && (typeof legacy.name !== "string" || !legacy.name || !legacy.hasArguments);
    const complete = done && !!finish && (!(calls.length || legacy) || (finish !== "length" && !incompleteCall));
    return { response: { choices: [{ message: { role: "assistant", content: text, ...(legacy ? { function_call: { name: legacy.name ?? null, arguments: legacy.arguments } } : {}), tool_calls: calls.map((c) => ({ id: c.id ?? null, type: "function", function: { name: c.name ?? null, arguments: c.arguments } })) }, finish_reason: finish }], ...(usage ? { usage } : {}), ...(streamError ? { error: streamError } : {}) }, streamComplete: complete,
        ...(!complete ? { streamDiagnostic: { code: "inference_stream_incomplete", message: incompleteCall ? "A streamed tool call is missing its identity, name, or argument fragments." : "The stream is missing complete choice or stream termination evidence." } } : {}) };
}
function streamedToolInput(value: string): unknown {
    try {
        return parseArguments(value);
    } catch {
        // Preserve invalid argument bytes so fixture planning can flag them.
        return value;
    }
}
export interface Interaction {
    requestId: string;
    traceId: string | null;
    explicitTaskId: string | null;
    previousResponseId: string | null;
    parentRequestId: string | null;
    responseId: string | null;
    request: ObjectValue;
    response: unknown;
    history: Message[];
    output: Message[];
    terminal: boolean;
    failed: boolean;
    streamComplete: boolean | null;
    streamDiagnostic: StreamDiagnostic | null;
    rawResponse?: unknown;
    timestamp: number;
}
export function interaction(envelope: ObjectValue): Interaction {
    const request = object(parseBody(envelope.customer_request_body ?? envelope.request_body ?? envelope.request));
    const decoded = streamed(envelope.customer_response_body ?? envelope.response_body ?? envelope.response);
    const response = object(decoded.response);
    const choice = object((Array.isArray(response.choices) ? response.choices : [])[0]);
    const output = Array.isArray(response.output) ? messages(response.output) : Object.keys(object(choice.message)).length ? messages([choice.message]) : response.content !== undefined ? messages([{ role: "assistant", content: response.content }]) : [];
    const history = messages(request.messages ?? request.input);
    const hasCalls = output.some((m) => m.content.some((b) => object(b).type === "call"));
    const finished = response.status === "completed" || choice.finish_reason === "stop" || response.stop_reason === "end_turn";
    const str = (v: unknown) => typeof v === "string" && v ? v : null;
    const streamDiagnostic = decoded.streamDiagnostic ?? (decoded.streamComplete === false ? { code: "inference_stream_incomplete", message: "The stream is missing its completion marker." } : null);
    return { requestId: String(envelope.request_id), traceId: str(envelope.trace_id), explicitTaskId: str(envelope.task_id), previousResponseId: str(request.previous_response_id), parentRequestId: str(envelope.parent_request_id), responseId: str(response.id), request, response: decoded.response, history, output,
        terminal: finished && !hasCalls && output.length > 0 && !streamDiagnostic && !response.error,
        failed: Number(envelope.status_code ?? 200) >= 400 || response.error !== undefined || response.status === "failed",
        streamComplete: decoded.streamComplete,
        streamDiagnostic,
        ...(streamDiagnostic ? { rawResponse: envelope.customer_response_body ?? envelope.response_body ?? envelope.response } : {}),
        timestamp: Date.parse(String(envelope.ts ?? envelope.captured_at ?? "")) };
}
