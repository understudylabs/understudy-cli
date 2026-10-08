# Mastra

Use this add-on only when selected calls are owned by `@mastra/core`. Mastra can
resolve models through strings, AI SDK language-model instances, configuration
objects, dynamic functions, registries, or a shared model gateway. Establish
which form the installed version uses before proposing a change.

Read [Vercel AI SDK](vercel-ai-sdk.md) as well when the selected Agent uses or
will use an `@ai-sdk/*` provider. Its base-URL and protocol rules take
precedence over the direct provider SDK references.

## Discover Agents and execution paths

Find every `new Agent(...)`, Agent factory, and registered or dynamically
resolved model. For each Agent, record:

- its semantic responsibility, source location, and registration boundary;
- whether `model` is a framework string, AI SDK language model, configuration
  object, dynamic function, or shared gateway/registry entry;
- the resolved provider and Chat Completions, Responses, or Messages protocol;
- every `generate(...)`, `stream(...)`, network handler, workflow, or other
  runtime path that invokes it;
- shared model/provider configuration and all Agents affected by changing it;
  and
- tools, memory, instructions, scorers, processors, fallbacks, and structured
  output that must remain unchanged.

Inventory independently attributable model-backed stages within Agents and their
tools, processors, memory and workflows as well as top-level call sites. Show the
shared Agent/provider change boundary separately. Honor the selected scope; a
single provider import does not make every Agent or stage selected.

Treat every invocation sharing one Agent/model configuration as one change
boundary. If the user selects only some invocations of an Agent, do not change
that Agent's model yet. Offer the same three choices as for a shared provider:
include every invocation, isolate the selected paths behind a separately
configured Agent or model boundary as a reviewed change, or exclude them.

Give each stable, independently attributable model-backed stage its own workload.
Repeated iterations alone do not create new workloads. If one shared Agent/model
boundary cannot distinguish stages, record that limit and identify the supported
hook or scoped factory needed; do not invent attribution inside an opaque call.

## Resolve the model boundary

A string such as `"openai/example-model"` can be a framework model-gateway
identifier, not an OpenAI client. Changing an unrelated base URL will not route
it through Understudy. For selected string-model Agents, propose an explicit
AI SDK provider model at that Agent's model boundary, following the Vercel AI
SDK reference and preserving the resolved protocol.

Some Mastra versions accept a model configuration object containing `id`,
`url`, `apiKey`, and `headers`. Do not assume that shape preserves native
Anthropic Messages or OpenAI Responses: versions can resolve URL-backed
configuration through an OpenAI-compatible Chat adapter. Inspect the installed
Mastra implementation or types and leave the Agent unresolved if the resulting
protocol cannot be proved.

For an existing AI SDK provider instance, prefer changing or isolating that
provider boundary rather than rebuilding the Agent. If selected and unselected
Agents share it, use the shared-boundary choices from the main skill.

Preserve dynamic model-selection functions and fallback order. Any change that
would replace that logic with one fixed model needs its own explicit preview
and approval.

Mastra also supports shared model gateways in some versions. Reuse an existing
one only after proving its forwarding contract and affected Agents. Do not
introduce a new custom gateway merely to set up a few Agents; that is a broader
architecture change and requires a separate proposal.

## Configure only the approved Agents

Use the application's existing runtime secret mechanism. Understudy
authentication must fail closed when `UNDERSTUDY_API_KEY` is absent. Never put
shell-variable text such as `$UNDERSTUDY_API_KEY` or
`$UNDERSTUDY_GATEWAY_URL` inside a TypeScript string and treat it as runtime
configuration.

Place `x-understudy-project` and `x-understudy-workload` at the narrowest
supported provider or request boundary. Their values must be the resolved
project's `slug` and workload's `name`, respectively, not management IDs or the
project display name. Use explicit application setting names such as
`UNDERSTUDY_PROJECT_SLUG` and `UNDERSTUDY_WORKLOAD_NAME`; `keys exec` does not
supply them. Provider-level headers are appropriate
only when every Agent sharing the provider maps to the same project and
workload. Otherwise use a selected Agent's existing provider factory or the
installed AI SDK's request-level headers when supported.

Setup supports managed mode only. Understudy supplies the upstream credential.
Do not forward an existing provider credential.

Make no unrelated Mastra changes. Preserve:

- Agent name, instructions, tools, memory, scorers, processors, and workflows;
- registration, exports, routes, deployment bindings, and development scripts;
- model ID, provider options, protocol, tool-call behavior, and structured
  output;
- `generate(...)` versus `stream(...)` and the existing result consumer; and
- retries, timeouts, cancellation, fallback, and error handling.

In particular, do not force all Agents to stream and do not patch every Agent
when the user selected only a subset.

## Verify

Typecheck using the repository's locked Mastra and AI SDK versions. Run bounded
synthetic application requests within the agreed budget, counting model-backed
tools, loop turns and retries. Confirm normal Agent behavior and reconcile each
`x-understudy-request-id` with the selected resources' logged project/workload
IDs. HTTP success can still accompany default-workload fallback from incorrect
header values.

For every shared boundary, confirm through static inspection or an existing
local unit test that unselected Agents still resolve through their original
model path. Do not exercise an unselected production path merely to prove this.

Follow the [main skill](../SKILL.md#4-apply-check-and-commit-the-application-integration)
for branch coverage, committing, activation, exact log reconciliation and dashboard
confirmation. A successful Agent request alone does not complete onboarding.
