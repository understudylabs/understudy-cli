# Vercel AI SDK

Use this add-on only when a selected call is owned by `ai` or an
`@ai-sdk/*` provider. It supplements, rather than replaces, the shared setup
workflow. The provider adapters do not necessarily follow the official
OpenAI or Anthropic SDK contracts.

## Establish the installed contract

Inspect the manifest, lockfile, imports, and installed type definitions without
reading environment values. Record the locked major versions of `ai` and every
`@ai-sdk/*` provider. Find:

- `generateText`, `streamText`, `generateObject`, `streamObject`, and tool-loop
  entry points;
- `createOpenAI`, `createAnthropic`, and `createOpenAICompatible` factories;
- provider calls such as `.chat(...)`, `.responses(...)`, or `.chatModel(...)`;
- string model identifiers such as `"openai/example-model"`;
- shared providers, dynamic model selection, middleware, registries, and
  custom transports; and
- embeddings, images, audio, transcription, speech, and legacy Completions.

Classify the resolved protocol for each text call, not merely its package:
OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. Mark other
operations unsupported unless the current Understudy contract explicitly
supports their exact endpoint and response shape.

AI SDK defaults have changed between major versions. In newer
`@ai-sdk/openai` versions, calling the provider directly can select Responses;
older versions commonly selected Chat Completions. Inspect the installed
provider implementation or types when the call does not select `.chat(...)` or
`.responses(...)` explicitly. Leave the call unresolved when its protocol
cannot be proved.

A string model identifier can be resolved by the framework's model gateway
rather than by an OpenAI-compatible provider. Do not redirect that gateway by
guessing a base URL. For a selected string-model call, propose replacing only
its model boundary with an explicit provider instance after proving the
protocol and showing the change in the preview.

## Respect the shared provider boundary

Provider-level `baseURL`, `apiKey`, and `headers` affect every call using that
provider instance. Group all such calls together. If selected and unselected
calls share the provider, include the group, isolate the selected calls behind
a reviewed provider instance, or exclude them.

When supported by the installed AI SDK version, prefer request-level `headers`
on `generateText`, `streamText`, and related calls when one shared provider
serves several Understudy workloads. Otherwise use the application's existing
provider factory or registry. Do not create a provider on every request merely
to change metadata.

For every adapter below, `x-understudy-project` takes the selected project's
`slug` and `x-understudy-workload` takes the selected workload's `name`, not
management IDs or the project display name. The examples name these application
settings `UNDERSTUDY_PROJECT_SLUG` and `UNDERSTUDY_WORKLOAD_NAME`; `keys exec`
does not supply them.

## Configure OpenAI

`@ai-sdk/openai` appends the operation path to `baseURL`. The Understudy prefix
has this shape:

```text
https://api.understudylabs.com/v1
```

Use runtime-provided values and fail closed before constructing the provider:

```ts
import { createOpenAI } from "@ai-sdk/openai";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required runtime setting: ${name}`);
  return value;
}

const understudyOpenAI = createOpenAI({
  apiKey: requiredEnv("UNDERSTUDY_API_KEY"),
  baseURL: requiredEnv("UNDERSTUDY_OPENAI_BASE_URL"),
  headers: {
    "x-understudy-project": requiredEnv("UNDERSTUDY_PROJECT_SLUG"),
    "x-understudy-workload": requiredEnv("UNDERSTUDY_WORKLOAD_NAME"),
  },
});
```

Use `.chat(modelId)` only for a call proved to use Chat Completions. Use
`.responses(modelId)` only for a call proved to use Responses and after current
Understudy access for that endpoint has been verified. Never turn an implicit
provider call into either method based only on its model name.

The current Understudy Responses path can be more narrowly enabled than Chat
Completions. Keep it in managed mode.

## Configure Anthropic

`@ai-sdk/anthropic` treats `baseURL` as the prefix to which it appends
`/messages`. For supported current versions, the Understudy prefix therefore
has this shape:

```text
https://api.understudylabs.com/v1
```

This differs from the direct `@anthropic-ai/sdk` reference, which receives the
host root and appends `/v1/messages`. Do not reuse the direct SDK value.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

const understudyAnthropic = createAnthropic({
  apiKey: requiredEnv("UNDERSTUDY_API_KEY"),
  baseURL: requiredEnv("UNDERSTUDY_AI_SDK_ANTHROPIC_BASE_URL"),
  headers: {
    "x-understudy-project": requiredEnv("UNDERSTUDY_PROJECT_SLUG"),
    "x-understudy-workload": requiredEnv("UNDERSTUDY_WORKLOAD_NAME"),
  },
});
```

The resulting model must continue using Anthropic Messages. Preserve any
provider options, beta headers, tool definitions, and content-block handling.

Keep this `/v1` setting separate from the direct Anthropic SDK's host-root setting
in a mixed application. These variable names are illustrative: adapt the existing
configuration or derive the verified prefix from the gateway origin. `keys exec`
does not populate SDK-specific base-URL variables.

## Configure OpenAI-compatible providers

For Understudy's supported text setup surface, use
`@ai-sdk/openai-compatible` as a distinct Chat Completions adapter. The package
can expose other model types, but those remain unsupported here. For a
compatible installed version, configure its provider with `name`, a `/v1`
`baseURL`, `apiKey`, and `headers`, then preserve the existing `chatModel(...)`
selection:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const understudyChat = createOpenAICompatible({
  name: "understudy",
  apiKey: requiredEnv("UNDERSTUDY_API_KEY"),
  baseURL: requiredEnv("UNDERSTUDY_OPENAI_BASE_URL"),
  headers: {
    "x-understudy-project": requiredEnv("UNDERSTUDY_PROJECT_SLUG"),
    "x-understudy-workload": requiredEnv("UNDERSTUDY_WORKLOAD_NAME"),
  },
});
```

Do not use this adapter for Responses or Anthropic Messages.

## Authentication and behavior

Passing an undefined `apiKey` can cause a provider to fall back to its native
provider environment variable. Require and validate `UNDERSTUDY_API_KEY`; do
not fall back to `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or the previous base
URL. Such a fallback could send a provider credential as Understudy
authentication or bypass Understudy entirely.

Setup supports managed mode only. Understudy supplies the upstream credential.
Do not forward an existing provider credential.

Preserve the application's existing:

- model and Chat, Responses, or Messages selection;
- `generateText`, `streamText`, object-generation, and result-consumption form;
- tools, schemas, middleware, provider options, and response parsing; and
- retry, timeout, abort, fallback, and error-handling behavior.

Do not convert generation to streaming or streaming to generation. Do not add
another gateway or telemetry provider around an existing one without an
explicit topology decision.

## Verify

Typecheck against the locked packages. Run the approved synthetic application
command for each selected workload and let its normal result consumer finish.
Use the response metadata exposed by the installed AI SDK version to record the
`x-understudy-request-id`, then require its logged project/workload IDs to match
the selected resources. HTTP success can still accompany default-workload
fallback from incorrect header values. If the application discards response
headers, apply the shared [request correlation](request-correlation.md) procedure
using the installed SDK's supported response or transport hook and existing
persistence. Preserve generation/stream consumption; if no usable hook exists,
report the request-specific verification gap.

Confirm by inspection or an existing local unit test that every unselected call
still resolves through its original provider and protocol.

Follow the [main skill](../SKILL.md#4-apply-check-and-commit-the-application-integration)
for branch coverage, committing, activation, exact log reconciliation and dashboard
confirmation. A successful SDK request alone does not complete onboarding.
