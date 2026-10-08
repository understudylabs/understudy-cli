---
name: build-evals
description: Build a runnable eval for one Understudy workload. Understand its application responsibility, resolve its organization/project/workload, select captured tasks, and measure their outcomes. Use Low for a quick regression check or Medium for discovery, coverage, grader validation, and a baseline. Includes execution, saved-output grading, review, and reports. Stops before production workload changes, optimization, or rollout.
---

# Build an Understudy eval

A workload is one stable model-backed responsibility in an application, such as
extracting invoice fields or drafting a support reply. Its inputs, tools, and
success criteria share a purpose. It contains many task instances; one instance
can involve several model calls, retries, or loop iterations. Those calls do not
each create a new workload. An agent may contain several workloads when it
performs distinct model-backed responsibilities.

Start with one existing workload and the code that performs that responsibility.
An eval is a selected set of its task instances, a way to run them, and checks
for the required outcomes. Deliver all three, the resolved workload identity,
a working rerun command, and a report showing the evidence behind each result.

Use existing Understudy traces whenever possible. The CLI is named `understudy`.
It provides capture and replay primitives; this skill includes an optional local
runner and report generator. There is no `understudy eval` command. Everything
needed for this workflow is included here; no other eval skill is required.

## Choose the depth

| Mode | Work to do | Result |
| --- | --- | --- |
| **Low** | Select a few important examples, define 1–3 requirements, check the grader, run once | A quick check the developer can understand and rerun |
| **Medium** | Understand the full flow, review actual cases and grading, discover failures, check eval validity, validate execution, run a baseline | A defensible eval with an inspectable case UI or report, validated measurement, and explicit limitations |

Default to Low for a quick experiment. Use Medium when the user wants a more
thorough eval or needs to trust an automated measurement. Mode describes the
effort spent building the eval, not the model's reasoning setting. Both modes
can use the customer's existing eval tools or the bundled runtime. In the bundled
runtime they share a format; changing `mode` alone does not do the extra work.
High and Ultra are not implemented.

Read the shared setup below. For Low, follow the four steps here. For Medium,
follow [the complete Medium workflow](references/medium.md). Low does not inherit
Medium's labeling campaign, calibration partitions, or statistical analysis.
Medium starts by reading [eval checks](references/check-eval.md) and uses them
throughout construction, before the full baseline, and after measurement repairs.
Its practical guides cover [case review and the discovery UI](references/case-review.md),
[product metrics and retrieval evals](references/measurements.md), and
[a worked trace-to-eval example](references/worked-example.md). These are part of
the skill, not optional substitutes for doing the corresponding Medium work.

## Shared setup

Read the application's actual call sites and follow the selected responsibility
through its prompt, tools, parser, and downstream use. A shared SDK client or
output schema does not make unrelated responsibilities one workload. Reuse the
existing workload mapping; record a broad or missing mapping as a scope/setup
gap instead of silently renaming workloads, moving traffic, or changing routes.
If an application task spans several workloads, evaluate the selected one;
keep the other steps as explicit dependencies and out of its reported metrics.

Preserve the application's current model and API for its baseline. Building an
eval does not itself require Chat Completions. If the requested execution target
needs Messages to Chat Completions adaptation, read the installed
`adapt-model-api/SKILL.md` while preparing the runner. If absent, run
`understudy skills install adapt-model-api --harness <harness> --json` for the
current agent and read the returned `entrypoint` using file tools. Automatic
discovery may require a new session; if the host cannot read the file now, save
the eval handoff and resume after starting one before adapting the runner.
Use the existing authorization for routine compatibility work, validate that path
before measuring it, and record its protocol, settings and code separately from
the original baseline. Do not change prompts, tools, grading rules or production
routing to make the adapted run pass. Saved-output grading needs no API conversion.

Resolve that workload in the authenticated organization and selected project:

```sh
understudy status --json
understudy auth whoami --json
understudy context show --json
understudy projects list --json
understudy workloads list --project <project-id> --json
understudy workloads show <workload-id> --project <project-id> --json
```

Select the project and workload that match the inspected code, using the user's
existing scope. Saved context is a local hint, not verified membership. Record
the returned organization ID, project ID and slug, workload ID and name, and
capture settings. The [capture workflow](references/captures.md) explains identity
checks, context reconciliation, and exact request selection. If identity or
attribution is unresolved, continue the local investigation and record the gap;
do not substitute a convenient default or invent identifiers.

Work in the customer's application. Store captures, IDs, cases, annotations,
results, and newly authored private eval code under its ignored, package-excluded
`.understudy/evals/<name>/`. Existing runner, grader, and viewer source can remain
in its established location; record its version and exact commands rather than
moving or duplicating it. Keep captured or derived customer material out of that
source. On POSIX use `0700` directories and `0600` files for private eval artifacts.
Keep credentials in the existing global user store. Customer material, including
redacted or derived material, must never enter a skill installation or CLI source
checkout. Ignore rules do not exclude files from every package format; inspect
the application's packaging and exclude `.understudy/` there too.

Choose the implementation after inspecting the customer's existing evals:

- **Existing eval:** keep its runner, case and result schemas, graders, reports,
  and commands when they meet the task. Apply this skill's workload resolution,
  evidence review, grader checks, and measurement requirements using those tools.
  No bundled adapter, manifest, JSON conversion, or Node runtime is required.
  Record the resolved identity, evidence paths, native commands, and any field
  mapping in private `eval.md`; configure private outputs or exports in the
  directory above without changing their format. Repair only verified gaps.
- **Bundled runtime:** use the included starter when there is no suitable eval,
  or when the developer chooses these tools. The commands and named runtime
  files below describe this path. Adopt an individual helper only if useful;
  conversion is required only for records that helper actually consumes.

Both paths must retain inspectable cases, execution evidence, grading reasons,
workload attribution, and a reproducible baseline with its limits. Native tools
can satisfy those requirements without reproducing the bundled file layout.

For the bundled path, the helpers require Node.js 22 or newer and Git, with no
package install. Resolve `<skill-dir>` to this installed skill's directory. Run
from the application root:

```sh
node <skill-dir>/scripts/eval.mjs init --name important-tasks --mode low
```

Use `--mode medium` for Medium. The initializer creates private starter files.
Fill the required `manifest.workload` with `source: "understudy"`, `organizationId`,
`projectId`, `workloadId`, and `name` from the resolved identity. Save the lookup
evidence under `source/` and the code-to-workload mapping, project slug, source
environment, and verification date in `eval.md`. Empty starter identity is not
runnable. `source: "synthetic"` is for a wholly invented demonstration; synthetic
cases for a real workload still use that workload's Understudy identity.

Use [the command and file contract](references/formats.md) only when adopting
the bundled runner, report, or measurement helpers. An existing framework needs
no adapter merely to follow this skill.

Then identify important task/request IDs and what must remain correct. Reuse
what the user already told you. If needed, ask one useful question:

> Which tasks or request IDs matter most—ordinary work, expensive work, or a past
> failure—and what would make their results unacceptable?

Use a question tool when the host has one, including `AskUserQuestion` in Claude
Code, or ordinary chat otherwise. Batch material questions and continue work
that does not depend on the answer. Do not invent domain policy.

Select captures belonging to this workload before constructing eval cases.
Map application task IDs to gateway request IDs using actual records: one request
is one model call, and a shared trace ID alone does not establish a complete task.
Verify organization/project/workload membership before retaining or exporting bodies;
preserve source bytes, ordering evidence, and missing context. A previous answer
is observed behavior, not ground truth. If the resolved workload has no usable
captures, use application examples or synthetic inputs and label their origin.
Existing local captures with recorded workload identity can be graded offline
without login; preserve when that identity was verified and any current gaps.

Before fresh model calls, resolve inference identity, authorized test scope,
tool isolation, call limits, and any spending cap. On every gateway request,
including continuations and judges, send `x-understudy-environment: test` and
verify the echoed header. Record new `x-understudy-request-id` receipts and the
actual served model. Preserve the source workload in the eval contract and link
it to the new test receipts. Inference headers use the authorized test project's
**slug** and workload **name**, which may differ from the source workload;
management reads use resolved IDs. Keep judge traffic identified in its
authorized scope. Test environment labels do not disable billing or isolate
tool effects. Never use production write tools as an eval environment. The
bundled runner is trusted local code, not a sandbox or an inference budget
enforcer; put limits and receipt checks in the application adapter.

## Low: get a useful check running

### 1. Pick examples and define success

Use the resolved workload's real entry point and selected captures. Start with roughly 5–10 tasks,
fewer if that is what exists. Include ordinary work and a difficult or previously
broken case. Do not expand the set merely to reach a quota.

Fill `eval.md` with the flow, selection, and 1–3 essential requirements. Put
requirements and cases in the existing eval's format; the bundled path uses
`manifest.json` and `cases.jsonl`. Derive expected behavior from facts, the
application contract, or the owner. Show a concrete
proposal for correction; ask only where ambiguity changes a verdict. Mark
unconfirmed rules provisional. A local task ID is a label, not proof of grouping.
Show the actual cases in the user's existing review tool, a Markdown document,
or the bundled local review page. Ask which presentation helps if their
preference is unknown; do not require a custom UI for a small Low eval.

### 2. Check the checks

Reuse or implement a grader using code for exact values, fields, constraints, or
verifiable effects; the bundled path uses `grader.mjs`. Use a saved human rubric
for meaning that needs judgment. A model judge is optional; six human reviews
may be simpler. Pending human
review stays explicitly unscored; the bundled manifest uses `grading: "human"`.
Unchecked automated semantic judgments stay provisional.

For automated checks, prepare a good output, a different acceptable output, and
a plausible wrong output for each essential requirement. Include the trace,
receipt, or state evidence the grader actually uses. Keep the existing framework's
fixture format; the bundled path uses `controls.jsonl` with `output` or a full
`execution` record. The [worked example](references/worked-example.md) includes
a checker that distinguishes identical answers by the actions actually taken.
For human-only criteria, include a control that correctly remains unscored; test the
rubric by reviewing good and bad examples yourself. These are checks of the
grader, not additional application tasks. For a count extractor, valid JSON with
the wrong count must fail; permitted field ordering must not cause failure.

Run the existing framework's grader tests, or the bundled `validate` command
below, on those controls. Include any paid judge calls in the authorized test
scope and spending cap before running them; local graders stay offline.

```sh
node <skill-dir>/scripts/eval.mjs validate --eval .understudy/evals/important-tasks
```

Inspect the control results. Passing controls proves only the distinctions tested.

### 3. Make one bounded pass

Use the existing application runner; for the bundled path wrap its entry point
in `adapter.mjs`. Keep its prompt, tools, protocol, and settings faithful; use
isolated test state. Return output and the
evidence needed for grading. Expected answers are passed to the grader only.
An agent with filesystem tools also needs a separate workspace that cannot read
the eval directory; filtering function arguments is not a filesystem boundary.

Run the existing baseline command, or use this bundled command for an authorized
fresh run:

```sh
node <skill-dir>/scripts/eval.mjs run --eval .understudy/evals/important-tasks --run baseline
```

For saved outputs, use the existing scoring command. With the bundled tools,
put each saved execution in the case's `observed` field:

```sh
node <skill-dir>/scripts/eval.mjs grade --eval .understudy/evals/important-tasks --run historical
```

Historical grading does not execute the application. Missing saved output remains
missing. Judge code can still make model calls: use a code grader or human review
for a fully offline run. Reports are generated from saved records without any
model or grader calls.

### 4. Read the result and stop

Open the existing eval report, or the bundled `results/<run>/report.html` and
printable `report.md`. Show a real pass and a correctly rejected result, with
output and reasons. Keep execution failures,
missing evidence, pending reviews, and unrun cases visible alongside passes and
failures. Show known cost and timing with their coverage; unknown is not zero.
The result describes these selected examples and checks for the named workload.

Leave the exact execution and regrading commands in `eval.md`. To rerun grading
after a checker repair, validate it again and preserve the old run. Use the
existing framework's command, or the bundled equivalent:

```sh
node <skill-dir>/scripts/eval.mjs regrade --eval .understudy/evals/important-tasks --from baseline --run regraded
```

Low is done when the developer can rerun this workload's check, see a meaningful
mistake caught, and understand its limits. Keep newly discovered cases and gaps
with the same workload for the next eval revision. Record evidence of workload or
application problems; recommendations to change them belong to a later workflow.
Do not continue into Medium, model searches, hill-climbing, or rollout without
that scope being requested.

When the user requests a raw comparison on this completed eval, hand off to
`compare-models` with the native commands, frozen cases/checks, scope and known
limitations. It compares candidates and opens a local side-by-side UI while
keeping prompts and tools fixed. Eval construction alone does not start it.

## Try the included example

Use a separate empty scratch application directory with Node.js 22+ and Git.
This invented parcel-price example has a synthetic workload identity and requires
no real Understudy workload, captures, credentials, network, or model calls:

```sh
node <skill-dir>/scripts/eval.mjs init --name parcel-check --mode low --demo
node <skill-dir>/scripts/eval.mjs validate --eval .understudy/evals/parcel-check
node <skill-dir>/scripts/eval.mjs run --eval .understudy/evals/parcel-check --run baseline
```

The synthetic contract charges 4 units up to and including 500 grams, 7 above
500 grams, and 3 more for priority. The deliberately faulty application uses
`< 500`, so two of eight cases should fail. The report should expose the exact
boundary mistake. `--mode medium --demo` uses the same data and machinery; apply
Medium's investigation to demonstrate the deeper process, rather than calling
the example a validated production eval.
