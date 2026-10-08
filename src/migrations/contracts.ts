import { z } from "zod";
const text = z.string().min(1);
export const scopeSchema = z.object({
    organization: z.object({ id: text }),
    project: z.object({ id: text, slug: text, name: text }),
    workload: z.object({ id: text, name: text, captureEnabled: z.boolean() }),
});
export type Scope = z.infer<typeof scopeSchema>;
export const runSchema = z.object({
    schemaVersion: z.literal(1), runId: text, createdAt: text,
    scope: scopeSchema, mode: z.literal("mapping_only"),
    scopeOrigin: z.enum(["oauth", "private_export"]).optional(),
    captureWindow: z.object({ from: z.string().datetime(), to: z.string().datetime() }).optional(),
});
export type Run = z.infer<typeof runSchema>;
export interface CaptureRow {
    requestId: string;
    file: string;
    sha256: string;
    bytes: number;
}
export const captureIndexSchema = z.object({
    schemaVersion: z.literal(1),
    scope: scopeSchema,
    provenance: z.enum(["hosted_export", "private_import"]),
    rows: z.array(z.object({ requestId: text, file: text,
        sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })),
    gaps: z.array(z.object({ code: text, requestId: z.string().optional() })),
});
export type CaptureIndex = z.infer<typeof captureIndexSchema>;
export type ObjectValue = Record<string, unknown>;
export interface Exchange {
    taskId: string;
    turnId: string;
    toolName: string;
    callId: string;
    occurrence: number;
    arguments: unknown;
    normalizedArguments: string | null;
    result: unknown;
    hasResult: boolean;
    resultIsError: boolean;
    sourceRequestIds: string[];
    technicalCauses: string[];
    record?: { file: string; sha256: string };
}
export interface Turn {
    id: string;
    requestId: string;
    messages?: unknown[];
    response?: unknown;
    streamDiagnostic?: { code: string; message: string };
    rawResponse?: unknown;
    retryOf: string | null;
    terminal: boolean;
}
export interface Task {
    id: string;
    requestIds: string[];
    turns: Turn[];
    exchanges: Exchange[];
    terminalResponse?: unknown;
    complete: boolean;
    confidence: "high" | "low";
    technicalCauses: string[];
    detail?: { file: string; sha256: string; bytes: number };
}
export interface Reconstruction {
    schemaVersion: 1 | 2;
    sourceDigest: string;
    taskDigest: string;
    requests: number;
    traceCount: number;
    tasks: Task[];
    unresolved: {
        requestIds: string[];
        technicalCauses: string[];
    }[];
}
export const modelOutcomes = {
    Format: "the model did not speak the required protocol.",
    Action: "the model chose the wrong tool, arguments, or recovery.",
    Answer: "the final result was wrong.",
} as const;
export function object(value: unknown): ObjectValue {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as ObjectValue : {};
}
