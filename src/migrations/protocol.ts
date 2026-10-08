import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { CliError } from "../errors.js";
import { object, type ObjectValue } from "./contracts.js";
import { interaction, parseArguments } from "./interactions.js";

export type Protocol = "chat" | "messages" | "responses";
export class ReplayDependency extends CliError {
    constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
export function protocolOf(request: ObjectValue): Protocol {
    if (request.input !== undefined) return "responses";
    if (request.system !== undefined || (Array.isArray(request.tools) && request.tools.some(t => object(t).input_schema !== undefined))) return "messages";
    if (Array.isArray(request.messages)) return "chat";
    throw new ReplayDependency("unsupported_request_protocol", "Replay needs a supported captured request protocol.");
}
export const endpoints: Record<Protocol, string> = { chat: "/v1/chat/completions", messages: "/v1/messages", responses: "/v1/responses" };
export function compileSchema(schema: unknown): ValidateFunction {
    if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema)))
        throw new ReplayDependency("invalid_success_schema", "Replay needs a valid reviewed JSON Schema.");
    if (JSON.stringify(schema).length > 256_000) throw new ReplayDependency("schema_size_limit", "Replay needs a bounded schema.");
    try {
        const ajv = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: false, validateFormats: true });
        const addFormats = addFormatsModule as unknown as (instance: Ajv) => void;
        addFormats(ajv);
        const validate = ajv.compile(schema);
        if ("$async" in validate && validate.$async === true) throw new Error("asynchronous_schema_not_supported");
        return validate;
    } catch (error) {
        throw new ReplayDependency("unsupported_schema", "Replay needs a supported self-contained JSON Schema.", { schemaError: error instanceof Error ? error.message : "schema_compilation_failed" });
    }
}
export interface CandidateCall { id: string; name: string; arguments: unknown }
export function decodeCandidate(raw: unknown, protocol: Protocol) {
    const normalized = interaction({ request_id: "candidate", request_body: {}, response_body: raw });
    if (normalized.streamDiagnostic) return {
        response: normalized.response, calls: [] as CandidateCall[], text: "", terminal: false, invalid: null, reason: null,
        dependency: normalized.streamComplete === false ? "inference_stream_incomplete" : "inference_stream_decode_error",
        diagnostic: normalized.streamDiagnostic,
    };
    const response = object(normalized.response);
    const calls: CandidateCall[] = [];
    let text = "", invalid: string | null = null;
    for (const message of normalized.output) for (const value of message.content) {
        const block = object(value);
        if (block.type === "call") {
            try {
                if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name) throw new Error();
                calls.push({ id: block.id, name: block.name, arguments: parseArguments(block.arguments) });
            } catch { invalid = "invalid_tool_call"; }
        } else if (block.type === "text" && typeof block.text === "string") text += block.text;
    }
    if (new Set(calls.map(c => c.id)).size !== calls.length) invalid = "duplicate_tool_call_id";
    const reason = protocol === "messages" ? response.stop_reason : protocol === "chat" ? object((response.choices as unknown[] | undefined)?.[0]).finish_reason : response.status;
    const terminal = !calls.length && (reason === "stop" || reason === "end_turn" || reason === "completed");
    if (!normalized.output.length) invalid = "missing_assistant_output";
    if (protocol === "messages" ? !Array.isArray(response.content) : protocol === "responses" ? !Array.isArray(response.output) : !Array.isArray(response.choices)) invalid = "response_protocol_mismatch";
    return { response: normalized.response, calls, text, terminal, invalid, reason, dependency: null, diagnostic: null };
}
type ToolResult = { id: string; result: unknown; isError: boolean };
export function appendResults(request: ObjectValue, protocol: Protocol, response: unknown, results: ToolResult[]): ObjectValue {
    if (results.some(result => !result || typeof result !== "object" || object(result).provenance === "environment_gap" || !Object.hasOwn(result, "result") || result.result === undefined))
        throw new ReplayDependency("tool_environment_gap", "An environment gap has no model-visible tool result. Review the tool environment before continuing.");
    const body = object(response);
    const resultContent = (value: unknown) => typeof value === "string" || Array.isArray(value) ? value : JSON.stringify(value);
    if (protocol === "messages" || protocol === "chat") {
        const messages = protocol === "messages"
            ? [...request.messages as unknown[], { role: "assistant", content: body.content }, { role: "user", content: results.map(r => ({ type: "tool_result", tool_use_id: r.id, content: resultContent(r.result), is_error: r.isError })) }]
            : [...request.messages as unknown[], object((body.choices as unknown[])[0]).message, ...results.map(r => ({ role: "tool", tool_call_id: r.id, content: resultContent(r.result) }))];
        const appended = { ...request, messages };
        return appended;
    }
    const input = Array.isArray(request.input) ? request.input : [{ role: "user", content: request.input }];
    const { previous_response_id, ...base } = request;
    return { ...base, input: [...input, ...body.output as unknown[], ...results.map(r => ({ type: "function_call_output", call_id: r.id, output: resultContent(r.result) }))] };
}
