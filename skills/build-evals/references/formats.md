# Commands, files, and adapters

This is the optional bundled runtime's contract. An existing eval can keep its
native schemas, runner, grader, and reports while following the skill; it does
not need these files or an adapter. Record workload identity and evidence links
in its metadata or private `eval.md`. Use the sections below only for bundled
tools being adopted. Customer evidence still follows the shared private-storage
rules regardless of format.

The bundled tools require Node.js 22 or newer and Git, with no package install. Resolve
`<skill-dir>` to the installed `build-evals` directory. Run commands from the
application root. All examples below use an eval named `important-tasks`.

Every eval belongs to exactly one workload. Its directory name identifies the
eval, while `manifest.workload` identifies the workload being evaluated. Several
evals can cover different behaviors of the same workload; different workloads
need separate eval directories. Resolve the workload through the CLI before
selecting captures, as described in [capture selection](captures.md).

## One private directory

```text
.understudy/evals/important-tasks/
  eval.md                    Task contract, decisions, limitations, rerun commands
  manifest.json              Workload identity, requirements, settings, selection
  cases.jsonl                Inputs, expected behavior, provenance, saved outputs
  controls.jsonl             Known outputs that test the grader
  adapter.mjs                Calls the application's actual entry point
  grader.mjs                 Checks an execution against the case contract
  source/                    Original captures and export membership/manifests
  source/workload.json       Saved CLI workload resolution and source scope
  validation.json            Latest grader-control check and fingerprint
  calibration.jsonl          Medium: independent human labels and judge decisions
  calibration/<id>/          Medium: immutable calibration report
  review/                    Medium: review decisions, taxonomy, private UI data
  check-eval.md              Medium: eval validity checks, findings, repairs
  results/<run>/
    run.json                 Frozen manifest, identity, configuration fingerprint
    cases.jsonl              Frozen case membership and expected behavior
    executions.jsonl         Outputs saved before grading; recovery evidence
    results.jsonl            Every completed attempt, including errors
    report.html              Local, interactive result/review page
    report.md                Printable result report
    summary.json             Numbers computed from the saved records
    measurements/<version>/  Optional: immutable task-specific measurement set
      definitions.json       Frozen definitions and source identity
      measurements.jsonl     Supplemental measurements and evidence joins
      summary.json           Generated measurements with coverage
      measurements.md        Generated supplemental metric report
```

Other task-specific files, environments, review exports, and calibration evidence
also live here. The helpers establish owner-only access and refuse unsafe paths.
The application workspace and its ancestor directories must be trusted; these
checks do not isolate evidence from other programs running as the same OS user.
They check Git exclusion but cannot infer every application packaging system.
Exclude `.understudy/` from packages, uploads, artifact collectors, and the tested
agent's filesystem scope. Installed skill files are reusable public-safe code;
their runtime outputs and adapters are private application material.

`review/`, `check-eval.md`, and supplementary measurement files are authored by the
agent or the application's existing tooling. The bundled initializer and report
commands do not generate them. Use [case review](case-review.md),
[eval checks](check-eval.md), and [measurements](measurements.md) for their
workflows. Keep these application-specific resources beside the eval; do not
modify installed skill scripts to customize a customer's review experience.

## Commands

```sh
node <skill-dir>/scripts/eval.mjs init --name important-tasks --mode low
node <skill-dir>/scripts/eval.mjs validate --eval .understudy/evals/important-tasks
node <skill-dir>/scripts/eval.mjs run --eval .understudy/evals/important-tasks --run baseline
node <skill-dir>/scripts/eval.mjs grade --eval .understudy/evals/important-tasks --run historical
node <skill-dir>/scripts/eval.mjs regrade --eval .understudy/evals/important-tasks --from baseline --run regraded
node <skill-dir>/scripts/eval.mjs report --eval .understudy/evals/important-tasks --run baseline
```

For an explicitly requested raw model comparison, `run` also accepts
`--model <public-model-id>`. It records `run.requestedModel` and passes
`context.model` to the adapter; the adapter must actually use it. The selector
does not change the eval fingerprint or other settings. A run cannot resume
with a different or omitted selector. Regrading inherits the source selector;
it never relabels saved execution. Existing runs without a selector still work.
Use the `compare-models` skill to compare these saved runs and display their UI.

`init --demo` creates the complete invented example instead of the starter.
`validate` runs the grader on known controls; it does not execute the application.
If the grader calls a model judge, those control checks can incur inference
costs. Resolve the authorized test identity and limits before validation, and
include control-judge calls in the budget.
`run` executes the application and grades each result. `grade` grades the saved
`observed` execution on each case. `regrade` grades recorded outputs from an old
run using the current grader, preserving the old run. `report` only reads saved
records; it never executes the application or grader.

When an attempt appears in both execution and result journals, its output,
trace, application metrics, and receipt must agree. Conflicts stop report,
resume, and regrade operations so the original evidence can be reconciled.
Judge cost is recorded after execution and is excluded from this comparison of
original execution evidence.

The bundled runner runs every case in the chosen eval directory; it has no
split/case filter. Use a separate pilot directory for a small development subset.
It executes sequentially, with a child-process deadline and no
automatic retries. Repetitions are explicit trials, not transport retries. Reusing
a run ID resumes only unchanged inputs and completed attempts; changed inputs
need a new ID. A pending call with an unknown outcome blocks automatic resume.
A timeout stops local work but cannot undo an already accepted remote request or
tool effect. Resolve uncertainty using saved evidence before retrying. Never
silently delete a pending marker to make a run continue.

The fingerprint covers the declared eval inputs and implementation files. Add
application code, imported helpers, fixtures, prompts, settings, and lockfiles
that affect execution to `fingerprintFiles`. It cannot discover remote state or
undeclared dependencies. Pin remote versions and record them in `eval.md` and
receipts. An unchanged hash does not prove an unchanged external service.

## Manifest

Use JSON, not executable configuration. The initializer writes a complete example
of the supported fields. A minimal meaningful contract looks like this:

```json
{
  "schemaVersion": 1,
  "name": "important-tasks",
  "mode": "low",
  "workload": {
    "source": "synthetic",
    "organizationId": "synthetic-org",
    "projectId": "synthetic-project",
    "workloadId": "synthetic-parcel-quotes",
    "name": "parcel-quotes"
  },
  "description": "Check the application's parcel quotes.",
  "purpose": "selected-regression",
  "rubricStatus": "confirmed",
  "selection": {
    "method": "Owner-selected boundary examples",
    "limitations": ["These examples do not estimate production prevalence."]
  },
  "criteria": [
    {"id": "amount", "description": "The quote obeys the agreed price rule.", "required": true}
  ],
  "adapter": "adapter.mjs",
  "grader": "grader.mjs",
  "fingerprintFiles": [],
  "settings": {"repetitions": 1, "timeoutMs": 30000}
}
```

This example's workload is wholly invented. For a real eval, use
`source: "understudy"` and copy the verified organization, project, workload ID,
and workload name from the CLI's resolved records. The starter leaves these
fields empty and cannot validate until they are filled. Save the resolution
evidence privately in `source/workload.json`; do not infer workload membership
from a request ID or a directory name. Verify selected captures belong to this
workload and document the application behavior it represents in `eval.md`.

`source: "synthetic"` is reserved for wholly invented offline demonstrations:
all cases must have synthetic origin and empty `sourceRefs`. It cannot stand in
for an unresolved customer workload. The tools validate the declared identity
and preserve it in each run; they do not authenticate to the service or prove
that a supplied capture belongs to it. Regrading cannot change workload identity.
Create a separate eval when evaluating another workload.

Use `provisional` until the rules have an adequate authority. Controls do not
turn an inferred rule into confirmed policy. A criterion can declare `grading`
as `code`, `model`, or `human` (default `code`). Human criteria remain
`unscored` in automated results; review their outputs and export the human labels
separately. They require an unscored wiring control, not an automated semantic
judge or passing/failing prediction controls. `timeoutMs` bounds one application
or grader operation; it is not a call/token/dollar limit. Put those limits in the
adapter and judge client. `mode: medium` records the chosen process; the runtime
does not certify that a human completed that process.

## Cases and controls

Each nonblank line is one JSON object. Case IDs are stable local labels. Preserve
application/request membership in private `sourceRefs` without pretending that a
local case ID came from Understudy. Use `groupId` for related conversations,
retries, duplicate tasks, and variations that must stay in one split.

```json
{"id":"boundary-standard","title":"Standard parcel at the boundary","input":{"grams":500,"priority":false},"expected":{"price":4},"origin":"synthetic","sourceRefs":[],"tags":["boundary"],"split":"regression","groupId":"boundary-standard"}
```

`input` contains only what the application should know at the chosen starting
boundary. `expected` is private grading material; record its authority in the
task contract. For historical grading, add `observed` in the execution format
below. Missing output stays missing. `origin` is `synthetic` or `trace`; a
synthetic input inspired by a customer interaction remains private material.
Use `train`, `dev`, and `test` only when those partitions actually exist; otherwise
use `regression`. Do not relabel inspected cases as untouched holdouts.

Controls reference an existing case and declare the expected verdict of every
criterion. An answer-only control can provide `output` directly:

```json
{"id":"wrong-boundary-amount","caseId":"boundary-standard","output":{"price":7},"expectedVerdicts":{"amount":"fail"},"note":"Plausible boundary mistake must fail."}
```

For a grader that inspects interactions, metrics, or receipts, supply an
`execution` object instead. It has the same schema as the application adapter's
return value: required `output`, optional `trace`, `metrics`, and `receipt`.
The grader receives that object unchanged during validation. Use exactly one of
`output` or `execution` on a control; ambiguous forms and malformed evidence
are rejected. Existing answer-only controls keep their meaning, including an
explicit `output: null`.

Choose controls with the same final answer but different relevant actions or
receipts so a checker cannot pass by reading the answer alone. Also test missing
evidence as unscored when the requirement cannot be established. See the
[worked interaction checker](worked-example.md) for executable grader code and
positive, negative, and unknown-evidence controls. Validation invokes the grader,
never the application adapter; model-based graders may still incur judge costs.

For required automated criteria provide both passing and failing controls. Also exercise
valid alternatives, insufficient evidence, and near misses where applicable.
Controls test wiring and known distinctions. Independent human calibration is a
separate Medium step for semantic judges.

## Application adapter

Export `run` from `adapter.mjs`:

```js
export async function run(task, context) {
  // Invoke the real app or its existing test harness here.
  // task has id, title, input; context has runId, repetition, and workload.
  const output = await application(task.input);
  return {
    output,
    trace: [{ role: "assistant", content: JSON.stringify(output) }]
  };
}
```

`application` above is the application's function, not a supplied runtime API.
The starter intentionally fails until connected. Python, Go, an existing eval
framework, or a CLI replay harness can be called by this adapter; preserve exit
status, bounded execution, and native protocol. Use the real input/output path
instead of rebuilding a simplified application that happens to pass.

`context.workload` is the source workload from the manifest. Use it to identify
the application responsibility under test. The credentials and receipt scope
for a fresh test run are a separate execution identity: resolve the authorized
test organization/project/workload rather than treating source identity as
permission to send inference. Preserve both identities in the private evidence.

A successful execution returns:

- `output`: JSON-serializable final answer, artifact facts, or end-state evidence.
- `trace`: optional ordered `{role, content, name?}` entries. Include the full
  interaction needed to judge the task. Content is data, never renderer markup.
- `metrics`: optional nonnegative numbers such as `costUsd`, `judgeCostUsd`,
  `latencyMs`, `modelLatencyMs`, `inputTokens`, and `outputTokens`. Omit unknown
  values; do not fill missing measurements with zero.
- `receipt`: optional actual `model`, fresh `requestIds`, and verified `scope`.
  These fields retain evidence; the generic runner does not verify gateway headers
  or a model identity on behalf of the adapter.

For multiple calls, `receipt.calls` optionally preserves each call's `requestId`,
`requestedModel`, `servedModel` and `fallbackUsed` (all required; null means
unknown). Optional `costUsd` is nonnegative or null; a known cost requires
`costBasis` of `calculated`, `reference-estimate`, `observed-provider`, or
`synthetic`. These are not ledger debits. `callsComplete` is an optional boolean
stating whether every application call is represented; omitted means unknown
coverage. Include retries and continuations, keep judges separate, and never
duplicate request IDs. If also supplying `requestIds`, complete calls must match
that list. A legacy single `model` cannot describe complete mixed-model calls.
Aggregate `metrics.costUsd` remains the adapter's application-cost total; call
costs are not silently added to it or used to fill missing totals.

Reports list actual model identities from each call's `servedModel`. Per-model
`attempts` counts each attempt once even when it contains several calls to that
model; `calls` counts the recorded call receipts separately. An attempt using
several models appears under each model, so per-model attempt counts must not be
added to infer coverage. When a call list is absent, the legacy `receipt.model`
still supplies an attempt-level label, with no inferred call count. Legacy labels
also remain visible separately and never fill unknown identities in a call list.
The report distinguishes attempts with any reported identity from those with a
nonempty, adapter-declared complete call list and every served model known.
Partial or missing lists can hide additional calls; even a known identity for
every recorded call does not establish complete execution coverage.

Model costs and judge costs have different attribution. Persist individual call
receipts and all retry evidence in the private eval directory. For local pure
code the demonstrated cost may be zero; say why. Historical usage describes the
historical execution. Regrading does not incur that application cost again.

Throw an error with `code = "ENVIRONMENT_GAP"` when a valid action cannot be
executed faithfully because a fixture or supported environment behavior is
missing. A malformed answer produced by a successful application invocation is
still an output: let the applicable quality check reject it.

## Grader

Export `grade(caseRecord, execution)` from `grader.mjs`:

```js
export async function grade(task, execution) {
  const pass = Number.isInteger(execution.output?.price)
    && execution.output.price === task.expected.price;
  return { verdicts: {
    amount: {
      status: pass ? "pass" : "fail",
      reason: pass ? "Matches the contract." : "The amount violates the price rule."
    }
  }};
}
```

A grader may also return `judge: {costUsd, model, requestIds}`. Omit unknown
fields or use null for unknown cost. A pure code grader can report
`judge: {costUsd: 0}`. Save complete individual judge receipts separately.
The runtime records this as the current grading pass and resets stale judge
cost when regrading saved application outputs.

Criteria marked `grading: "human"` must return `unscored`. Their saved human
labels stay separate from the automated report; summarize reviewed outcomes with
the exported evidence and its denominator rather than replacing machine grades.

Return an entry for each declared criterion, with status `pass`, `fail`, or
`unscored` and a concrete reason. Missing, extra, or malformed checks are grader
errors. Use `unscored` for insufficient evidence, an unresolved policy question,
or pending human review. Unexpected exceptions and judge transport errors are
execution/measurement errors, not failed model answers. A required failure makes
the attempt fail even when a different criterion is unscored. An overall pass
requires all required criteria to pass.

For model judges, save the prompt, model/settings, structured response, usage,
and evidence references in the private directory. Supply task facts and candidate
output as data; hide candidate identity. Validate the response before converting
it to verdicts. Independent human labels and actual saved judge predictions feed
Medium's calibration tool. Do not invent predictions for that report.

## Saved rows and reporting

Each result row identifies `caseId` and one-based `repetition`, has
`schemaVersion: 1`, and includes execution fields above when available. `status`
is `ok`, `execution_error`, `environment_gap`, `timeout`, `grader_error`, or
`missing_output`. Successful grading adds `verdicts` and optional `judge` evidence. Errors include a structured
`error` message/code. Missing rows remain unrun in reports. Unknown case IDs,
duplicate attempts, and malformed records must be repaired explicitly, not
silently dropped from the denominator.

Reports identify the frozen workload, begin from the frozen case list, and join
the rows onto it. They show
planned attempts, unique cases, all outcomes, every criterion, known costs with
coverage, and observed timing. Repetitions stay grouped by case. Selected-suite
counts are descriptive; the report does not manufacture population confidence
or a deployment verdict. It renders captured content inertly with no network
assets. Open the HTML locally; use the Markdown report for printing.

For every run kind, a known `judge.costUsd` supplies the grading cost. If it is
absent or null, the report falls back to `metrics.judgeCostUsd`. A known zero is
retained, and the two fields are never added together. If neither is known, that
attempt's grading cost stays unknown and reduces reported cost coverage. Use
cost for the recorded grading pass, not a previous pass copied into new results.

Only if adopting the bundled reporter for an existing runner, map its saved
evidence to versioned `run.json`, frozen `cases.jsonl`, and complete
`results.jsonl`, then invoke `report`. Keep the native report instead when it
already exposes the necessary evidence; format conversion is not a requirement
of this skill. Do not copy credentials into run configuration. If choosing this
conversion, use the demo as an executable example and retain the original detail.

## Human review and Medium measurements

Create an input review page before execution, or review actual run results:

```sh
node <skill-dir>/scripts/eval.mjs review --eval .understudy/evals/important-tasks
node <skill-dir>/scripts/eval.mjs report --eval .understudy/evals/important-tasks --run baseline
```

The page offers free-text discovery notes and separate per-criterion
Pass/Fail/Defer labels. Identify the reviewer. Labels do not replace automated
verdicts. Corrections remain editable; use export/import to preserve them.
Browser persistence is opt-in and the page explains where that copy lives.
Exports use the browser's download location: move them into the private eval
directory, restrict permissions, and remove any extra download copy. Do not put
private annotations in a shared browser profile. Import rejects labels from a
different frozen scope or changed attempt evidence. Finishing other attempts
does not invalidate earlier labels. Browser restore skips stale annotations and
reports how many were skipped, leaving the saved copy unchanged; an explicit
import with any stale row is rejected in full. Version 2 label exports include
each annotation's evidence identity. Older labels without that identity require
manual review. If reviewing large artifacts, use an existing private viewer;
the bundled page displays JSON/text and does not execute artifact HTML.

For a semantic judge, run the frozen judge on the independently labeled outputs
and save its real predictions and full judging evidence. Join by case/output
identity and criterion, never by row order. Keep reviewer labels separate from
predictions. Convert the reviewed evidence to `calibration.jsonl`:

```json
{"id":"example-a","groupId":"conversation-a","split":"dev","reviewer":"domain-reviewer","human":{"amount":"fail"},"predicted":{"amount":"pass"},"reason":"The judge accepted the wrong boundary amount."}
```

The example above is invented to illustrate the format. Real predictions must
come from the saved judge run. If there are multiple criteria, put each in the
`human` and `predicted` objects for the same output. Related outputs share a
group. `human` permits `pass`, `fail`, and `defer`; `predicted` permits `pass`,
`fail`, `unscored`, and `error`. Missing entries stay missing. Keep paths to the
original human review, output, judge version, prompt, and response in a private
calibration evidence manifest. The tool verifies schema and split consistency,
not the truth of the claimed reviewer or the origin of a prediction.

```sh
node <skill-dir>/scripts/measure.mjs calibrate --eval .understudy/evals/important-tasks --id judge-v1
```

This computes separate train/dev/test confusion counts, sensitivity (TPR),
specificity (TNR), class-specific coverage, abstentions, and errors. Reports are
immutable under `calibration/judge-v1/`; use a new ID after changes. A missing
class has no detection-rate estimate. Wilson 95% intervals apply only to
independent rows; related rows explicitly lack that interval. Conditional rates
exclude undecided predictions, so inspect excluded counts before trusting them.
The tool does not certify that a test was untouched or a threshold was met.

Additional functions can be imported from `scripts/measure.mjs` by private
measurement code:

| Function | Input and interpretation |
| --- | --- |
| `wilson95(successes, total)` | Binary count interval; zero observations returns unknown |
| `auditGroupedSplits(rows)` | Unique `id`, related `groupId`, and `train`/`dev`/`test`; rejects a group crossing partitions |
| `calibrationReport(rows, criterionIds)` | The same offline calculations used by the calibration command |
| `groupedBootstrap(rows, {seed, draws})` | Rows `{caseId, groupId, rep, value}`; average trials within each case, resample whole groups, average cases; unweighted only |
| `retrievalMetrics({retrieved, relevance, k, labelsComplete, required})` | Ranked unique document IDs, document-to-nonnegative-gain labels, cutoff, completeness, and required evidence IDs |

Use about 2000 bootstrap draws and save the seed. Pass every planned trial
under the metric definition; silently omitting unsuccessful or unscored trials
changes the claim. Unknown values require a stated eligibility rule, not an
invented number. Fewer than two groups and degenerate resampling return an
unavailable interval with a reason. For unequal sampling weights or strata,
implement the appropriate design in private measurement code and validate it;
the generic bootstrap does not claim to handle those designs.

Retrieval returns recall@k, precision@k, reciprocal rank within k, nDCG@k, and
whether all required evidence was retrieved. Precision uses denominator k even
when fewer results are returned. nDCG uses the supplied relevance values as
linear gains; document the labeling scale. Explicit zero means judged
irrelevant, while absent labels mean unknown. Recall and nDCG need a complete
relevance set. The returned `labelsComplete` is true only when the caller claims
completeness and every supplied retrieved or required ID has a label. Otherwise
it is false, `missingLabels` identifies known gaps, and recall/nDCG remain null.
Precision and reciprocal rank can still be calculated when all top-k labels are
known. This consistency check cannot independently prove that the caller labeled
the whole corpus. Generation checks remain separate from retrieval metrics.
