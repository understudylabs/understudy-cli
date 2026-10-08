---
name: rollout-workload
description: Gradually adopt a selected model using an application's existing feature flags, allowlists or cohort controls. Inspect the code, apply an authorized bounded rollout, verify actual serving and report how to restore the incumbent after spot checks.
---

# Roll out a selected model

Use this after a user chooses a model or wants to adopt one after spot checks.
Inspect the application's actual rollout mechanism and use it where available.
Spot checks are observations for a user decision, not a formal evaluation or a
general quality guarantee. Do not create an eval gate, rollout framework or
monitoring service as a prerequisite.

Follow these steps in order. Reuse facts, choices and authorization already
established in the conversation; ask only for missing information that changes
the action. Explain the mechanism and current step in plain language.

## 1. Confirm the selected change

Read the chosen exact model ID, endpoint, parameter settings and relevant
spot-check observations or requested eval-comparison evidence. Reuse saved
native reports and their case/check/configuration versions; do not rebuild an
eval as a rollout prerequisite. Keep failures, fallback responses and unknown outcomes
visible. If the user has not chosen a candidate, use `recommend-models`; if they
want to inspect examples first, use `try-models`. Do not repeat completed
research or spot checks simply to enter this skill.

Before any platform change, use `understudy status` and `understudy auth whoami`
to verify the authenticated organization. Resolve the application's project and
workload and read `understudy workloads show <workload> --project <project>` for
current routing/capture. Reuse earlier verification only when still current;
direct invocation of this skill must not assume preceding skills ran. Stop on
ambiguous ownership or scope. Record the incumbent and candidate configuration,
selected workload, environment and application revision. Preserve prompts, tools
and business logic unless the user also requested those changes. A reasoning setting or other adaptation is
part of the candidate configuration and must be disclosed.

## 2. Find the application's rollout control

Follow the model call through the actual serving process, workers, retries and
tool continuations. Inspect source, public configuration and deployment scripts
for feature flags, account allowlists, deterministic cohorts and model selectors.
Check whether the control is deployed and which tasks share its client/settings.
Do not read secret values to discover this information.

Report the concrete mechanism with its source location, assignment unit, current
setting, candidate setting and activation/restart requirements. Assign the model
once at a stable application unit, such as an account or complete task, and keep
that assignment through retries and tool continuations. Never randomly choose a
model for each call in an agent loop or mutate a shared client for one cohort.

A local run selector or process-wide model variable alone cannot perform a
gradual rollout. If no suitable mechanism exists, say so. Prepare the smallest
off-by-default allowlist or stable cohort seam only when implementing that seam
is within the user's requested scope; otherwise describe the concrete option.
Do not invent a flag service or require an evaluation framework.

Prefer the application's control. A platform percentage route is a separate
mechanism and does not promise sticky task assignment. Use it only when explicitly
chosen and compatible with the application's continuation behavior. Read
`understudy workloads route --help` before preparing that change: supply both
the intended percentage and existing capture setting because command defaults
can change them. Save prior route/capture state; `--clear` restores an absent
route, not an existing one. The CLI cannot reconstruct an existing deployment
route, so do not overwrite one through this path. Capture authorization is
separate; preserve retention unless changing it is explicitly in scope.

## 3. Make the bounded rollout concrete

Prepare the exact diff or configuration change and show:

- the existing control, stable assignment rule and affected workload/environment;
- the chosen allowlist/cohort or percentage, activation lifetime and observation window;
- the old and new model/settings, including in-flight task behavior;
- observable stop conditions from existing application signals and user priorities;
- how to stop new assignments, restore previous settings and verify restoration.

Use an existing requested scope or documented rollout policy. Do not silently
pick 1%, promote all users because examples looked good, or invent acceptable
error/latency thresholds. If scope is genuinely missing, ask one concrete
question, such as “Use the existing internal allowlist, or a customer cohort you
choose?” Complete independent preparation before asking.

Distinguish how long traffic may use the candidate from how long this session
observes it. For a time/task-limited activation, specify what stops assignment
at expiry. Activate only if the existing control enforces that limit or the
authorized restoration can actually be performed before it expires. A note to
check later is not an expiry mechanism. If neither is possible, resolve that gap
before activation; do not quietly leave the candidate enabled beyond scope.
A cohort may remain active after observation only when that continuing scope
is authorized.

Keep the rollout record in the application's ignored `.understudy/` directory,
excluded from history/packages with owner-only permissions. Record the source
of each setting and observation. Never put runtime evidence in the CLI checkout.
Check assignment and restoration using the application's existing checks or a
small synthetic configuration check when needed; do not author a model grader.

## 4. Apply the authorized slice

Apply the prepared change when the user has authorized that action and scope.
Reuse that authorization; do not request the same approval again. A request to
research models or spot-check examples alone does not authorize live promotion.
If deployment is outside the authorized scope, finish the reviewable change and
state exactly what remains unapplied.

Read back effective settings and identify the process/revision actually serving
the cohort. An edited file or successful CI run does not establish activation.
On an uncertain mutation result, inspect current state before retrying. Preserve
capture settings and unrelated routes. Do not automatically expand the cohort.

## 5. Verify serving and observe the agreed window

Reuse application logs, task outcomes and Understudy request metadata. Resolve
the authenticated identity/project/workload and use explicit selectors. Start
with metadata; rollout verification does not require downloading trace payloads.

```text
understudy requests list --project <project> --workload <workload> --environment <environment> --window 1h --all --json
understudy requests show <request-id> --project <project> --workload <workload> --environment <environment> --json
```

Join the application assignment to exact request IDs across all task calls and
attempts. Inspect `requested_model`, `served_model`, `route_taken` and
`fallback_used`, including successful HTTP responses. Another served model is
not candidate success. Report assigned-cohort outcomes separately from actual
serving, retaining fallback, mixed-model, failed and unfinished tasks.

Show observed application effects, errors, latency and available cost with task
counts, time window and coverage. Different cohorts may have different task
mixes. Missing joins, delayed logs, unpriced calls and unknown outcomes stay
visible; they are not zeros or passes. Reference-price estimates, calculated
costs and ledger debits are different evidence. No traffic means unverified.

Observe only the agreed bounded slice. If it cannot complete in this session,
report its state and exact next read, and ensure any activation limit is still
enforced. Do not create an unattended monitor or keep watching indefinitely.
Do not send extra inference merely to populate logs.

## 6. Hold, restore or hand off

When agreed stop conditions fire or activation expires, use the authorized
restoration plan or verify the enforced expiry to stop new candidate assignments.
Enforced expiry may leave exhausted candidate settings stored while new tasks
use the incumbent; report both the stored settings and effective behavior. For
manual restoration, restore saved settings while preserving the task assignments
and quota state needed for continuity. Do not reset a quota just to tidy the
configuration. Respect in-flight task behavior; do not switch a continuing tool
loop mid-task. Read back settings
and verify subsequent serving when evidence is available. Restoring a model
does not undo tool side effects. Keep blocked restoration or pending verification
explicit instead of claiming recovery.

Finish with a short report: what changed, active cohort/process/revision,
observations and gaps, exact rollback procedure, and whether the current slice
is held, restored or awaiting verification. Recommend a concrete next slice only
when useful; apply it only if already authorized. Spot checks and a small rollout
do not establish whole-workload readiness or automatically authorize expansion.
