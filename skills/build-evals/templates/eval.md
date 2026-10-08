# Workload eval

This starter belongs to the optional bundled runtime. Existing evals can retain
their own records and commands while documenting equivalent workload evidence.

Replace this document with the resolved workload, task contract, and evidence
for this eval. Empty starter identity is deliberately not runnable.

1. Describe one stable application responsibility, its real call sites, inputs,
   tools, expected outcomes, and start/finish boundary. Record other workloads
   as dependencies, outside this workload's selected cases and metrics.
2. Resolve the authenticated organization, selected project, and existing
   workload with CLI identity/context and workload reads. Fill `manifest.workload`
   with `source: "understudy"`, `organizationId`, `projectId`, `workloadId`, and
   `name`. Record project slug, source environment, verification date, and private
   lookup evidence paths here. Note capture settings and any mapping/setup gaps.
3. Choose important application tasks and verify their request IDs belong to
   that workload before retaining or exporting capture bodies. Save membership,
   ordering evidence, and source selection. Add private cases to `cases.jsonl`, keeping related
   cases in one split; label missing evidence and synthetic inputs explicitly.
4. Record the requirements, expected-outcome authority, and unresolved domain
   judgments. Connect `adapter.mjs` to the existing entry point and isolated tools.
5. Implement the criteria in `grader.mjs`. Add acceptable, alternative, and
   meaningfully wrong outputs to `controls.jsonl`; use a full `execution` object
   when the grader needs traces, metrics, or receipts. Count any paid control-judge
   calls in the authorized test scope and spending cap before validation.
6. Declare imported app code and data dependencies in `fingerprintFiles`; paths
   resolve relative to this eval directory and remain inside the application.
7. Validate, run a bounded baseline, and inspect outputs and reasons. Record
   exact toolkit/run/regrade commands, workload identity, results, and limits here.
8. Record new cases to add in the next eval revision and evidence of workload or
   application problems. Recommendations to change the workload and application
   belong to a later workflow.

The adapter receives only case ID, title, and input. It does not receive expected answers or the rubric. This process boundary is not an operating-system security sandbox: keep answer keys outside the evaluated agent's accessible environment.

All files here are private application state. Keep this directory out of Git history and application packages. Existing outputs may be graded offline. A small selected suite does not establish population accuracy or authorize deployment.

## Medium review and measurement record

Complete these entries when building Medium; a Low check does not need this
additional campaign. Record actual evidence, not a checkmark for planned work.

- Input review: version, full inventory path, cases actually inspected, owner
  corrections/decision, omitted categories, and untouched final groups if used.
- Presentation: user's preferred viewer, case layout, artifact access, annotation
  export/import, and tested save/reload/correction behavior.
- Failure discovery: taxonomy version, confirmed and proposed definitions,
  search coverage, reviewed batches, unresolved disagreements, and stopping reason.
- Grading review: included/excluded criteria, example outputs and verdicts shown,
  owner corrections/decision, controls, judge model/settings, and rubric version.
- Calibration: label authority, grouped partitions, actual judge predictions,
  class-specific counts, grading coverage, uncertainty, and unvalidated criteria.
- Product metrics: selected fields, units/direction, hard requirements versus
  descriptive measures, supplementary record/report paths, and missing values.
- Eval checks: `check-eval.md`, checks performed, findings with evidence, repairs,
  rerun/regrade validation, and unresolved limitations on the intended claim.
- Execution: pilot evidence, case/repetition/call plan, source and test workload
  identities, accepted limits, frozen versions, full-run results, and receipts.
- Delivery: opened report/artifact examples, reconciled denominators, exact
  regeneration/rerun commands, retention policy, and next review triggers.
