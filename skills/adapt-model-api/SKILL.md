---
name: adapt-model-api
description: Adapt an application's Anthropic Messages wrapper to OpenAI Chat Completions when a selected model needs it during try-models, compare-models or build-evals, or when API adaptation is explicitly requested. Preserve the original path and application behavior. Not initial gateway setup.
---

# Adapt a model API

Prepare one application's call boundary for a selected candidate or an explicitly
requested API change. This is a
conditional step within the requested trial, comparison or eval, not a reason to
convert every application to Chat Completions. Keep the existing implementation
runnable and return to the calling workflow when preparation is complete.

## 1. Confirm that adaptation is necessary

- Carry forward the selected workload, models, task, execution scope and limits.
  Reuse the user's existing authorization for routine code preparation and tests;
  do not ask again simply because an adapter is needed.
- Inspect the actual callsites, locked SDK/framework version and the selected
  model's declared Understudy endpoint support. Messages, Chat Completions and
  Responses are distinct APIs. Public publisher or OpenRouter support alone does
  not establish compatibility through the selected gateway endpoint.
- Prefer the original endpoint when it supports the candidate, unless the user
  explicitly requested an API change. For an adaptation, reuse
  an existing framework adapter or configuration switch if it preserves the
  required behavior. Add an application wrapper only where that is insufficient.
- Do not convert during `setup-understudy` merely to prepare for possible future
  models. If no selected candidate needs conversion and no API change was explicitly
  requested, return without changing APIs.

## 2. Map only the application's used features

Follow request construction through the tool loop, response assembly and final
parser. Record a brief mapping of each used feature as supported, conditional,
unsupported or unknown, with the SDK version, endpoint/model and source checked.
Consult official documentation for the installed SDK and selected endpoint where
the contract is unclear; keep private prompts and traces out of public searches.

- Preserve system instructions, message/content ordering, user text and tool
  schemas. Map wire representations without rewriting business prompts or tools.
- Match tool-call identifiers to their results, including multiple calls and
  continuations. Preserve the application's tool execution order, error handling
  and loop limits; parallel tool calls must not silently become serial behavior.
- Check output-token limits, stop conditions, structured-output/schema support
  and parameter restrictions. Do not assume similarly named controls are equal.
- Inspect streaming text and tool-argument fragments, completion/stop reasons,
  cancellation and error behavior. Adapt the result at the wrapper boundary so
  the existing parser and caller retain their expected interface.
- Disclose cache-control differences and cache billing assumptions. Reasoning or
  thinking controls, defaults, returned blocks and signatures are not portable
  merely because both APIs accept text. Never repurpose hidden reasoning as an
  application-visible answer to make the adapter pass.
- Check used image, audio, document and other content types individually.
  Provider-hosted server tools are not interchangeable with application function
  tools; preserving a tool's name alone does not preserve its behavior.

If a required behavior cannot be represented, or its support remains unknown,
explain the exact limitation and ask whether to omit that candidate or accept a
specific changed-behavior variant. Do not silently discard fields or fabricate
equivalence. Continue independent preparation that does not depend on that choice.

## 3. Add the smallest application adapter

- Scope the change to the selected workload and existing client/model selection
  boundary. Keep the original SDK, endpoint and model path as the default unless
  the user already requested a different default. Avoid a whole-application rewrite.
- Keep business prompts, tool implementations, parser and application-facing
  result shape unchanged. Add request/response translation inside the wrapper;
  keep original failure and retry behavior wherever the endpoints permit it.
- Use the application's existing authentication, workload attribution and request
  ID capture. Preserve the budgets and timeouts carried from the calling workflow;
  do not introduce nested retries or execute tools to discover how to map them.
- Make any necessary semantic or parameter adjustment an explicit variant with
  its own configuration and explanation. Preserve the original baseline; do not
  hide changes behind a candidate's model ID or claim this is a model-only swap.
- Keep code public-safe. Real captures and run artifacts belong in the application’s
  ignored, package-excluded `.understudy/`, not in CLI source or committed fixtures.

## 4. Validate, then resume the requested workflow

First use wholly synthetic fixtures and stubbed SDK responses/tool effects. Test
the features the application actually uses: text response parsing, tool argument
JSON and IDs, multi-call continuations, streaming assembly, stop reasons, errors
and cancellation. Verify both the original path and the adapter. Do not build a
new simulator, grader or eval framework to validate protocol translation.

If a bounded smoke is already authorized, run it through the existing application
runner in the approved test scope with isolated state. Carry forward its call,
retry and tool-effect limits. Otherwise report local validation and obtain the
missing execution scope before sending inference. A test label does not sandbox
real tools. Stop on unsafe effects, exhausted limits or an unexpected served model.

Where supported and within the authorized scope, run the incumbent through the
adapter as a control before comparing candidates. Keep this adaptation baseline
separate from the original protocol baseline and from candidate quality results.
If that control is unavailable, state that protocol and model effects are not
isolated. Execution or parser failures are not automatically poor model quality.

Retain requested and actually served models, endpoint, adapter/configuration
version, request IDs, retries, tool continuations and fallback paths for each run.
Do not claim the adapter preserves behavior beyond the exercised features.

Return the changed call boundary, compatibility mapping and unresolved limits,
synthetic test results, any smoke evidence, and the exact configuration to select
the original or adapted path. Resume `try-models`, `compare-models` or `build-evals`
with these variants visible. Live adoption belongs to a separately requested
rollout; adaptation alone does not authorize changing active routes or defaults.
