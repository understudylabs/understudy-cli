# Estimate task cost using OpenRouter reference prices

Start with the vetted, authenticated Understudy shortlist. Use OpenRouter prices
as the **assumed run prices for a relative cost estimate**; Understudy pricing
metadata is not required. OpenRouter research neither adds models to that
shortlist nor establishes Understudy billing terms or serving support. Public
lookups may contain public model IDs, never private trace text or identifiers.

## Choose comparable reference prices

Record the Understudy public ID, matched OpenRouter `id` and `canonical_slug`,
revision/variant, task API format, source URL, retrieval time in UTC, and selected
OpenRouter provider endpoint if applicable. An unresolved identity match cannot
establish a model-specific price. Refresh stale quotes before comparison.

Use one coherent reference per model: the returned model pricing object, or one
representative provider endpoint suitable for the task. OpenRouter describes
model-level pricing as its top provider's pricing. Never combine the cheapest
input from one provider with another's output/cache rates. Explain the selection;
if providers differ materially, show separately sourced scenarios or a range of
whole-task estimates. These are public OpenRouter references, not identities of
Understudy suppliers. See the [models overview](https://openrouter.ai/docs/guides/overview/models)
and [model endpoint API](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).

OpenRouter quotes USD per token, request or other unit. Convert token rates with
`USD per million tokens = USD per token × 1,000,000`; preserve request/image/search
units separately. Explicit zero is a price; absent or unusable fields are unknown.
See the [pricing fields](https://openrouter.ai/docs/guides/overview/models#pricing-object).

Price the classes the task actually uses. A plain text, uncached scenario can use
the quoted input/output rates with an explicit assumption that no other charges
apply; every optional field in the API is not a prerequisite. When an additional
class is used or a source documents an applicable charge, a missing rate leaves
that part unknown rather than free.

Inspect `pricing.overrides` for each call's prompt size and assumed run time.
`min_prompt_tokens` is a **strictly greater than** threshold. UTC windows have
inclusive starts, exclusive ends, and can cross midnight; honor `utc_days`.
All conditions must match; later matching entries win per price key. Unknown
conditions must not be applied or silently treated as complete coverage. Recheck
the current [override documentation](https://openrouter.ai/docs/guides/overview/models#pricing-overrides)
when conditions affect the estimate.

## Price the complete call chain

Analyze traces locally. Retain requested and actually served model, endpoint,
time, token usage and completeness for every call. Include tool continuations,
retries and billable failed attempts without double-counting overlapping captures
and reports. Apply the served model's reference to fallback calls; unidentified
fallbacks or unobserved attempts remain gaps. Listing capture metadata alone does
not establish complete task usage.

Normalize input, cache reads/writes, visible output and reasoning into
non-overlapping billable classes before multiplying by rates:

`call estimate = sum(class tokens × assumed USD per million / 1,000,000) + known per-call charges`

Reasoning is generally included in OpenRouter completion tokens. If a separately
priced reasoning class applies, split it out before pricing; never add it on top
of inclusive completion usage. Hidden reasoning is not free. Verify the selected
model's accounting against the [reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

Likewise, distinguish inclusive prompt counts from separate cache classes and
verify cache-write charges, TTL and eligibility. Show cold-cache and observed-cache
scenarios when material; caches do not automatically transfer to a candidate or
another endpoint. See [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
Apply context/time conditions per call, not to aggregated task tokens. Unknown
charge types or accounting semantics make the estimate incomplete.

## Label assumptions and coverage

An **incumbent-token estimate** assumes the candidate uses the observed token
counts and call sequence. Tokenization, reasoning, output length and tool strategy
can change both. State cache, retry and timing assumptions; do not invent an
observed failure rate.

Estimate baseline and candidates with the same OpenRouter reference-price method,
task cohort and coverage. Label any percentage as **relative savings under assumed
OpenRouter prices**, never actual Understudy bill savings. Do not compare a
candidate proxy against an observed Understudy bill as though they used the same
pricing method. Incomplete comparisons cannot support a total-cost percentage;
parameter count alone says nothing about savings.

Report calls priced/total, complete-usage calls, task-chain completeness and
unknown charges. Missing rates or usage are not zero: retain a priced subtotal
and an unknown total. Existing CLI usage/cost reports are optional evidence,
discoverable through `understudy report --help`; calculated Understudy request
costs and their coverage remain separate from this estimate. Ledger debits and
balances are separate again; neither an estimate nor a calculated cost proves a
per-task account debit.

## Synthetic worked example

Two invented calls use (10,000 input, 1,000 output) and (14,000 input, 2,000
output) tokens, with no caching and reasoning already included in output. Assume
fictional OpenRouter reference rates of USD 0.50/million input and USD 2/million
output, covering all charges in this example. The incumbent-token estimate is
USD 0.007 + USD 0.011 = **USD 0.018 for 2/2 calls**. A retry of the second call
adds USD 0.011, yielding USD 0.029 for that scenario.

Using the same method and calls, fictional baseline rates of USD 2/million input
and USD 8/million output give USD 0.072: the candidate is 75% cheaper **under these
assumed reference prices**, with no claim about actual bills or equal quality.
If call two instead falls back to an unmatched model, report USD 0.007 subtotal,
1/2 calls priced and unknown task total; no total-cost savings percentage follows.
These are invented arithmetic examples, not live quotes or model recommendations.
