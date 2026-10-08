# Replay tool-environment contract

This documents the private `--environment` file accepted by
[`understudy replay`](replay-harness.md). Its simulated tools never execute
application actions. Application-led trials use the real application's reviewed
tool and side-effect boundaries instead.

Keep the private tool environment's code,
contracts, initial state, validation results, and evidence in the application's
ignored `.understudy/migrations/<run-id>/` directory. Workload-specific behavior
belongs there, never in the CLI repository or its published package. Review the
handler against the application's actual contract without importing production
tool clients. The host provides deterministic local execution; it does not
verify semantic equivalence with the application or provide an operating-system
sandbox for untrusted code.

## Choose the execution contract

Use strict recorded replay where the captured exchange is sufficient. Matching
remains exact after the existing argument normalization, with captured occurrence
consumption isolated per case. A missing matching recording is an environment
gap; it does not establish that the model supplied incorrect arguments.

Use explicit stateful simulation when the task needs behavior that captured
returns cannot establish, including newly generated write content and later
reads of that content. A reviewed handler receives validated arguments and
case-local state, then returns a validated result and proposed next state. Define
the actual supported behavior rather than a generic success response. Do not
relax recorded matching, silently switch modes after a miss, rewrite the
candidate's original arguments, or use the incumbent's generated write as an
answer key.

Declare each tool's input and output contracts, handler and contract versions,
initial state, and supported behavior. Make any timestamps, identifier seeds,
or other nondeterministic inputs explicit and fixed for the run. Use deterministic
local state transitions; no network, filesystem, process, wall clock, or random
side effects belong in a handler. Keep independent cases and attempts in separate
state scopes, and use stable operation IDs to resume the same attempt.

Export one self-contained CommonJS object from the private environment file:

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1`, the environment file format. |
| `version` | Your explicit environment/contract version; change it when behavior changes. |
| `stateSchema`, `initialState` | Supported JSON Schema and its validated initial state, cloned for each task/case/attempt. |
| `context` | Explicit reproducible inputs such as a fixed timestamp or identifier seed. |
| `recordedTools` | Optional array of unique source-declared tool names that remain in strict recorded replay. A name cannot also appear in `tools`. |
| `tools` | Object keyed by tool name. Each declaration has `version`, `inputSchema`, `outputSchema`, `failures`, and `handler`. |
| `tests` | Contract tests with stable `id` and ordered `steps`. Each step declares `tool`, `arguments`, optional `context` and `operation`, and an `expect` object. |

Each synchronous pure handler receives `{arguments, state, context, operation}`.
Return `{result, state}` for success or `{failure: "declared_code", result}` for
an application failure that leaves state unchanged. Declare each deliberate
failure code and its result schema in the tool's `failures` object. Test assertions
use `expect.result`, `expect.state`, `expect.failure`, or `expect.rejection` as
applicable. The host validates input, output, state, and serialization; it runs
handlers in a fresh bounded context without ambient time, randomness, or I/O.
Do not rely on module globals to persist state. Keep dependencies in the private
file so its digest binds the reviewed implementation.

At replay, `operation` contains `id`, `taskId`, `turnId`, `caseId`, and `attemptId`.
The per-call `context` overrides the environment's default context at the top
level; keep both explicit and stable. A contract-test step uses its supplied
context and operation, or the environment context and a generated stable step
ID when omitted. Supply matching context/operation fields in tests when the
handler relies on them. Schemas must be self-contained, synchronous, and accepted
by the host's strict schema validation; unsupported keywords or unresolved
references are environment gaps, not ignored constraints.

For a mixed environment, list recorded-only tools in `recordedTools` and call
them with `mockTool`. Define stateful handlers in `tools` and call them with
`simulateTool`. Recorded-only tools do not need dummy simulation handlers or
simulation contract tests. With an environment supplied, `mockTool` accepts only
the `recordedTools` subset, and `simulateTool` refuses recorded-only tools. A mode
mismatch is an environment gap, never an automatic fallback. The validation
report marks recorded-only tools `mode: "recorded"`
and `status: "assumed"`, with coverage bound to exact captured returns. A recorded
declaration does not claim that every possible call has a recorded result.

Classify declared behavior and its evidence explicitly:

- **Verified:** reviewed behavior with passing contract tests that cover the
  claimed cases. A test proves its asserted behavior, not every possible input.
- **Assumed:** modeled behavior whose equivalence to the real application still
  needs evidence. Record the assumption and the affected task checks.
- **Unsupported:** missing handlers, schema features, or behavior that the
  environment cannot represent. Keep affected cases visible as gaps.

Captured examples are useful evidence for particular exchanges; they do not
establish the full application contract. Review reads, writes, duplicate
operations, validation, deliberate application failures, and resulting state
individually. A partially verified tool may still have assumed or unsupported
branches; record those limits in private coverage notes.

## Offline validation

Run the existing replay command with `--environment` and `--offline` before any
model request, using the [offline invocation](replay-harness.md) and a private harness
that exercises the selected cases without calling `request`. Check
the declared tool inventory against what the selected tasks may need, supported
schemas, versions, initial state, explicit reproducibility inputs, and contract
tests. Validation runs automatically before the harness and saves its report in
the replay evidence, exposed through the receipt and `api.environment`. All
source-declared tools across the captured run must be explicitly recorded or
covered by a simulation handler with passing contract tests. The explicitly recorded subset may remain
assumed without invalidating structural validation. Inspect the report; resolve
failed tests before inference, and preserve remaining assumed or unsupported
behavioral coverage in run notes.

The inventory inspects source tasks across the run without retaining their
request bodies in the replay cache. This does not narrow the coverage requirement
to cases later selected by the harness.

New environment attempts atomically save `preflight.json` before reporting a
validation failure. It pins the attempt identity, exact harness and environment
source bytes as base64, the validation report, and its digest. The receipt's
`preflightArtifact` points to this evidence or is `null` when none applies.
Inspect or retry an unchanged failed attempt with the same replay ID. Changes
to the environment, harness, source evidence, execution mode, model, limits, or
target require a new ID, including changes made to fix validation. Historical
validation reports without a bound identity are rejected and preserved; do not
overwrite them or silently assign them new conditions.

Simulation also checks the selected captured turn's declaration at runtime. A
handler definition alone does not authorize a tool absent from that turn. Keep
the source task and turn references accurate and treat missing declarations as
environment gaps.

A valid report establishes only that the declared environment is structurally
supported and its simulation assertions pass reproducibly. It does not establish
every possible tool behavior, semantic correctness, or complete recording
coverage. An unsupported call or a call without a matching recorded return is
still a runtime environment gap.

Contract tests must exercise behavior, not only receipt shape. For a private
write/read pair, test two differently worded valid writes, reading the exact
stored value, invalid arguments, declared write failures that preserve state,
independent cases, stable operation ordering, and resume without a duplicate
effect. Successful storage proves the simulated state transition, not that the
stored content satisfies the application's task.

Revalidate after changing a contract, handler, initial state, source evidence, or
relevant settings. Use a new replay ID for changed test conditions. Offline
validation proves the tested local environment; it does not establish model
quality, production tool correctness, or authorization for live tool execution.

## Separate gaps from tool failures

Missing recordings, missing handlers, unsupported schemas, and invalid simulator
results are environment gaps. Preserve their diagnostics and the original call;
stop or mark the affected case unresolved. Do not append an environment gap as
though it were an application response telling the model to repair a valid call.
An independent supported task violation may still establish a model failure;
the gap itself does not.

Arguments that violate a supported tool contract are tool rejections. Give the
journaled rejection to the model when the application allows recovery. Deliberate
application failures must be declared by the environment, tested, and recorded
as such. Neither a rejected input nor a failed write may silently change state.
Inspect the response envelope and stream-decoding evidence before treating a
failure as model-generated invalid arguments.

## Review effects and resume evidence

Keep the original candidate arguments, source and environment identity, handler
and contract versions, and state before and after each operation inspectable.
Recorded returns and simulated receipts are different kinds of evidence. A
simulated receipt establishes only a transition in the test environment; never
claim it proves that an email was sent, a file was written, or any other action
occurred in production.

Await operations and let the host commit their state and evidence before using
a successful result. Resume an unchanged attempt with its existing journal and
stable IDs; it must reuse completed operations rather than repeat effects. A
pending model request has an unknown inference outcome and must not be
automatically resent. Inspect interrupted runs rather than weakening integrity
checks, editing old journals, or treating old recorded results as simulations.

## Synthetic write, read, interrupt, and resume

An independently invented note-storage environment can declare `save_note` with
a text argument and `read_note` with a note index. `save_note` appends the supplied
text to a state array and returns the stored index; `read_note` reads that exact
array entry. Use fixed inputs such as “Pack a blue notebook.” and “Bring the blue
notebook along.” in separate cases. Both writes are valid; the environment
stores what it receives without matching the incumbent's text. Read-back proves
which content was stored; it does not establish that the content was correct.

In the offline harness, save under a stable operation ID and read the stored
index under another ID. Interrupt after the successful save is committed, then
resume the unchanged replay ID and harness. Reaching the same save operation
reuses its receipt and state transition; the read returns the same text and the
array contains one write. Run the differently worded case with a separate
`caseId` or `attemptId`. Change the text under an already committed operation ID
to verify that resume rejects the incompatible input rather than applying a
second write. Also store different content to confirm that the handler stores
the supplied value rather than substituting an expected answer.

Retain the environment version, validation evidence, per-case state changes,
and remaining gaps with the run. Simulated effects and a completed replay do
not establish application task success.
