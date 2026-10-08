---
name: compare-models
description: Compare the current model and a shortlist on an existing workload eval, keeping prompts, tools and checks fixed. Run a bounded comparison, show outputs and regressions in a local side-by-side UI, and explain quality, latency and cost coverage. Use for measured model comparisons; try-models remains the lighter spot-check workflow. Stops before hill climbing or rollout.
---

# Compare models on an existing eval

Answer which candidate is worth adopting or investigating for this workload,
using the same task cases and checks. Deliver a local side-by-side comparison UI,
an explainable recommendation, and exact rerun commands. Reuse an existing
presentation preference; a user who explicitly asks for text only gets Markdown.
Do not treat an aggregate score as a universal model ranking.

This is a raw model comparison. Keep the task inputs, prompt, tools, application
output contract, grader, limits and environment fixed. Hill climbing, prompt
repair, new graders and rollout are separate requests. A necessary API adaptation
is preparation before freezing the comparison, and must be recorded separately
from the model change; do not silently change behavior to improve a score.

## 1. Reuse the task, shortlist and eval

Read the application's model call and existing eval. Carry forward the resolved
organization/project/workload, task evidence, candidate research, selected cases,
user priorities, presentation preference and authorization. Ask only for missing
choices that affect this run. For example, if the objective is unresolved:
“Which matters most here: preserving these behaviors, reducing cost, or speed?”
Continue inspecting existing evidence while awaiting an answer.

Use the current model plus the agreed shortlist, ordinarily two or three vetted
Understudy candidates. Resolve exact public IDs and API formats through
`understudy models list --json` and `understudy models show <id> --gateway --json`
when gateway access is configured. Reuse `recommend-models` research; a shortlist
is not permission to search or test every public model. If the user already named
the candidates, check their availability and proceed within that scope.

If a selected candidate needs Messages to Chat Completions adaptation, read the
installed `adapt-model-api/SKILL.md` before freezing the run. If absent, run
`understudy skills install adapt-model-api --harness <harness> --json` for the
current agent and read the returned `entrypoint` using file tools. Do not depend
on automatic discovery in this session. If the host cannot read it, save the
plan and resume after starting a new session before adapting or running that
candidate. Reuse existing authorization for routine compatibility
work. Validate the adapted application path, retain the original path and
record each protocol/settings variant. When a common protocol is unavailable,
describe the result as a model-plus-adapter comparison, not an isolated model
effect. Defer a candidate with unresolved required behavior. Do not convert a
compatible application merely because a candidate is open-weight.

Keep the customer's existing eval runner, schemas, graders and report tools.
Do not require conversion to Understudy files. Confirm its cases and checks
represent the selected workload and inspect their known limitations. If the
user wants only a few outputs without an eval, use `try-models`. If no usable
eval exists, explain that gap and use `build-evals` when eval construction is
within the request; do not call an improvised score a validated measurement.

## 2. Freeze a bounded comparison

Record a short private plan under the application's ignored, package-excluded
`.understudy/comparisons/<name>/`, or the existing eval's private output location.
Keep captured and derived customer evidence out of source control, packages and
skill installations. Use owner-only access. Reuse native metadata; no additional
manifest format is required.

Record the exact case membership, repetitions, application/runner/grader versions,
model settings, endpoint, tool isolation/reset, cache basis, candidate order and
limits. Declare which model-backed responsibility changes if the application has
several models. Every other model dependency stays fixed and visible. Pin files
or versions that affect the run; an unchanged local hash does not freeze remote
state, environment variables or external services.

Resolve authenticated source and execution scope using the existing CLI context
and workload reads. Source captures do not authorize replay in that tenant.
Reuse an authorized test scope and the user's existing call/time/spend limits;
resolve missing material limits before inference. Fresh application calls,
continuations and judges use the test environment and retain request receipts.
Test labels do not isolate tool effects: use the app's isolated test state.
The bundled runner is not a sandbox or a cumulative spending limiter.

Use the same protocol and non-model settings where supported. Disclose declared
model-specific defaults, caching differences and known endpoint limitations.
If the runner cannot change only the selected model, prepare the smallest
model-selector seam within the requested scope, validate it locally, and use
that same implementation for every candidate.

## 3. Run the frozen cases

Use the native runner's candidate/model option and save distinct run directories.
Reuse compatible saved runs when requested; label historical outputs and their
different observation window. Never relabel old results as fresh execution.

For evals using the optional bundled `build-evals` runtime, read
[the bundled comparison helper](references/bundled-comparison.md). Its `run --model`
passes `context.model` to the application's adapter and records the requested
model. The adapter must actually use that selector and record what served each
call. The bundled helper attributes quality only when every application model
call uses the selected model. If other model dependencies stay fixed, use a
native comparison viewer that attributes calls to their model-backed
responsibilities; do not omit those calls to fit the helper. The helper reads
saved results only; it never calls a model or grader.

Check one completed case per candidate before proceeding through the agreed
selection. A transport/parser/environment problem is an execution problem,
not automatic evidence of low model quality. Preserve failed attempts, uncertain
outcomes and their costs. Do not silently retry, cherry-pick repetitions or
replace a bad result. Continue only within the agreed retry and spending policy.

Keep all model-call receipts for a task, including continuations, retries and
fallback. Where available, join retained request IDs to `understudy requests show`
and `understudy report cost`. Record requested versus actually served models.
Missing attribution remains unknown; a fallback success does not demonstrate
the requested candidate succeeded. Keep mixed or unresolved serving visible in
the UI and separate it from evidence for the intended candidate.

## 4. Explain the paired results in a UI

Use the existing eval viewer when it provides the required side-by-side view.
Otherwise use the optional bundled helper or build a small private local viewer
over the native saved results. Do not introduce an app service or upload results.
Read [the comparison view](references/comparison-view.md) for required evidence
and browser checks. Open the UI with the host's file/browser tool, inspect it,
and include its working link or path in the final response. If opening is
unavailable, report that limitation and give the exact local opening command;
writing HTML alone is not verified presentation.

Match cases by their actual identity and repetitions, never file order or a
shared trace ID. Compare only compatible inputs, checks and execution conditions.
Show both-pass, both-fail, fixed, regressed, unscored and missing pairs. Inspect
the actual outputs/tool effects for each reported failure class and material
regression. A changed verdict may be a grader or environment issue; explain
that evidence without repairing the frozen comparison mid-run.

Report the selected-case count, planned/observed attempts, grading coverage,
serving attribution, task latency, calls and cost coverage. Keep application
cost separate from judge cost. Distinguish observed calculated cost, reference
price estimates and ledger charges. Missing cost is not zero; do not infer
savings from model size. Compare costs on the same task set with an explicit
cache basis, and retain the cost of unsuccessful attempts. Repetitions are
grouped within tasks, not independent examples. Selected examples do not establish
production prevalence or universal reliability.

## 5. Recommend and hand off

Name the candidate worth trying next and explain the tradeoff using concrete
cases. “Inconclusive” is valid when missing evidence or conflicting outcomes
prevent the requested decision. Do not turn descriptive counts into a hidden
weighted score, an automatic ranker or a rollout gate.

Leave the saved report, exact commands, candidate configurations, evidence paths
and limitations with the workload. If a user asks to improve a weak candidate,
use these failures as the starting point for a separately bounded hill-climb
request. If adoption is already requested, pass the chosen configuration and
comparison evidence into `rollout-workload`, preserving its activation scope and
rollback requirements. A comparison request alone ends at the recommendation.

## Offline demonstration

Use [the synthetic walkthrough](references/demo.md) to exercise the complete
runner-to-UI path without credentials, model calls or customer data. Its invented
models illustrate report behavior only; they provide no model-quality evidence.
