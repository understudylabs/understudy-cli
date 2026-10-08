import { z } from "zod";

import { CliError } from "../errors.js";
import type { InferenceCredential } from "./credentials.js";
import { REQUEST_ENVIRONMENT_HEADER, TEST_REQUEST_ENVIRONMENT } from "./request-environment.js";

const inferenceModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
});

const openAiTestResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().min(1) }).passthrough(),
      }).passthrough(),
    )
    .min(1),
});

const anthropicTestResponseSchema = z.object({
  content: z.array(z.unknown()).refine(
    (blocks) =>
      blocks.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string" &&
          block.text.length > 0,
      ),
    "Expected a non-empty text block.",
  ),
});

const inferenceModeSchema = z.enum(["managed", "byo"]);
const inferenceRouteSchema = z.enum(["primary", "understudy", "fallback"]);
const diagnosticHeaderPattern = /^[\x20-\x7e]{1,255}$/;
const completionTokenFloor = 64;
const maxTokenFloors: Readonly<Record<string, number>> = {
  "grok-4.3": 16,
  "nemotron-3-ultra": 16,
  "nemotron-3-ultra-nvfp4": 16,
};

export type InferenceApi = "openai" | "anthropic";

export interface InferenceTestResult {
  ok: true;
  requestEnvironment: typeof TEST_REQUEST_ENVIRONMENT;
  api: InferenceApi;
  requestId: string;
  project: string;
  workload: string;
  requestedModel: string;
  effectiveModel: string;
  mode: z.infer<typeof inferenceModeSchema>;
  route: z.infer<typeof inferenceRouteSchema>;
  latencyMs: number;
}

interface InferenceTestOptions {
  credential: InferenceCredential;
  api: InferenceApi;
  project: string;
  workload: string;
  model: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

export async function countInferenceModels(
  credential: InferenceCredential,
  fetchImplementation: typeof fetch = fetch,
): Promise<number> {
  return (await readInferenceModels(credential, fetchImplementation)).data.length;
}

export async function readInferenceModels(
  credential: InferenceCredential,
  fetchImplementation: typeof fetch = fetch,
): Promise<z.infer<typeof inferenceModelsSchema>> {
  let response: Response;
  try {
    response = await fetchImplementation(
      `${credential.inferenceUrl.replace(/\/+$/, "")}/v1/models`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new CliError(
      "Understudy access could not be verified. Try again shortly.",
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CliError(
        `Understudy access verification failed (${response.status}). Run \`understudy setup --replace\` to replace the stored credential.`,
      );
    }
    throw new CliError(
      `Understudy access verification failed (${response.status}). Try again shortly.`,
    );
  }

  try {
    return inferenceModelsSchema.parse(await response.json());
  } catch {
    throw new CliError(
      "Understudy returned an invalid access verification response. Try again shortly.",
    );
  }
}

export async function testInference(
  options: InferenceTestOptions,
): Promise<InferenceTestResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const isAnthropic = options.api === "anthropic";
  let response: Response;
  try {
    response = await (options.fetchImplementation ?? fetch)(
      `${options.credential.inferenceUrl.replace(/\/+$/, "")}${
        isAnthropic ? "/v1/messages" : "/v1/chat/completions"
      }`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          ...(isAnthropic
            ? {
                "anthropic-version": "2023-06-01",
                "x-api-key": options.credential.apiKey,
              }
            : {
                authorization: `Bearer ${options.credential.apiKey}`,
              }),
          "content-type": "application/json",
          "x-understudy-project": options.project,
          "x-understudy-workload": options.workload,
          [REQUEST_ENVIRONMENT_HEADER]: TEST_REQUEST_ENVIRONMENT,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          ...(isAnthropic
            ? { max_tokens: 8 }
            : openAiTestTokenParams(options.model, 8)),
          stream: false,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new CliError(
      "The test outcome is unknown because Understudy did not return a response. Check reporting before retrying.",
    );
  }

  const requestId = diagnosticHeader(
    response.headers.get("x-understudy-request-id"),
  );
  if (response.headers.get(REQUEST_ENVIRONMENT_HEADER) !== TEST_REQUEST_ENVIRONMENT) {
    throw new CliError(
      `Understudy did not confirm the test environment (HTTP ${response.status})${requestId ? ` for request ${requestId}` : ""}. Check reporting before retrying.`,
    );
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CliError(
        `Understudy test failed (${response.status})${requestId ? `, request ${requestId}` : ""}. Run \`understudy setup --replace\` to replace the stored credential.`,
      );
    }
    throw new CliError(
      `Understudy test failed (${response.status})${requestId ? `, request ${requestId}` : ""}.`,
    );
  }

  const effectiveModel = diagnosticHeader(
    response.headers.get("x-understudy-effective-model"),
  );
  const mode = inferenceModeSchema.safeParse(
    response.headers.get("x-understudy-mode"),
  );
  const route = inferenceRouteSchema.safeParse(
    response.headers.get("x-understudy-route"),
  );
  let validBody = false;
  try {
    const responseBody = await response.json();
    validBody = (isAnthropic
      ? anthropicTestResponseSchema
      : openAiTestResponseSchema
    ).safeParse(responseBody).success;
  } catch {
    validBody = false;
  }
  if (
    !requestId ||
    !effectiveModel ||
    !mode.success ||
    !route.success ||
    !validBody
  ) {
    throw new CliError(
      `Understudy returned an incomplete test response${requestId ? ` for request ${requestId}` : ""}.`,
    );
  }

  return {
    ok: true,
    requestEnvironment: TEST_REQUEST_ENVIRONMENT,
    api: options.api,
    requestId,
    project: options.project,
    workload: options.workload,
    requestedModel: options.model,
    effectiveModel,
    mode: mode.data,
    route: route.data,
    latencyMs: Math.max(0, now() - started),
  };
}

function openAiTestTokenParams(
  model: string,
  maxTokens: number,
): { max_tokens: number } | { max_completion_tokens: number } {
  const unqualifiedModel = model.split(/[/:]/).at(-1) ?? model;
  if (
    unqualifiedModel === "chat-latest" ||
    /^(gpt-5|o[0-9])/.test(unqualifiedModel)
  ) {
    return {
      max_completion_tokens: Math.max(maxTokens, completionTokenFloor),
    };
  }
  return {
    max_tokens: Math.max(maxTokens, maxTokenFloors[unqualifiedModel] ?? 0),
  };
}

function diagnosticHeader(value: string | null): string | null {
  return value !== null && diagnosticHeaderPattern.test(value) ? value : null;
}
