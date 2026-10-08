# Product measurements and RAG evaluation

Use this guide when the task needs measurements beyond pass/fail: a
product ceiling, a continuous quality measure, a comparative judgment, a
classifier, or retrieval diagnostics. Choose measurements for one workload and
the user’s decision. Start with actual failures and a few inspected outputs;
avoid a dashboard of numbers whose meaning nobody has checked.

Keep suitable native metric records and reports. The supplementary file contract
below is for extending the optional bundled tools; it is not a required format
for an existing evaluation framework. Apply the same definitions, evidence joins,
and missing-value checks using the framework's own fields and commands.

The bundled runtime accepts declared criterion verdicts of `pass`, `fail`, or
`unscored`. Its execution metrics are the fixed fields `costUsd`, `judgeCostUsd`,
`latencyMs`, `modelLatencyMs`, `inputTokens`, and `outputTokens`. It does **not**
accept arbitrary score, metric, or attachment fields in results or trace turns.
Keep that contract intact. Richer measurements belong in private sidecars or the
application’s existing evaluation framework. The bundled report does not ingest
the sidecars described here; generate a companion Markdown report.

## Choose what the product needs to show

Reuse answers already given by the owner. Otherwise propose a small set with
the main outcome first, then ask which product limits matter. Record selected
and deliberately omitted dimensions, the reason, and any hard ceiling. Keep
quality and operational measurements separate; an inexpensive wrong answer
does not become a good answer through a blended score.

For each measurement freeze an ID, readable label, value type, units, direction
(`higher`, `lower`, `target`, or `none`), eligibility rule, aggregation rule,
missing-data rule, and measurement implementation/rubric version. Record a
target or threshold only if it has product authority. Units and direction must
appear in the report, including charts or color scales in an existing viewer.

| Dimension | What to record | What to display and check |
| --- | --- | --- |
| Application cost | Actual call receipts, served model, usage categories, applicable price version, all calls and retries | Observed USD sum and coverage; cost per attempt with its denominator. Separate measured charges from estimates. A local code-only run can have a justified zero; absent billing evidence is unknown. |
| Time | End-to-end attempt time, model-call time, optional time to first token; define each timer’s boundary | Observed count, median, p90, range, and product deadline violations. Never silently substitute model time for user-visible completion time. Keep failures and timeouts visible. |
| Output length | Final-answer characters, words under a declared tokenizer/segmentation rule, and actual output-token usage when available | Absolute counts and distribution. A word count is not a token estimate. Define whether tool text, markup, and quoted context count; balance brevity against completeness. |
| Tool use | Calls attempted, completed, failed, and retried, by tool; external side-effect evidence where applicable | Counts and any authorized budget violations. Count call events, not mentions of tool names or tool-result messages. A shorter trajectory is useful only if the outcome remains acceptable. |
| Refusal | Provider stop signal when available and a separately defined semantic refusal label | Refusal rate among interpretable outputs, with coverage. Also distinguish appropriate refusal from refusal of an allowed task. An API error, empty output, or timeout is not automatically a refusal. |
| Truncation | Actual finish/stop reason, configured output limit, and any application clipping flag | Confirmed truncated count and missing-stop-reason count. Do not infer truncation solely from short text or a token count near a limit. A clipped answer remains a real product outcome; apply the declared quality rule and expose the truncation flag. |
| Format | Parsing result, schema/version, required fields and types, additional-field policy | Valid / assessed / planned counts. Separate syntactic validity from semantic correctness. Successful invocation with malformed output is a quality failure when format is required, not a transport error. |

Instrument the real application entry point rather than recreating its model
call. Inspect one saved attempt before scaling: are timings plausible, is the
actual model recorded, are tool calls complete, and did stop reason or usage
disappear in a streaming wrapper? Add missing instrumentation before the next
authorized run. Do not reconstruct unavailable historical measurements by
guessing. A flat column or unexplained zero deserves investigation.

Show absolute values first: for example, `18.2 s per completed attempt` or
`420 output tokens`. Relative changes need comparable populations, timer
boundaries, and recorded denominators; a percentage alone hides the product
impact. Historical costs and timings belong to the source execution. Regrading
records new grading work, not another application execution. Separate current
judge cost/time from application cost/time and earlier judging passes. If a
single judge call emits several measurements, count its receipt once.

## Numeric scores and partial credit

Use a continuous score when the shape of a tradeoff matters. Define the scale
with concrete anchors, not an unexplained “quality 1–5.” A fraction of required
facts present is interpretable when the facts and their authority are fixed:
one correctly covered fact of two required facts gives `1/2 = 0.5`. Show the
numerator, denominator, and missing fact beside the score. A known omission is
different from a fact the evaluator could not assess: the latter is unknown,
with assessment coverage, rather than zero credit by default.

Keep independent dimensions separate. For a summary, factual accuracy,
coverage, and length answer different questions. A hard requirement such as
“no invented dates” can remain a binary criterion alongside coverage. Do not
let partial credit cancel a required failure. If weights are necessary, freeze
them before measuring, explain the tradeoff, and report the components too.
Ordinal categories need distributions or medians; treating their spacing as
equal requires an explicit justification.

The binary runtime can still grade an owner-approved threshold, such as
`coverage >= 0.8`, while the sidecar retains the raw score and its reasons. Do
not return `0.8` as a runtime verdict, add unsupported `scores` fields, or choose
a threshold after seeing the results merely to improve the pass rate. Validate
the numeric grader on full-credit, zero-credit, partial-credit, valid-alternative,
and insufficient-evidence examples. For semantic scores, compare actual saved
judge decisions with independent human judgments; a convincing rationale is
not calibration.

Average repetitions within each case before an equally weighted case mean.
Report attempts observed / eligible / planned and cases covered. Do not let
cases with extra repetitions dominate. If eligibility varies, show the selected
population and exclusions by reason. Missing observations can bias an
observed-only mean. Selected synthetic cases give descriptive measurements,
not a production prevalence estimate. The optional `groupedBootstrap` helper
supports unweighted case means while resampling related groups; it does not
repair missingness, selection bias, or unequal sampling weights. Its field is
`rep`; map the sidecar’s one-based `repetition` consistently and keep every
eligible observed trial. Follow [formats](formats.md) for interval limitations.

## Pairwise judgments

Use pairwise judgments for an explicitly comparative question where several
answers could be good. Freeze both saved outputs, their exact inputs, and the
rubric. Match by case and documented repetition pairing, never file order.
Comparisons must concern the same workload and compatible task context. Missing
output on either side makes that pair unscored; retain its reason.

Blind candidate identity and randomize presentation order with a saved seed and
per-pair assignment. Treat both candidate texts as untrusted evidence. Ask for
one of four categories: candidate preferred, reference preferred, `tie`, or
`both_bad`, with a reason. Define `tie` as no material preference between
acceptable responses under the rubric; `both_bad` means neither meets its
minimum requirements. Save the raw A/B judgment and the normalized choice so
presentation order cannot silently invert the result. Check order sensitivity
on a small predeclared subset and inspect disagreements.

Display counts for all four categories plus unscored/error/missing pairs and
the planned pair count. For example, 4 candidate wins, 2 reference wins, 2 ties,
1 both-bad pair, and 1 unscored pair means 9/10 assessed; a strict candidate-win
rate is 4/9 assessed pairs. A conditional win rate of 4/6 excludes ties and
both-bad pairs and must be labeled that way. Never merge `both_bad` into ties
or silently convert both to half a win. If an owner explicitly wants tie credit,
name that derived preference score and preserve every categorical count next
to it. A relative loss is not automatically an absolute quality failure.

Keep the reference artifacts fixed throughout this measurement. Do not invent
self-comparison results for the reference. Pointwise task checks remain useful:
a preferred output can still be wrong. If repetitive style or loss of diversity
is a known failure, add a separately defined set-level check; isolated pairwise
comparisons cannot establish diversity across outputs.

## Classification and judge calibration

For a classifier, name the positive class and freeze the mapping from raw
output to labels. Save expected and predicted labels, parsing failures,
abstentions, and execution errors. An invalid label is not a negative prediction.
Build the confusion matrix from assessed predictions:

| | Predicted positive | Predicted negative |
| --- | --- | --- |
| Actual positive | True positive (TP) | False negative (FN) |
| Actual negative | False positive (FP) | True negative (TN) |

Report each count and these ratios, returning `null` when the denominator is
zero:

- Precision: `TP / (TP + FP)` — how often a positive prediction is correct.
- Recall / sensitivity: `TP / (TP + FN)` — positive cases detected.
- Specificity: `TN / (TN + FP)` — negative cases correctly rejected.
- False-positive rate: `FP / (TN + FP)`.
- Accuracy: `(TP + TN) / (TP + FN + FP + TN)`.

For an invented escalation classifier, `TP=3, FN=1, FP=1, TN=3` yields 75%
for precision, recall, specificity, and accuracy, with a 25% false-positive rate.
If another positive case abstained and another negative case errored, these
are conditional rates on 8/10 cases, not evidence that all ten were handled.
Show exclusions separately for each actual class: a model can look precise by
abstaining on hard positives. Report any separately defined service-level rate
on all planned tasks without calling it ordinary classifier accuracy.

For multiple classes, show a full expected-by-predicted matrix and per-class
one-vs-rest rates with support counts. Label macro averages (equal class weight)
and micro averages (pooled decisions) explicitly. Multi-label tasks require a
separate binary decision per label and an explicit abstention rule.

The bundled `measure.mjs calibrate` command measures a **judge** against human
pass/fail labels; its positive class is human `pass`. It reports conditional
TPR/TNR and coverage, not a general application-classification dashboard or
precision/recall for arbitrary class names. Use its confusion counts correctly,
or calculate application classification metrics in the private postprocessor.
Keep human labels, judge predictions, and application predictions distinct.

## Private sidecar contract

Use a versioned measurement set under the existing private eval directory:

```text
results/<run>/measurements/<measurement-version>/
  definitions.json           Frozen measurement definitions and source identity
  measurements.jsonl         One observation per planned attempt and metric
  receipts.jsonl             Optional distinct measurement/judge call receipts
  summary.json               Generated aggregates with coverage and exclusions
  measurements.md            Generated human-readable supplement
```

These are application-private files, not new bundled runtime inputs. Keep them
Git-ignored, excluded from packages and uploads, in owner-only directories
(`0700`) with owner-only files (`0600`) on POSIX. Versioned outputs preserve
earlier measurements. Do not put private examples, derived values, or their
hashes in the skill repository. A digest proves a local join, not anonymization.

`definitions.json` has `schemaVersion: 1`, `measurementVersion`, the frozen
`runId`, `workload` copied exactly from `run.json`, and a `metrics` array. Each
metric has `id`, `label`, `valueType` (`number`, `boolean`, or `category`), `unit`,
`direction`, `eligibility`, `aggregation`, `missingRule`, `producerVersion`, and
either a numeric `range`, categorical `categories`, or `null` where inapplicable.
Include any threshold, positive-class mapping, retrieval cutoff/gain definition,
and pairwise reference rule in that definition. Hash the complete definition
with the canonical procedure below; changing a definition requires a new version.

The sidecar uses long-form rows so each metric has its own missingness and
provenance. This is its schema; it is **not** a `results.jsonl` schema:

```ts
{
  schemaVersion: 1,
  measurementVersion: string,
  definitionSha256: string,          // 64 lowercase hex characters
  runId: string,
  caseId: string,
  repetition: number,               // integer, 1..run.repetitions
  outputEvidence: { version: "attempt-v1", sha256: string },
  metricId: string,                 // declared in definitions.json
  status: "observed" | "missing" | "ineligible" | "error",
  value: number | boolean | string | null,
  numerator: number | null,         // optional ratio components, explicit null otherwise
  denominator: number | null,
  reason: string,                   // explanation, including every exclusion
  details: object,                  // metric-specific JSON evidence, never executable markup
  producer: {
    kind: "code" | "human" | "model",
    version: string,
    reviewer: string | null,        // required attribution for human measurements
    receiptIds: string[]            // joins distinct entries in receipts.jsonl; [] if unavailable
  }
}
```

Every planned `(runId, caseId, repetition, metricId)` occurs exactly once in a
measurement version. Enumerate the frozen cases and one-based repetitions even
when results are absent. Require finite numbers in the declared range and exact
categorical membership. Only `observed` has a non-null value. Other statuses
have `value: null` and an explicit reason; unknown is never silently zero or
false. Missing denominator or zero denominator produces a null ratio. Partial
coverage must remain visible rather than shrinking the plan.

For a ratio, retain its eligible numerator/denominator and their unit in the
definition. For pairwise metrics, `details` must contain the reference run/case/
repetition, its evidence identity, the A/B assignment, and the original judge
choice. For classification retain the expected and predicted class. For RAG
retain ranked chunk IDs, relevance labels, required chunks, cutoff, and corpus
version. Keep full private evidence nearby; a reference string is data, not a
path the report should automatically read or link.

Each optional receipt has a unique `id`, `kind` (`code`, `fresh`, or
`historical`), actual `model` or null, `requestIds`, `costUsd` or null, and
`latencyMs` or null. Include source/version attribution and private detailed
usage evidence for a priced call. Include billed failed calls and retries in
the receipt totals even when no observed measurement points to them. References
from several metric rows to one receipt do not multiply its spending. Existing application receipts stay with
the application result; do not relabel them as new measurement calls.

Bind observations to exact evidence with this pure, offline identity helper.
The whole result row is included conservatively: changes to output, trace,
status, receipts, or verdicts require checking the measurement again. Unrelated
attempts finishing do not change an existing attempt’s identity. This is a
separate contract from browser annotation hashes; do not interchange them.

```js
import { createHash } from 'node:crypto';

export function digest(value) {
  // Inputs are parsed JSON: no undefined, non-finite numbers, or executable values.
  const canonical = JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item);
  return createHash('sha256').update(canonical).digest('hex');
}

export function outputEvidence(run, task, repetition, row = null) {
  if (!Number.isInteger(repetition) || repetition < 1 || repetition > run.repetitions)
    throw Error('Repetition is outside the frozen plan.');
  if (row && (row.caseId !== task.id || row.repetition !== repetition))
    throw Error('Result does not match the planned attempt.');
  const value = { version: 'attempt-v1', runId: run.id, kind: run.kind,
    fingerprint: run.fingerprint, manifest: run.manifest, task, repetition, row };
  return { version: 'attempt-v1', sha256: digest(value) };
}
```

On every read, reconstruct the identity from the frozen run/case and recorded
row and compare it and the definition hash. Reject duplicate keys, unknown
metrics/cases, out-of-range repetitions, mismatched versions, and stale evidence
before aggregating. Do not silently apply an earlier score to a changed output.
For a partially completed run, build a new measurement version when rows change;
reuse only observations whose definitions and individual evidence still match.
Preserve original human/model judgments and their provenance.

## Build the measurement supplement

The agent implementing the eval writes a small private postprocessor in the
application’s existing language. Reuse a trusted existing framework if it
already computes these measurements. There is no bundled `measurements` command;
`measure.mjs` exposes helpers and the separate `calibrate` command only.

When a native framework already supplies the measurements and readable report,
verify the same evidence, definitions, coverage, and regeneration behavior in
place. The following file/command recipe is only for a supplement to the bundled
report; it does not require a second report or parallel records for native tools.

1. Freeze definitions and eligible populations. Load the frozen run, cases, and
   recorded results through the bundled read/validation helpers where possible.
   Start from every planned attempt, not only successful rows. Resolve all joins
   explicitly and reject conflicts before writing output.
2. Extract only available observations, or invoke the separately authorized
   evaluator and save its receipts. A report/aggregation pass itself makes no
   inference calls. Values that cannot be recovered become null with reasons.
3. Validate the sidecar contract and evidence identities. Produce `summary.json`
   and `measurements.md` from those validated rows with no hand-entered totals.
   Write atomically and refuse to overwrite an existing measurement version.
4. Include the source workload, run kind/ID, actual models, frozen definitions,
   case/attempt counts, units/directions, observed/eligible/planned coverage,
   exclusions by reason, and source hashes. Show numeric distributions, the
   chosen case aggregation, categorical counts, and separate app/judge costs.
   Each case row identifies case, repetition, value, and reason; show expected
   behavior and the relevant output beside any disputed grade.
5. Run the normal bundled `report` command and present its `report.html` together
   with the companion `measurements.md`. Keep a link and the exact private
   postprocessor command in `eval.md`; do not append to generated `report.md`
   and expect it to survive regeneration. An existing safe viewer may display
   the supplement. Do not generate unchecked HTML from outputs or follow
   dataset-supplied attachment paths.
6. Verify one high score, one low score, one missing observation, and a known
   calculation by hand. Reconcile counts with the plan and inspect the rendered
   Markdown. Escape table/heading text, and use text fences longer than any
   backtick run in evidence. Check malicious-looking text remains text. Rerun
   the postprocessor offline and confirm identical aggregates.

These pure functions illustrate null-safe calculations for already validated
observations. Integrate them into the private postprocessor; they do not load,
validate, or persist sidecar files themselves.

```js
export const ratio = (a, b) => b === 0 ? null : a / b;

export function classification(rows) {
  const c = { TP: 0, FN: 0, FP: 0, TN: 0, unknownTruth: 0,
    excludedPositive: 0, excludedNegative: 0 };
  for (const { expected, predicted } of rows) {
    if (expected !== true && expected !== false) { c.unknownTruth++; continue; }
    if (predicted !== true && predicted !== false) {
      c[expected ? 'excludedPositive' : 'excludedNegative']++; continue;
    }
    c[expected ? (predicted ? 'TP' : 'FN') : (predicted ? 'FP' : 'TN')]++;
  }
  const decided = c.TP + c.FN + c.FP + c.TN;
  return { ...c, planned: rows.length, decided,
    precision: ratio(c.TP, c.TP + c.FP), recall: ratio(c.TP, c.TP + c.FN),
    specificity: ratio(c.TN, c.TN + c.FP), fpr: ratio(c.FP, c.TN + c.FP),
    accuracy: ratio(c.TP + c.TN, decided) };
}

export function pairwise(values) {
  const counts = { candidate: 0, reference: 0, tie: 0, both_bad: 0, unscored: 0 };
  for (const value of values) {
    if (value === null) counts.unscored++;
    else if (['candidate', 'reference', 'tie', 'both_bad'].includes(value)) counts[value]++;
    else throw Error('Invalid pairwise category.');
  }
  const assessed = values.length - counts.unscored;
  return { ...counts, planned: values.length, assessed,
    strictWinRate: ratio(counts.candidate, assessed),
    winRateAmongPreferences: ratio(counts.candidate, counts.candidate + counts.reference) };
}

export function caseMean(rows) {
  const cases = new Map();
  for (const { caseId, value } of rows) {
    const item = cases.get(caseId) ?? { planned: 0, observed: [] };
    item.planned++;
    if (value !== null) item.observed.push(value);
    cases.set(caseId, item);
  }
  const perCase = [...cases].map(([caseId, item]) => ({ caseId,
    planned: item.planned, observed: item.observed.length,
    mean: item.observed.length ? item.observed.reduce((a, b) => a + b, 0) / item.observed.length : null }));
  const observed = perCase.filter(item => item.mean !== null);
  return { perCase, casesObserved: observed.length, casesPlanned: perCase.length,
    observedCaseMean: observed.length ? observed.reduce((s, item) => s + item.mean, 0) / observed.length : null };
}
```

Test missing classes and zero denominators, ties versus both-bad, unequal
repetitions, duplicate attempt rejection, and a changed output’s evidence hash.
The last helper deliberately labels its result an observed-case mean; report
its per-case coverage and the sidecar’s separate eligibility/exclusion counts.
It does not make an incomplete run a complete assessment.

## A concrete RAG recipe

Inspect complete end-to-end examples first: the user query, ranked retrieval
results, context actually supplied to the generator, output, and failure reason.
Distinguish absent evidence from the generator misusing available evidence.
Freeze the corpus snapshot, document/chunk IDs and boundaries, index/retriever/
reranker settings, query transformations, top-k, and supplied-context order.
The retrieval tool’s returned list and the generator’s final context can differ;
save both. Record chunking boundaries and title/section context so the eval can
detect boundary-splitting failures without changing the pipeline during measurement.

Build queries with independently checked relevant chunks. Hand-curated queries
are a good starting point. To expand synthetically, extract a self-contained
fact from a chunk, write an answerable question, then have a human check that
the answer is supported and the question sounds like a real request. Distractors
should share terminology without supplying the needed fact. A realism score
can rank candidates for curation; it is not a task failure rate. Track synthetic
origin and do not claim production coverage from synthetic examples.

The following corpus and query are wholly invented:

| Chunk ID | Text | Relevance to the query below |
| --- | --- | --- |
| `dome-blue` | Blue-pass visitors must leave Juniper Dome by 18:00 on Fridays. | 1: answers the question |
| `dome-amber` | Amber-pass visitors must leave Juniper Dome by 20:00 on Fridays. | 0: wrong pass type |
| `hall-blue` | Blue-pass visitors must leave Cedar Hall by 20:00 on Fridays. | 0: wrong venue |
| `dome-reservation` | Every evening visit to Juniper Dome requires a same-day reservation. | 0: a separate requirement |

Query: “With a blue pass, can I stay in Juniper Dome until 19:00 on Friday?”
Expected behavior: say no, identify the 18:00 closing time, and ground the
answer in `dome-blue`. An answer giving 20:00 from `dome-amber` misapplies the
pass-type condition even though those words occur in the retrieved context.

If top-2 retrieval returns `[dome-amber, dome-blue]`, recall@2 is `1/1 = 1`,
precision@2 is `1/2 = 0.5`, reciprocal rank within 2 is `1/2 = 0.5`, and linear-
gain nDCG@2 is `1/log2(3) = 0.63093`. All required evidence is present. These
numbers establish retrieval behavior, not a correct final answer.

Use the bundled offline helper on these exact IDs; no model is needed:

```js
// Import retrievalMetrics from the installed skill's scripts/measure.mjs.
const metrics = retrievalMetrics({
  retrieved: ['dome-amber', 'dome-blue'],
  relevance: { 'dome-blue': 1, 'dome-amber': 0, 'hall-blue': 0, 'dome-reservation': 0 },
  k: 2, labelsComplete: true, required: ['dome-blue'],
});
```

Choose metrics by what evidence the task needs:

| Retrieval concern | Measurement and denominator |
| --- | --- |
| First-stage coverage | Recall@k: relevant chunks retrieved / all relevant chunks for the query. |
| Noise in final context | Precision@k: relevant chunks retrieved / k. The helper uses k even if fewer are returned; also show returned count. |
| Single-fact ranking | Reciprocal rank of the first relevant chunk within k; average per-query values for MRR@k. No hit gives zero when the top-k labels are known. |
| Graded usefulness | nDCG@k using declared linear relevance gains and an ideal ranking from the complete relevance set. Show recall too; ranking weakly useful evidence well does not ensure the answer’s evidence was found. |
| Multiple required facts | Fraction of eligible queries where every required evidence chunk is within k. Keep per-query missing-hop IDs; ordinary chunk recall can hide a missing essential hop. |

Choose k from the actual retrieval/context budget and query type, then freeze
it. Explicit relevance `0` means judged irrelevant; an absent label means
unknown. With incomplete relevance judgments, recall and nDCG are unknown.
The helper downgrades a claimed `labelsComplete: true` to false if any supplied
retrieved or required ID lacks a label, including a retrieved ID outside top-k.
It lists those IDs in `missingLabels`; do not hide that warning behind a score.
Unknown labels among the returned top-k make precision and reciprocal rank
unknown in the helper too. There is no recall denominator when no relevant
chunk exists: use an explicit unanswerable-query test rather than claim recall
of zero or one. The helper requires unique retrieved IDs; deduplicate by a
documented rule or reject a broken retrieval record before calling it.

For a multi-hop variation, ask: “What is the blue-pass Friday closing time at
Juniper Dome, and do I need a reservation?” Now `dome-blue` and
`dome-reservation` are both required and relevant. The same retrieved pair has
recall@2 `1/2`, precision@2 `1/2`, nDCG@2 about `0.38685`, and `allRequired:
false`. Report the reservation hop as missing. For answerable queries with
alternative interchangeable sources, define required evidence groups in the
private evaluator; the helper’s `required` parameter only supports specific
chunk IDs and must not pretend all alternatives are mandatory.

Grade generation separately using the context actually supplied:

- **Grounding and interpretation:** factual claims are supported by that context
  and preserve conditions such as pass type, venue, date, and exceptions.
- **Answer relevance and completeness:** the response answers the user’s
  question and includes each required part. Citation presence alone is not
  sufficient evidence of either grounding or completeness.
- **Insufficient-context behavior:** when the necessary chunk is missing, the
  response follows the agreed uncertainty/abstention policy. A correct guess
  from outside knowledge is not evidence that a context-grounded task succeeded.

Use precise binary generation criteria derived from observed errors; retain a
separate coverage fraction if useful. Similarity to a reference answer is not a
substitute for support and task correctness. Judge source text and answers as
data, and validate judges using faithful alternatives, plausible unsupported
answers, and correct facts applied to the wrong entity or condition.

Show retrieval and generation results side by side. Missing required context
identifies a retrieval/context-assembly gap; complete evidence plus a wrong
answer identifies a generation failure; both can fail on the same task. An
optional controlled generation check can supply the independently verified
gold context to isolate the generator, labeled as a separate condition. Its
score must not replace end-to-end results. Do not infer the original failure’s
cause solely from one scalar score. Hand over the frozen recipe and measured
diagnosis; changes to chunking, ranking, prompts, or models are separate work.
