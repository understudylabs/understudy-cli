# Medium: build and validate the complete eval

Read the shared instructions in [SKILL.md](../SKILL.md) and
[eval checks](check-eval.md) before designing cases or grading. These
checks are construction requirements, not a final checklist to skim after
spending money. Prefer a suitable existing eval's runner, schemas, graders, and
reports. Apply the checks using its native artifacts and commands; no conversion
to the bundled format is required. Use the optional tools in
[the file and command contract](formats.md) when they fill a real gap or the
developer chooses them. File and command examples below use the bundled path;
existing tools can supply equivalent evidence in their own format. Record that
mapping and the native commands in `eval.md` rather than building a second runner.
For example, a Python eval can keep its CSV cases, Python grader, and Markdown
report. Configure its private output directory and document its native field
names; do not introduce a Node adapter or duplicate records merely to follow
this workflow. Missing evidence calls for a targeted improvement to that eval,
not automatic replacement of its formats.

Medium follows one resolved Understudy workload from its application responsibility
through captured examples, success criteria, execution, and a trustworthy
measurement. Apply the branches relevant to this workload: an extractor does
not need a retrieval benchmark or simulated tool environment. Complete the core
phases below; document a missing dependency instead of silently treating a
partial or unvalidated phase as finished.

Keep these companion guides open when their work begins:

- [Case review](case-review.md): actual-input review, the workload's UI, human
  observations, failure definitions, and the repeated discovery loop.
- [Worked example](worked-example.md): a complete invented task, good and bad
  outputs, semantic judge, human disagreement, and calibration evidence.
- [Measurements](measurements.md): metric selection, classification and retrieval
  recipes, and supplementary reports beyond the bundled binary checks.

The deliverable is a runnable eval and a report the owner can inspect. A document
describing a future eval is not a completed Medium run. Keep updates short and
point to actual cases and reports instead of narrating internal bookkeeping.

### Decisions to resolve with the user

Read the code and prior instructions first; propose a concrete recommendation
instead of asking the user to design the eval. Use the host's question tool when
available, including `AskUserQuestion` in Claude Code, or ordinary chat. Batch
related decisions. Do not require a particular harness or provider.

| Decision | Show before asking | Question to resolve |
| --- | --- | --- |
| Scope | The existing workload and real call site | Is this the responsibility and end-to-end outcome you want to measure? |
| Inputs | Actual proposed cases, source counts, missing categories, artifacts | Are these the cases that matter, and what is missing or irrelevant? |
| Presentation | A few cases in the existing viewer or bundled page | Would a local interactive UI, Markdown, or your existing tool make these easiest to review? |
| Grading | Acceptable, alternative, wrong, and borderline outputs with proposed verdicts | Would you score any of these differently, or does a criterion measure the wrong thing? |
| Product constraints | Measurable quality, latency, cost, and behavior fields | Which should appear in the report, and which are actual pass/fail requirements? |

Before running the full baseline, resolve two judgments with the owner:
the selected inputs and the grading method. Show the concrete
version, make requested corrections, and retain the response in `eval.md`.
Prior explicit acceptance of that same version counts; do not ask twice.
Silence is not a judgment. Wait for the material design answer before a paid
pilot or full run that depends on it; any earlier diagnostic calls need their
own explicit scope. While a material question is pending, continue local
runner, viewer, and control work, keeping unconfirmed rules provisional. If the
owner delegates those judgments, record that delegation and its scope; it is
not independent human calibration. Follow existing execution authorization;
ask about paid scope only where it is missing or the proposed run exceeds it.

### 1. Understand and resolve the workload; audit what already exists

Identify the stable model-backed responsibility and the actual entry point that
runs it. Follow model invocations through generic wrappers to their purpose and
expected result. Different responsibilities remain distinct even if they share
an SDK or schema; retries and repeated executions of one responsibility reuse
its workload. Resolve one existing organization/project/workload with the CLI
reads in [shared setup](../SKILL.md#shared-setup) before selecting its captures.
Save the returned IDs and name in the native eval's workload metadata or private
`eval.md` (`manifest.workload` for the bundled path). Retain the project slug,
verification evidence, source environment, and code mapping there too.

Inspect the prompt,
model/settings, context assembly, memory, retrieval, tools, output parser, and
downstream effects that matter for this responsibility. Determine whether the eval unit
is a call, a conversation, or a completed application task. A final sentence
alone may not establish that an agent completed its work.

An application task may cross several workloads. Define the selected workload's
start and finish boundaries and hold other stages as explicit dependencies or
fixed context; their outputs and costs must not inflate its results. If an
existing broad/default workload mixes responsibilities, declare the subset being
evaluated and the coverage limitation. Record a missing or unsuitable mapping
for a later workload-design decision; do not create, rename, reassign, or reroute
workloads as an incidental part of eval building.

Inventory existing cases, expected answers, labels, graders, runner, environment,
and reports. Inspect their actual code and recent results; exercise a few cases
locally when possible. Preserve usable parts and repair verified measurement
defects instead of replacing the framework. Record whether expected answers were
written by a human, verified by one, generated by a model, or still unverified.
Run the check-eval guide's audit on an existing eval before trusting it. Report
verified defects with case/file evidence and distinguish usable parts from
parts needing repair. Ask whether the cases still resemble today's traffic and
who established the expected outcomes if that is not already documented. Do
not assume a model-produced answer key is correct because it is called gold.

For a multi-turn application, default to the completed task or conversation
outcome. Grade individual turns only when that is the intended responsibility;
a reasonable final sentence can still follow an earlier harmful action. List
what one invocation carries besides text: files, images, user context, memory,
retrieval state, a repository snapshot, or a workspace. Keep the real input
shape rather than flattening all of it into a prompt string.

State the decision the eval will support: regression detection, a later model
comparison, a specific quality threshold, or finding existing failures. Establish
the costly mistakes, performance ceilings, and smallest difference worth acting
on. Distinguish a requested behavior absent from the application instructions
from a failure to follow existing instructions. Report that specification gap;
do not silently optimize the application while writing its eval.

Deliver a short workload contract: resolved identity, responsibility, entry point,
initial inputs, allowed actions, required and forbidden outcomes, relevant policy
scope, observable evidence, and unknowns. Record setup gaps such as missing
request-ID attribution or unavailable capture evidence. Continue independent
local investigation without pretending those gaps are resolved.
State which existing pieces will be reused and which will be built. For a new
eval, an initial 15–100 development tasks is a useful planning range when that
many suitable examples exist, not a quota or a statistical guarantee. Choose
the count from workload diversity, review effort, spending limits, and the
decision's required resolution. A handful of cases is a pilot or selected
regression check; name that narrower claim. Avoid constructing a large set the
owner will never review.

### 2. Inventory the evidence and design coverage

Use [the capture workflow](captures.md): ask for important task/request IDs,
verify membership in the resolved workload, and download retained captures.
Freeze that identity with the source selection. Keep evidence from other
workloads clearly marked as dependency context, outside the selected case
population. Inventory the selected development source set with
code: record counts, missing bodies, decode failures, duplicates, task linkage,
input/answer lengths, task categories, outcomes, tool counts, and relevant context
sizes. An exhaustive structural inventory does not mean every trace was read
semantically. Report which inspections were exhaustive and which were sampled.
Reserve any final task groups before this inspection. An independent custodian
can audit reserved contents and return structural aggregates; the development
agent must not inspect those inputs, labels, or outcomes while calling them unseen.

Keep three purposes separate:

| Set | Purpose | Selection |
| --- | --- | --- |
| Discovery and regression cases | Find failures and keep important ones from returning | Owner examples, varied task types, hard cases, outliers, and random exploration |
| Grader calibration examples | Measure whether a checker agrees with trusted labels | Both acceptable and unacceptable outputs for each criterion |
| Population measurement, if requested | Estimate performance on a stated traffic population | A documented probability sample or stratified sample with valid weights |

Do not average those purposes together. Oversampling failures is useful for
debugging and judge calibration but changes apparent prevalence. Include random
exploration alongside deliberate coverage so the owner's remembered failures
are not the only ones investigated. Record the source window, eligible task
population, exclusions, selection seed, and achieved coverage.

If this eval will guide repeated tuning/model selection or an unseen-task claim,
reserve final task groups now, before inspecting their content or outcomes.
Keep related requests, retries, conversations, near duplicates, and variants of
one synthetic seed together. Group by customer when the claim concerns unseen
customers. Otherwise name the result a development/regression suite. A small
token holdout does not justify a strong generalization claim.

For an exact production time clue, use:

```sh
understudy captures list --org <organization-id> \
  --project <project-id> --workload <workload-id> \
  --from <timezone-qualified-start> --to <timezone-qualified-end> --json
```

This indexed search covers at most 24 hours, with inclusive start and exclusive
end, and cannot extend into the future or combine with pagination/request-log
filters. Export selected IDs afterward; `captures export` has no timestamp
`--from/--to`. For authorized whole-day collection, use `captures export` with
`--date <completed-UTC-date>` instead of an ID file, plus project/workload,
payload flags, and a new output directory. A server HTTP 501 means the indexed
capability is unavailable; a different selection method must be disclosed.

Prefer retained workload captures, then application incidents or owner-provided
examples, then deliberately generated cases. Ask about what makes an example
hard before generating a suite from code alone. If no real examples exist,
make that limitation visible and build a provisional synthetic bootstrap;
never imply it represents observed traffic. Check permitted retention and who
can review the material before exporting it. Record the chosen retention and
reacquisition strategy, including whether old captures may expire. Source IDs
and rewritten customer examples remain private too. Do not commit them to make
the eval durable.

### 3. Reconstruct the task the model must actually do

For each development task in this workload, establish the initial user request, instructions,
context already available at that point, ordered request membership, attachments,
relevant tool state, and terminal outcome. Correlate application identity and
message/tool continuity. Shared timestamps or a shared trace ID alone are
insufficient. Customer capture envelopes do not supply a guaranteed task/parent
graph. Record grouping evidence and ambiguous membership.

Preserve raw evidence and create separate case records. Each case needs:

- A local case ID, related-task group, verified workload/request membership, and selection purpose.
- The exact start boundary and inputs the application would have at that point.
- Required files/state, tool contracts, and provenance of replayed or simulated facts.
- Applicable expected outcomes, their authority, and the evidence needed to grade.
- Historical output, missing context, and eligibility or exclusion reason.

Hidden answers, evaluator code, future assistant messages, and future tool
results must not be accessible to the evaluated agent. Preserve requirements
the application normally provides. Return recorded tool results only when the
corresponding action occurs. Do not hide answer keys merely with an instruction
when the tested agent can read their files.

If full execution cannot be reconstructed, keep the task visible as unsupported
or explicitly narrow it to a call/continuation test. Do not fabricate history,
assume an unknown ending, or merge unrelated calls to make a complete example.

An illustrative diagnostic task might start with "the export job stopped
producing a file." Do not replace that request with "fix the off-by-one in
exporter.py" just because the later trace exposed the cause. A retrieval case
must begin with the user's query, not the answer copied into its context before
the tool was called. Use [the worked example](worked-example.md) to check how
source facts, initial inputs, expected behavior, and observations stay separate.

Build a readable input inventory with stable case IDs, task type, source,
group/split, expected-outcome authority, attachment paths, and known omissions.
Make every selected development case accessible, even if the owner reads a
stratified subset of a large set. Specify the actual review coverage and run
structural checks over the whole set. Reserved final cases stay with their
designated reviewer and out of the development agent's workspace. Resolve the
input judgment above before claiming the selected set is owner-reviewed.

### 4. Discover failures with the person who understands the task

Follow [case review](case-review.md), including its presentation question,
workload-specific case layout, annotation persistence checks, and discovery
loop. The following is the phase's purpose, not a replacement for that procedure.

Show complete interactions in a readable form: the request, relevant context,
tool calls/results, artifacts or resulting state, and final output. Reuse the
customer's viewer when suitable. Markdown works for a modest set; for sustained
review, use the bundled `review` page or run report, which provides discovery
notes, per-criterion labels, filtering, and review export/import. Follow
[the review and measurement commands](formats.md#human-review-and-medium-measurements). Render untrusted content safely. Test
annotation save/reload, corrections, and representative long traces/artifacts.
A new UI is useful only if it reduces the actual review burden.

Start with free-text observations such as “what is wrong or missing here?”
Avoid forcing reviewers into a taxonomy before they have discovered the problems.
The agent turns their notes into candidate failure definitions. For each, retain
the scope, description, severity, example evidence, reviewer, and confirmation
state. Keep agent suggestions distinct from confirmed owner judgments.

Alternate breadth and depth: inspect diverse and random cases; investigate a
new failure in related cases; then return to unexplored coverage. Search the
available corpus for additional examples when a definition is clear enough,
reporting what was scanned. Revisit earlier reviewed cases when the definition
changes. A subagent may search when available, but suggestions do not become
human labels automatically.

Track confirmed and proposed failures, reviewed task types, disagreements, and
the arrival of new failure modes. Stop discovery when the important coverage is
reviewed and additional batches mostly repeat known modes, or when the agreed
limit is reached. A limit reached before that point is incomplete discovery.
Have the owner resolve meaningful ambiguity and confirm the scope of the rules;
reuse prior explicit decisions instead of repeating sign-offs.
Save review evidence and versioned failure definitions in the existing tool's
private records, or under `review/` for a new local workflow. Document where
reviewer identity, evidence version, and decisions are retained.
The bundled page supplies notes and criterion labels; it does not automatically
cluster a corpus, maintain a live taxonomy, or accept suggested labels. Add those
parts in private application code when the review workflow needs them, preserving
separate agent proposals and human judgments. Complete the useful review loop
instead of stopping after generating an attractive page.

### 5. Turn the findings into cases and success criteria

Create a coverage table mapping task types and failure modes to cases and checks.
Include ordinary successes, known failures, boundaries, and both directions of
conditional behavior: when to act and when to abstain, search, refuse, or escalate.
Give each rule its actual user/agent/policy scope rather than generalizing an
example into a universal requirement.

Define observable postconditions and permitted alternatives. Independently
re-derive a sample of expected answers. Check for ambiguity, stale facts, artifacts
that reveal labels, unrealistic difficulty, and shortcuts that avoid the work
the eval is meant to measure. Keep the historical model's answer separate from
ground truth. For an agent that writes an artifact or changes state, correctness
must inspect that artifact or state, not just a convincing transcript.

If coverage is missing, generate cases deliberately:

1. Identify a few meaningful dimensions from observed failures, such as task
   type, available evidence, ambiguity, or interaction length.
2. Propose plausible combinations and resolve domain uncertainty with the owner.
3. Generate the input wording separately from those combinations; preserve
   coherent attachments and initial state.
4. Check realism, duplication, answerability, and valid expected outcomes.
   Fix a faulty generation rule rather than filtering away its repeated defects.
5. Run the cases through the same validated application boundary and inspect
   their complete interactions. Keep them labeled synthetic and outside
   production prevalence estimates.

For a resolved workload without traces, bootstrap from the application contract
and owner examples. Keep its real Understudy identity and label generated cases
synthetic. The resulting eval is a starting point until actual workload captures
can test its relevance. A missing workload identity remains a setup gap; the
demo's invented identity is not a substitute. Do not manufacture domain realism
or expert labels.

Present the coverage table and concrete cases for correction. The owner should
understand both what is covered and what is absent before an authoritative
quality claim is made.
For each criterion show its applicability, evidence, allowed alternatives, and
the failure it is meant to catch. Also list meaningful criteria considered but
left out, with the reason, so the owner can restore an omitted requirement.
Avoid scoring one underlying mistake twice under different names. Generalize
from an example only as far as the application policy warrants: a rule against
one disallowed source is not permission to invent a universal credibility policy.
Verify checkable facts in the code, supplied policy, or authoritative docs before
turning them into an answer key. Keep tradeoffs such as brevity versus coverage
as separate measures unless the owner has specified an actual hard ceiling.

### 6. Build the graders and prove they measure the right thing

Offer a grading recommendation suited to the output and show why it fits:

| Output or question | Starting method | Evidence it must see |
| --- | --- | --- |
| Closed labels, numbers, structured extraction | Code checks | Parsed fields, contract, permitted normalizations |
| Agent writes a file or changes state | End-state tests | Artifact or disposable environment after execution, including forbidden effects |
| Open-ended factual or policy-dependent prose | A narrow semantic rubric, initially checked by a person | Task facts, applicable policy, candidate output, supporting evidence |
| Which of two existing outputs is better? | Blind pairwise judgment with ties and both-bad outcomes | The same task and two saved outputs, with identity hidden |
| Specialized judgment with insufficient trusted labels | Human review | Full interaction and relevant artifacts |

Cost alone does not make a substring test suitable for meaning. Ask which judge
model or existing judge service to use when the choice is unresolved; recommend
from the user's available, authorized options without hard-coding a provider.
Use that provider's actual SDK, model identifiers, protocol, and structured-output
support. Save the effective schema and model settings; a prose instruction to
"return JSON" still requires parse and schema validation.

Choose product metrics with the user using [measurements](measurements.md).
Keep suitable native measurements and reports. The bundled runner supports
binary criterion verdicts and a fixed set of cost, timing, and token fields.
When using it, numeric scores, pairwise judgments, retrieval measures, and other
product fields need the supplementary records and report in that guide. An
existing runner may retain them natively. Do not invent unsupported keys, discard
such measures, or coerce every metric into Pass/Fail to fit the bundled tools.

Use separate checks for independent requirements. Prefer binary outcomes for
requirements and separate numeric measures for cost, latency, or task-specific
partial credit. Do not blend them into an unexplained score. If using partial
credit, define its meaning and test that doing nothing or exploiting a loophole
cannot score better than completing the task.

**Code checks.** Parse and validate structured output, test constraints, execute
artifact tests, or inspect final state. Normalize only differences the contract
allows. Exercise correct answers, valid alternatives, near misses, empty or
constant outputs, boundaries, and plausible incorrect results. Verify that all
reference solutions pass and important violations fail. Test the longest
supported output and distinguish a checker crash from a rejected answer.

**Model judges.** Use these for requirements that genuinely need interpretation.
Each judge addresses one clear criterion and receives the relevant task facts,
applicable policy, and evidence. Its prompt must contain the criterion, explicit
pass/fail boundaries, a few clear and borderline labeled examples, and a checked
output schema. Save a short reason with evidence references and the verdict;
permit `unscored` for insufficient evidence. Parse or transport failure is a
judge error, not a quality label. Treat candidate text as untrusted data.

Hide candidate identity and prestige labels. Do not reward verbosity. For a
pairwise check, randomize or reverse presentation order; save that order, reasons,
ties, and both-bad outcomes. Use a fixed reference if later comparisons depend
on it. Preference over a weak answer does not establish absolute task success.
Record the judge model/settings; using another model family does not itself
prove independence. Judge selection must be validated against humans, including
when the same model is used for the application and grading.

Before locking the method, show several concrete outputs with their evidence,
individual grades, and reasons in the review UI. Include a pass, a meaningful
failure, a valid alternative, and a borderline or insufficient-evidence case.
Ask whether the owner would grade any differently. Investigate each disagreement:
it may expose a wrong label, missing evidence, an unclear requirement, or a judge
defect. Correct the affected layer and show fresh examples before recording the
grading judgment. Human calibration below is separate from this small design
review. [The worked example](worked-example.md) supplies an actual prompt and
shows the difference between fixing a grader and changing the workload.

#### Calibrate a model judge against independent human labels

Count paid judge calls for controls, calibration, and repetitions before invoking
`validate` or the judge client. Use the authorized test scope and spending cap;
local code and human-review wiring need no inference when their graders are local.

After the failure definitions are clear, collect Pass/Fail/Defer labels for each
criterion from someone qualified to judge the task. Retain evidence and reasons.
Resolve material disagreements; do not force disputed cases into gold labels.
If domain authority is unclear, obtain qualified review; agreement between two
unqualified reviewers does not establish correctness. Balanced calibration
examples help expose both error directions, but do not claim they reflect the
production label distribution.

Partition related examples before building the judge:

| Partition | Use | Restriction |
| --- | --- | --- |
| Prompt examples | Clear and borderline demonstrations | The only examples embedded in the judge prompt |
| Development | Diagnose disagreements and revise the judge | Can be reused, but cannot measure final generalization |
| Held-out test | Measure the frozen judge once | Keep content and labels out of judge development |

Size each partition so both human Pass and human Fail are meaningfully measured.
A few dozen labels can expose basic defects; stronger error-rate claims need
more evidence. If a class is missing, its detection rate is unknown. Previously
inspected examples cannot retroactively become an untouched test set.

For each criterion report the four counts and their denominators:

- Correct passes and false failures among human Pass examples.
- Correct failures and false passes among human Fail examples.
- Sensitivity, or TPR = correct passes / human Pass examples.
- Specificity, or TNR = correct failures / human Fail examples.

Compute that binary confusion matrix on completed Pass/Fail judgments against
non-deferred human labels. Show the scored and total count for each human class,
plus abstentions and judge errors; rates on the scored subset do not establish
performance on omitted cases. Overall agreement alone can hide a judge that
passes everything. Set minimum grading coverage and acceptable false-pass and
false-failure rates from the consequence of those mistakes before checking the
final set; no universal percentage certifies every application.

Inspect development disagreements and repair the criterion, evidence supplied,
prompt examples, or judge implementation. Recheck earlier labels when the rule
changes. Bound this calibration work by the agreed effort and paid-call limits.
Save the actual human labels and frozen-judge predictions in the existing
calibration format, retaining case/criterion identity and judge version.
Calculate confusion counts, coverage, and applicable intervals using its tested
analysis tools. If choosing the bundled `measure.mjs calibrate` helper, provide
only the `calibration.jsonl` records it consumes; this does not require converting
the application cases or results. Keep original labeling and judging evidence
separate and inspectable.
Freeze the judge and run its held-out test once. Report uncertainty as well as
point estimates. Measure grading variability on repeated fixed outputs when
the judge is stochastic. Failed validation means manual review or a visibly
provisional metric, not an automatically trusted score. Further changes require
a new version and fresh held-out evidence for a new validation claim.

Judge-validation data and final application cases serve different purposes.
Using final application outcomes to repair a judge consumes their held-out status.

#### When the application retrieves information

Use [the retrieval recipe](measurements.md) to construct query/evidence labels,
add genuine distractors and no-answer cases, run retrieval and generation
separately, and produce inspectable per-query measurements.

Evaluate retrieval and answer generation separately. Keep queries, relevant
document/chunk labels, retrieved rankings, and cutoffs. Use recall@k for finding
required evidence, precision@k for the relevance of returned results, MRR for
the first useful hit, or nDCG for a relevance-graded ranking. Missing relevance
labels are not evidence that a document is irrelevant. For multi-hop tasks,
check whether all required evidence arrived and where a retrieval chain failed.

For generation, separately check correctness, support from the supplied context,
coverage of the request, and appropriate behavior when evidence is absent.
Use task-level judgments and attributable evidence. A faithful paraphrase of a
wrong document can still be incorrect; a correct memorized answer does not prove
retrieval worked. Keep corpus/chunking versions, query variants, and duplicate
documents from leaking across splits. Inspect no-answer cases, long contexts,
and relevant distractors; verify the designated evidence actually resolves each
question. Diagnose retrieval versus generation without starting an optimization
of chunking, indexing, prompts, or models.

### 7. Build and validate the execution path

Wrap the real application entry point. Inventory intentional differences from
production: test tool clients, fixed clock, retrieval snapshot, fixtures, or
limits. Verify the effective prompt, tools, context, protocol, model version,
and settings. A reconstructed API request measures that boundary, not all of
the application's omitted orchestration.

Preserve the source workload in the eval contract and link it to fresh execution
receipts. Resolve the authorized test project and workload separately; they may
differ from the source. Inference headers require that test project's slug and
workload name, not management IDs. Record judges separately in their authorized
scope. Verify that gateway responses belong to the intended test workload rather
than a fallback default.

The runner needs explicit case selection, isolated state per attempt, call/token
and wall-clock limits, durable outputs, and separate
grading for remote or multi-step execution. Reuse the existing framework's
mechanisms. The bundled runner supplies process deadlines, durable outputs,
unchanged-run resume, offline regrading, and reports. It does not automatically
retry tasks: implement transport retries only where safe, bounded, and accounted
for by the application runner or adapter. A cheap, pure local function can use a fresh complete rerun instead
of a new resume framework; preserve its fixed inputs and results and state that
choice. Do not build transport or orchestration machinery the application does
not use. For resumable runs, save completion/error records as attempts finish
and keep identifiers stable; never mix changed configurations into an existing
result. Record every attempt, including retry costs and failures. An unknown
in-flight remote outcome must not be blindly resent.

If sequential execution would make the agreed suite impractical, reuse the
application runner's bounded concurrency or implement it in a private runner
that preserves these records. Choose concurrency from the actual rate limits
and tool isolation, with jittered backoff for safely retryable transient errors.
The bundled command has no concurrency flag. Never start several writers on
the same run directory to imitate parallel execution. A larger trial count or
more concurrent requests still has to fit the authorized limits.

Persist one record per case and attempt containing source/version identity,
effective configuration, full model/tool interaction, final output/artifact or
state, fresh request receipts, execution status, timings, usage/cost evidence,
and individual checks with reasons. Keep hidden grading material outside the
tested agent's accessible workspace. Reset files, memory, database state, caches,
and simulated effects as required by the contract.

Verify that the entry point exposes served model, usage, stop reason, and the
trace. When a streaming wrapper discards them, add a small test-facing observation
hook or read existing response events; preserve application behavior. Inspect
the final decoded output, not only the first text chunk. Save per-call usage,
stop reasons, retries, and attachment metadata as private evidence when they do
not fit the chosen framework's result fields. Link them by stable execution
identity in its native records. For the bundled path, [measurements](measurements.md)
defines how to join supplementary evidence without inventing runner fields.

Represent the interaction as ordered system, user, assistant, tool-call, and
tool-result entries. Keep each tool call/result distinguishable and linked;
do not dump the entire protocol object into a single transcript bubble. Preserve
input files and produced artifacts once, then refer to their private relative
paths. A file-generating case must let the reviewer inspect that file as well
as the assistant's claim about it. Use the safe preview/fallback procedure in
[case review](case-review.md); the bundled report renders inert JSON/text and
does not itself render arbitrary artifact HTML or PDFs.

Validate the pipeline before a full paid run:

1. Exercise loading, parsing, state reset, serialization, and result persistence
   offline. Check protocol conversion against an actual captured request if used.
2. Send known acceptable outputs through the entire grading/report path, then
   plausible wrong outputs and a null/constant baseline. Inspect expected results;
   “no findings” must not be confused with “no answer.”
3. Test relevant mechanism dependence in an isolated diagnostic run. For example,
   if measuring retrieval use, show that missing required evidence is detected.
4. Inject representative timeout, transport, missing-fixture, and malformed-judge
   failures locally where those interfaces exist. Verify error accounting and
   interrupted/resumed operation when applicable; do not add unused interfaces
   merely to exercise these tests.
5. Check that the largest cases fit context/output limits and that total case
   deadlines work even when a stream keeps sending keepalives.
6. Run a small authorized baseline pilot and inspect input through final effects,
   actual model/environment, complete output decoding, and saved grades. Correct
   runner/environment defects before scaling; retain failed pilot evidence.

Read an actual saved pilot row before trusting its headline: output, trace,
model receipt, required product measurements, and available usage must match
the same execution. Investigate blank or constant columns and unexplained zero
cost/timing. Missing fields cannot generally be recovered after a full run.
Before any paid pilot, grader-control call, or auditor call, confirm it is
within the resolved execution authorization and limits. A purely local oracle,
null-output check, or source audit can happen before that authorization.

Use the existing runner's case selection for a pilot when available. The bundled
runner runs every case in its eval directory, so that path needs a separate
private pilot eval with explicitly selected development cases. Do not expose
reserved final cases to the application-development agent while claiming they
are unseen. A normal selected regression suite needs no holdout machinery.

Use the application's existing test instance or recorded tools when sufficient.
When a task needs novel writes followed by reads, use a reviewed stateful test
environment with real contracts. Test alternate valid writes, exact read-back,
invalid arguments, failure without mutation, isolation, and resume without
duplicating effects. Mark behavior verified, assumed, or unsupported. A valid
new tool action with no recorded result is an environment gap, not a model error.
Never use live production mutations as the test environment.

#### Optional CLI reconstruction and replay

Use this path when reconstruction/replay is requested or a suitable private
migration run exists. Selected ID exports do not import into this path. To
create a run, `migrate` downloads all indexed captures over completed UTC days:

```sh
understudy migrate --org <organization-id> \
  --project <project-id> --workload <workload-id> \
  --from <completed-UTC-date> --to <exclusive-UTC-date> --json
```

Its default is yesterday UTC, which may be empty. Do not widen selected-example
authorization into a whole-day export. Resume with the returned `--resume <run-id>`
and the same scope without new dates. Inspect `capture-evidence.json` for coverage,
`tasks.json` for grouping and turns, and `tool-fixture-plan.json` for available
exchanges. For a large task's detail reference, verify the file, byte count,
digest, and task/request identities against the summary. Reconstruction IDs
are not automatically verified application task IDs.

Create a private self-contained `.cjs` harness exporting an async function. Its
API supplies `taskIds`, `task(taskId)`, bounded `request({id, taskId, protocol,
body})`, recorded `mockTool({id, caseId, taskId, turnId, call})`, and
`appendToolResults(body, protocol, response, results)`. Select explicit tasks,
construct their proper starting requests, inspect dependency/invalid/terminal
results, handle tool calls, append continuations, and stop within finite limits.
Await operations before returning results for separate grading. Preserve the
compatible `messages`, `chat`, or `responses` protocol.

```sh
understudy replay --run <run-id> \
  --harness .understudy/migrations/<run-id>/harness.cjs \
  --model <verified-model-id> --max-calls <limit> \
  --max-output-tokens <limit> --max-tool-calls <limit> \
  --id <new-attempt-id> --json
```

Resolve and authorize the replay execution scope before running this command.
When using a separate test target, supply both `--target-project <test-project>`
and `--target-workload <test-workload>`; confirm the resulting scope in receipts.
The saved source workload remains the eval's identity. Do not assume a `test`
environment label redirects traffic to a separate project or workload.

Model-call and tool-call limits apply to the entire replay journal, not each
case; both accept 1–10000. The output-token limit is per request and accepts
1–32768. Tool calls default to 1000 if omitted. Size limits for the selected
cases and recovery allowance; they do not enforce a dollar spending cap.

Recorded matching uses the task, turn, tool, normalized arguments, and unused
occurrence. Supported invalid arguments can be rejected for model recovery;
successful parallel calls remain consumed. A valid call without a matching
recording stops as an environment gap. Never invent an acknowledgment or silently
switch to simulation. Keep original candidate arguments in evidence.

For stateful simulation, supply a private environment object with `schemaVersion:
1`, a version, state schema/initial state, fixed context, explicit `recordedTools`,
simulated `tools`, and contract `tests`. Each simulated tool declares version,
input/output schemas, failures, and a pure synchronous handler receiving
`{arguments, state, context, operation}`. It returns `{result, state}` or a
declared `{failure, result}` without mutation. No production clients, network,
filesystem, wall clock, or uncontrolled randomness belong in handlers.

Validate it without inference before using it:

```sh
understudy replay --run <run-id> \
  --harness .understudy/migrations/<run-id>/validate.cjs \
  --environment .understudy/migrations/<run-id>/environment.cjs \
  --offline --id <validation-attempt-id> --json
```

The offline harness uses local tool operations, never `request`. Omit model,
inference limits, and target options. Validation inventories all source-declared
tools across the run, not only cases chosen by the harness: each must be declared
recorded or covered by a simulated handler with passing contract tests. Inspect
the validation report and saved preflight evidence. Structural validity does not
prove semantic equivalence or recording coverage.

For the online command, add the same `--environment` file when using simulation.
Use `mockTool` for declared recorded tools and `simulateTool` with task/case/attempt/
turn identity for simulated handlers. Keep state effects and assumptions inspectable.
Changed source, harness, environment, model, target, or limits needs a new replay
ID. The host runs trusted JavaScript; it is not an operating-system sandbox.
Installed `understudy replay --help` exposes the exact API for the CLI version
in use; check it while implementing this adapter.

### 8. Freeze and run the baseline; measure what happened

Apply the [eval checks](check-eval.md) to the built cases, grader, runner, and pilot
records before the full pass. Save `check-eval.md` with checks performed, evidence,
findings, repairs, and unresolved limitations. Fix defects that invalidate the
intended claim, then recheck the affected path. Do not turn a missing check into
evidence that the eval is valid. Confirm that the actual-input and grading
judgments refer to the current versions.

Show the concrete run plan: workload, application/model configuration, selected
case count, repetitions, judge calls, tool isolation, and limits. If the user
asks about cost or supplies a cap, show a pilot-derived estimate including
application, judge, retries, and observed spread. For example, estimated total
is task count × repetitions × measured application cost per task, plus the
planned judging/auditing cost; unknown components remain unknown. Use measured
pilot wall time at the planned concurrency for a runtime estimate. Do not send
an unapproved pilot merely to obtain an estimate. When the plan is already
authorized, proceed; otherwise obtain the missing execution decision. Changing
the scope or increasing a cap needs a new decision, not an assumed allowance.

After the pilot and grader validation, freeze workload identity, case membership, criteria, grader,
runner, environment, and application/model settings. Run the planned suite.
Do not drop hard cases after seeing outcomes. Run reserved final cases only
after development, and do not tune on them while preserving a held-out claim.

Set any repeated-trial plan before looking at results. Distinguish bounded
transport retries within one trial from independent new trials. State which
transport failures may be recovered and how the final trial verdict is chosen;
keep every attempt and its cost. Never retry a completed quality failure until
it passes. Repetitions measure variability on the same tasks, not additional
task coverage. Application changes, model selection, and prompt
hill-climbing are outside this workflow; grader and runner repairs are versioned
measurement work.

All new gateway calls, including judges and continuations, need fresh request
receipts and verified test scope. Replay sets and verifies the test environment;
other runners must set and verify it themselves. The test label shares routing,
capture settings, and billing and does not sandbox tools. Check actual execution:

```sh
understudy requests show <new-request-id> \
  --org <test-organization-id> --project <test-project-id> --workload <test-workload-id> \
  --environment test --json
understudy report cost <new-request-id> --json
```

Verify canonical request identity, returned scope against the authorized test
execution scope, and actual served model. Preserve its mapping to the source
identity in the native workload metadata or private `eval.md` (the bundled path
uses `manifest.workload`). Keep application and judge request membership separate.
A documented model alias can resolve to its snapshot in an application runner;
an unexpected fallback must not be scored under the requested model's name.
The CLI replay contract requires an exact effective-model match and stops on
mismatch; do not override that stop by declaring the result an alias. Historical
capture IDs do not identify baseline calls. Missing receipts are a provenance gap.

Sum attributable calls, continuations, and retries. Keep application inference,
judge cost, historical cost, and estimates separate. Record actual usage,
including cache categories, rather than estimating tokens from string length.
If computing estimated cost, pin the price source/version for the actual model;
do not substitute a current assumed rate for reported historical cost. Unknown
or pending prices stay unknown. Calculated cost is not proof of ledger debit.
If estimating a larger run's spend, use the authorized pilot's measured per-task
cost and spread, plus planned repetitions, judging, and retry allowance.

Record model-call latency, tool time, and total task wall time separately. Keep
retry/backoff and local queueing visible. Summed call durations are not elapsed
task time when operations overlap. Record cache conditions so later comparisons
do not confuse warm-cache effects with model improvements.

### 9. Audit the results and explain their limits

Keep execution status distinct from individual quality checks. With one trial
per case, use these mutually exclusive quality outcomes; with repetitions,
apply them to each planned trial:

| Case outcome | Meaning |
| --- | --- |
| Passed | Every required applicable check has evidence of success |
| Failed | A recorded check establishes a violation of a required supported requirement, even if another check is unavailable |
| Unscored | No supported required failure is established, but the evidence, execution, policy, environment coverage, or human review cannot establish a pass |
| Unrun | No attempt or historical grading was made |

Report execution statuses separately: successful execution/grading, execution
error, environment gap, timeout, grader error, missing output, or pending. An
execution error usually contributes to quality `unscored`; it is not an extra
case to add to those quality counts. The bundled report names unrun quality
`pending`. Sum pass + fail + unscored + pending to the planned attempt count;
sum the execution-status counts independently to that same count. Inspect any
supported criterion failures alongside an execution/grader error rather than
erasing one axis with the other.

Record refusals, invalid formats, truncation, budget exhaustion, and tool failures
explicitly. A completed malformed answer can fail a format requirement; a broken
parser is a runner error. Refusal can be correct or incorrect under the task.
If a faithful application budget is itself a required constraint, exceeding it
can fail that constraint; accidental eval clipping must not masquerade as model
inability. An environment gap alone never establishes a quality failure.

Recompute every headline from saved rows. With one trial per case, the mutually
exclusive counts must sum to the selected tasks. Show passed/all-selected as
confirmed success on that set, decided-case quality with its own denominator,
and execution reliability separately.

For repeated trials, report the outcome counts over all planned trials and the
unique task count separately. Keep each task's mixed trial outcomes visible.
Default to computing each task's confirmed-success fraction as passed trials /
planned trials, then averaging across tasks under the declared sampling weights.
Show unscored/error/unrun fractions beside it. Do not assign a mixed task a pass
because one trial succeeded. Any different reduction, such as requiring every
trial to pass, must be named and fixed before execution. Transport retries do
not add trials or tasks.
Use a confusion matrix and per-class errors for classification, not accuracy
alone. Keep catastrophic violations visible instead of averaging them away.

Inspect concrete passes, failures, borderline judgments, disagreements, and
missing cases. Check for a broken oracle, an unexpectedly strong null baseline,
label leakage, saturated scores, all-zero metrics, or constant cost/timing
values. Verify numbers against raw evidence. Correct measurement defects and
version any rerun instead of silently overwriting results.

For claims beyond the selected regression cases, quantify uncertainty:

- For independent unweighted binary observations, use a binomial interval such
  as Wilson's 95% interval rather than a normal interval that collapses at zero
  or perfect success. Apply it to TPR and TNR with their own class denominators;
  a missing class has no estimate. Reuse a tested native implementation or the
  bundled `wilson95` helper for independent observations. The bundled calibration
  command withholds these intervals when related rows violate independence.
- For clustered tasks or repeated trials, use a seeded bootstrap over independent
  task groups: sample groups with replacement, retain each group's cases and
  trials, and recompute the complete weighted metric for about 2000 draws.
  Report the 2.5th and 97.5th percentiles and the number of independent groups.
  Too few groups or an all-identical sample can make that interval uninformative;
  disclose this instead of claiming certainty about unseen failures. The bundled
  `groupedBootstrap` helper supports unweighted case means and whole-group
  resampling; use a verified extension for weights or stratified designs.
- For later comparisons, use paired outcomes on the same tasks/configuration
  conditions. Compare interval width, baseline headroom, and the smallest
  difference the owner cares about. Say when the eval cannot resolve that
  difference, and explain whether more tasks, repetitions, or better checks help.
- Do not attach a population interpretation to a handpicked failure suite.
  Calibration-set accuracy and application success are separate quantities.

If the user specifically needs judge-corrected population prevalence, a binary
judge can support the estimate `(q + TNR - 1) / (TPR + TNR - 1)`, where `q` is its
observed pass fraction on a representative population sample. Use this only with
independent, applicable calibration for both classes and a denominator safely
away from zero. The binary correction does not account for unresolved judge
abstentions or errors: resolve them or explicitly define and justify a narrower
common eligible population before using it. For its bootstrap, independently resample the human-labeled
calibration groups and the population groups, preserving the relevant sampling
strata. Recompute TPR, TNR, and `q` in every draw, then the corrected estimate.
Report unstable/undefined draws; do not discard them silently. Distribution
shift, a missing class, degenerate intervals, or an
out-of-range estimate needs investigation, not a silently clipped confident
percentage. Ordinary regression suites do not need this correction.

### 10. Deliver a usable eval and its maintenance contract

Store private inputs, outputs, and supporting evidence in the application's
private eval directory. Preserve the existing runner, grader, schemas, report,
and commands when they satisfy the requirements. A native CSV, database export,
or framework report is acceptable; it does not need an adapter, bundled manifest,
or parallel JSON records. Record the artifact paths, stable joins, and exact
native commands in `eval.md`. Use the bundled [file contract](formats.md) only
for the components chosen from that toolkit. Deliver the following evidence:

| Evidence | Required content | Bundled-path location, when used |
| --- | --- | --- |
| Workload contract | Resolved workload identity and lookup evidence, code mapping, task boundary, mode, scope, accepted requirements, native run/regrade commands, limitations | `manifest.json` and `eval.md` |
| Cases and source selection | Inputs, evidence membership, grouping, selection/split, origin, expected-outcome authority | `cases.jsonl` and source manifest |
| Failure definitions and labels | Scoped criteria, evidence, human/agent attribution, confirmed/proposed/deferred/disputed status | Private failure definitions and label records |
| Review and eval-check records | Actual-input and grading decisions, discovery evidence, findings and repair checks | `review/` and `check-eval.md` |
| Runner, graders, optional environment | Existing or new versioned code/configuration and local validation evidence | Private runner/adapter, graders, and optional environment |
| Per-run evidence | All attempts, full interactions/effects, receipts, errors, individual checks, usage/timing/cost evidence | Saved runtime records under `results/<run>/` |
| Readable report | Generated case evidence, outcome/cost/latency accounting, coverage, calibration, applicable uncertainty, and outstanding dependencies | `report.html`, `report.md`, and `summary.json` under `results/<run>/` |
| Additional measurements, when selected | Definitions and evidence, readable results, explicit populations, units, and missing-value coverage | `results/<run>/measurements/<version>/` including definitions, `measurements.jsonl`, and `measurements.md` |

The existing tools may supply these in fewer files or different formats. Verify
the required information rather than checking for these example filenames.
If only the bundled viewer is wanted, convert the records it consumes and retain
the native records as the source of truth. Do not replace a working runner or
grader to obtain that presentation. Label any fields the viewer cannot represent
and expose them in the native report or an accompanying readable supplement.

Show the report in the user's preferred readable form, with full interactions
and artifacts accessible. Verify that the report actually opens and its numbers
match saved rows. It should answer: which workload and tasks were evaluated, what counts as
correct, how the grader was checked, what ran, what failed, what remains unknown,
and how to rerun it. A graph or aggregate score cannot replace that explanation.

Open the deliverable yourself and verify the actual presentation:

1. The header names the correct workload, case count, repetitions, and run kind.
   Historical grading and regrading must not look like fresh application runs.
2. Open a pass, a failure, and an unscored/error case when they exist. Read the
   original input, applicable criteria, full interaction, output, and reasons.
   Tool calls/results must remain intelligible; a missing trace is visibly missing.
3. Open representative input/output artifacts in the chosen private viewer.
   Check at least one long conversation and one large artifact when applicable.
   A rendered transcript is not proof that its referenced files open.
4. Each chosen metric has a readable label, units, direction, numerator or
   aggregation rule, and coverage. A missing value is not zero. Supplementary
   measures and calibration reports are linked or named alongside the baseline,
   rather than disappearing because the bundled page has no matching column.
5. Recompute totals from saved records. Exercise filters and clear them; filtered
   results must not silently change the headline population. If charts are used,
   verify axis labels, rounding, and whether higher or lower is better.
6. If the chosen viewer supports annotations, save a note, reload it, exercise
   its supported export/import, and verify the evidence identity and reviewer
   survive edits. For a plain report, retain versioned notes in a separate private
   review record. Human labels remain distinct from automated grades.
7. Regenerate the report from existing records and confirm that doing so sends
   no model calls and does not change cases, scores, or annotations.

Repair and recheck presentation defects before handover. Give the user the report
path and a concise baseline headline with its denominator and material limits;
call out one or two cases only when they explain a consequential finding. Do not
substitute a raw JSON path or a long chat listing for the readable deliverable.

Make the eval durable within its private application directory: record exact
commands, tool/runtime versions, all required files, and their count/size; test
regeneration without fetching hidden dependencies. Retain raw evidence under
the agreed policy and document how unavailable or expired captures affect a
future rerun. Use the application's approved private backup mechanism if one
exists. Git history and application packages are not storage for these artifacts.

Record when to revisit this workload's eval: new task types, an incident exposing
a missing case, changed instructions/tools, corpus drift, or a changed judge.
Bring the next verified captures back into the same workload's evidence inventory.
Add new failures to development coverage, recheck the failure definitions, and recalibrate
affected graders. Preserve old versions and results; keep final evidence fresh
when it is used for new generalization claims. Record evidence of workload,
application, and measurement problems. Recommendations about workload definitions,
prompts, tools, models, or routes belong to a later workflow. Do not change them,
schedule monitoring, or start optimization merely because the eval has been built.

Medium is complete when the supported scope has reviewed criteria and cases,
validated graders or clearly identified human review, a tested execution path,
an eval-check record with no unresolved defect invalidating the stated claim,
and an inspectable baseline. If a part lacks labels, environment support, or
authorized execution, deliver the usable artifacts and name the incomplete
phase. Do not describe an unrun or provisionally graded suite as a validated eval.
