# Anthropic Messages clients

Use this path only for selected calls that already use the Anthropic Messages
API or an Anthropic-compatible client. Preserve `/v1/messages`; do not translate
the call into OpenAI Responses or Chat Completions.

## Preconditions

- Before enabling traffic, the user approved these call sites and their
  project/workload mapping. Provisional local edits and offline checks may be
  prepared for that review as the main skill directs.
- An approved runtime secret mechanism outside the inspected repository can
  provide `UNDERSTUDY_API_KEY`. Never read, print, log, copy, or commit its
  value. If delivery is unavailable, prepare the scoped local configuration
  change and leave runtime provisioning/verification pending as the main skill
  directs; do not invent a credential export path.
- Runtime configuration can provide the non-secret base URL and metadata
  values shown below. Do not add a repository-local credential file.

## Find the configuration boundary

Locate every construction of `@anthropic-ai/sdk` or `anthropic.Anthropic` and
every wrapper or factory that returns one. Also search for:

- `messages.create`, `messages.stream`, and direct HTTP calls to
  `/v1/messages`;
- `baseURL`, `base_url`, custom HTTP clients/transports, proxies, and explicit
  `x-api-key`, `authorization`, or `anthropic-version` headers;
- retries, timeouts, cancellation, streaming, tool schemas, beta headers, and
  response parsing.

Do not assume a call is configurable merely because it imports the official
SDK. Treat hard-coded endpoint URLs, custom signing, and custom transports as a
separate patch path, and show that path to the user before editing it.

Changing a shared client's base URL changes every request made by that client.
If it serves selected and unselected calls, either obtain approval for the
whole group, isolate the selected calls behind a separate client/factory, or
skip them. Never silently route the unselected calls.

## Configure the official SDK

The official Anthropic clients append `/v1/messages` to `baseURL`/`base_url`.
The Understudy Anthropic-compatible value therefore has this shape:

```text
https://api.understudylabs.com
```

It must not end in `/v1` or `/v1/messages`. Supplying the Understudy credential
through the SDK's `apiKey`/`api_key` option lets the SDK emit the expected
`x-api-key` header. Do not add a second authorization header. The examples
below only reference runtime-provided values; provisioning those values is a
separate, approved operation.

Set `UNDERSTUDY_PROJECT_SLUG` to the selected project's `slug` and
`UNDERSTUDY_WORKLOAD_NAME` to the selected workload's `name`. These inference
headers do not accept management IDs or the project display name. `keys exec`
does not supply these application settings.

TypeScript:

```ts
import Anthropic from "@anthropic-ai/sdk";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required runtime setting: ${name}`);
  return value;
}

const client = new Anthropic({
  apiKey: requiredEnv("UNDERSTUDY_API_KEY"),
  baseURL: requiredEnv("UNDERSTUDY_ANTHROPIC_SDK_BASE_URL"),
  defaultHeaders: {
    "x-understudy-project": requiredEnv("UNDERSTUDY_PROJECT_SLUG"),
    "x-understudy-workload": requiredEnv("UNDERSTUDY_WORKLOAD_NAME"),
  },
});
```

Python:

```python
import os
from anthropic import Anthropic

client = Anthropic(
    api_key=os.environ["UNDERSTUDY_API_KEY"],
    base_url=os.environ["UNDERSTUDY_ANTHROPIC_SDK_BASE_URL"],
    default_headers={
        "x-understudy-project": os.environ["UNDERSTUDY_PROJECT_SLUG"],
        "x-understudy-workload": os.environ["UNDERSTUDY_WORKLOAD_NAME"],
    },
)
```

Setup supports managed mode only. Understudy supplies the upstream credential.
Do not forward an existing provider credential.

The example variable names are illustrative. Reuse the application's configuration
conventions, but keep this host-root value separate from an AI SDK Anthropic
adapter's `/v1` prefix. `keys exec` supplies `UNDERSTUDY_GATEWAY_URL` as an origin;
it does not populate either SDK-specific base-URL variable.

Prefer the application's existing configuration validator over adding the
illustrative helper above. Missing Understudy configuration must fail closed;
it must not fall back silently to a different provider or credential.

Set default headers only when every call made by that client belongs to the
same project and workload. When one client serves several workloads, attach
the two headers through the SDK's per-request options (`headers` in TypeScript,
`extra_headers` in Python), or use the application's existing client factory.
Do not create a new client for every request solely to change metadata.

## Preserve behavior

Change only the authentication reference, base URL, and Understudy metadata
needed for the approved calls. Preserve:

- the Messages method and all request fields, including `system`, content
  blocks, tools, tool choice, beta features, and model;
- retry, timeout, cancellation, and error-handling behavior;
- the SDK-managed `anthropic-version` and any existing required beta headers;
- streaming mode, the existing event iterator, and the full stream lifecycle.

Do not consume, buffer, or convert a stream merely to verify routing. If a
custom client builds endpoint URLs itself, configure its root only after
confirming whether it already appends `/v1/messages`; avoid duplicated paths.

## Verify

Run the application's existing bounded command for each configured workload.
For streaming calls, let the normal consumer reach completion and confirm its
event handling is unchanged. Verify Understudy routing with the response's
`x-understudy-request-id` and require its logged project/workload IDs to match
the selected resources. HTTP success can still accompany default-workload
fallback from incorrect header values. Use
`understudy report health` and `understudy report usage` only as corroborating
aggregate evidence; a nearby row cannot identify one application request.

Confirm that an explicitly excluded call still uses its original client path by
static inspection or an existing local test. Keep live probes within the agreed
scope. Follow the [main skill](../SKILL.md#4-apply-check-and-commit-the-application-integration)
for branch coverage, committing, activation, exact log reconciliation and dashboard
confirmation. A successful SDK request alone does not complete onboarding.
