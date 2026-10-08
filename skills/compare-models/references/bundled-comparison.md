# Optional bundled comparison

Use this helper only for saved runs from the bundled `build-evals` runtime.
Existing eval tools keep their own commands, results and viewer; no conversion
or adapter is required merely to follow `compare-models`.

Install matching `build-evals` and `compare-models` skills in the same skill root.
The comparison imports the authoritative eval readers instead of maintaining
another result schema. Node.js 22+ and Git are required. `<skills-root>` below
is the root reported by `understudy skills install`; it is not the application.
Run commands from the application root. Evidence belongs under its `.understudy/`.

## Run only the model variant

The application adapter receives a model selector in its second argument:

```js
export async function run(task, context) {
  return runApplicationCase(task.input, { model: context.model });
}
```

`runApplicationCase` is the application's existing test entrypoint, not an
Understudy API. The adapter must enforce the agreed inference scope/limits,
keep tools isolated, and return output, grading evidence and call receipts.
Freeze all execution dependencies through the eval's `fingerprintFiles` and
explicitly record remote state and environment settings. Do not read the run ID
to change application behavior. Expected answers are not passed to the adapter.

Validate once after wiring the adapter, then run each declared model on the same
eval. The `--model` option records the requested model and passes `context.model`;
it cannot prove that the adapter or gateway used it.

```sh
node <skills-root>/build-evals/scripts/eval.mjs validate --eval .understudy/evals/important-tasks
node <skills-root>/build-evals/scripts/eval.mjs run --eval .understudy/evals/important-tasks --run baseline --model <incumbent-id>
node <skills-root>/build-evals/scripts/eval.mjs run --eval .understudy/evals/important-tasks --run candidate-a --model <candidate-id>
```

Each run freezes its requested model. Resuming with another model is rejected.
The same declared eval fingerprint must apply to every compared run. Changing
prompts, graders, cases or adapter implementation requires a new experiment.
This first helper supports fresh raw comparisons, not historical-vs-fresh claims
or different prompts/settings. Those can still be explored explicitly in native
tools with the differing conditions disclosed.

This helper does not represent per-candidate API adaptations. Use it after an
adaptation only when every run uses the same validated protocol and configuration.
For a Messages baseline versus a Chat Completions candidate, use the native
report/viewer or a small local comparison showing each variant's protocol and
adaptation. Do not hide those differences behind the same fingerprint or model ID.

Every application model call must request the selected model for the helper to
attribute quality to that model. Applications with fixed auxiliary models need
a native comparison viewer that attributes calls to their responsibilities and
shows which responsibility changed. Keep all calls in the saved evidence; do
not omit fixed dependencies or relabel their models. If such runs reach this
helper, their mixed-model attempts remain `unverified_model`, with recorded
checks and spending visible, rather than model improvements or regressions.

For agentic tasks return `receipt.calls` and `callsComplete`, rather than claiming
one served model for an entire multi-call task:

```json
{
  "callsComplete": true,
  "calls": [
    {"requestId":"synthetic-request-1","requestedModel":"synthetic/candidate","servedModel":"synthetic/candidate","fallbackUsed":false,"costUsd":0.003,"costBasis":"synthetic"},
    {"requestId":"synthetic-request-2","requestedModel":"synthetic/candidate","servedModel":"synthetic/incumbent","fallbackUsed":true,"costUsd":null}
  ]
}
```

This is wholly invented evidence. In actual receipts, retain public model IDs
and request IDs from the authorized calls; keep supplier/deployment identities
private. Use null for unknown requested/served models, request ID or fallback.
`callsComplete` means every application model call is represented, not that every
field is known. Legacy `receipt.model` remains supported for a truly single-model
execution; it does not establish complete per-call attribution. Keep judges
separate. Per-call costs declare `calculated`, `reference-estimate`,
`observed-provider`, or `synthetic` basis; they are not ledger debits. The helper
does not add them to aggregate application costs a second time.

## Render saved results

```sh
node <skills-root>/compare-models/scripts/compare.mjs --name raw-models \
  --baseline .understudy/evals/important-tasks/results/baseline \
  --candidate .understudy/evals/important-tasks/results/candidate-a
```

Repeat `--candidate` for additional agreed candidates. The helper verifies
workload, cases, grading and configuration compatibility using saved records.
It retains planned rows even when results are missing. Incompatible evidence is
rejected; a hash is not proof of remote-state equivalence or grader validity.

The output is private `.understudy/comparisons/raw-models/report.html`,
`report.md`, and `summary.json`. Use a new name for a new report; existing
evidence is not overwritten. Rendering is offline: no adapter, grader, model,
external JavaScript or upload is invoked. Open the HTML and inspect a regression,
a missing result and the serving attribution before explaining the comparison.
