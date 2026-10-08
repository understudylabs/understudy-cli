# Replay harness API

This is the mechanical contract for `understudy replay`. Create or resume its
capture run with `understudy migrate`; see `understudy migrate --help` for options. Ordinary
application-led model trials use the application's existing runner and tools.

Write a self-contained `.cjs` file in the application's
`.understudy/migrations/<run-id>/` directory. Assign an async function to `module.exports`, receiving the API below. Choose tasks, construct requests, process
responses, loop, recover, and decide when to stop in this function. Import no
customer application tool clients. Choose strict recorded replay or explicit
stateful simulation through a [validated private tool environment](replay-tool-environment.md).
The CLI supplies no ambient `require`, `fetch`, or `process`; use the provided
API. It executes trusted code in a separate JavaScript context, not an operating-
system sandbox.
Keep dependencies in the file so its recorded digest describes the harness.

Each `request(...)` selects `protocol: "messages"`, `"chat"`, or `"responses"`
for the corresponding Understudy endpoint. Supply a body and continuations in
that protocol's format, and verify the model supports the selected endpoint and
settings. Preserve original captures when constructing derived requests; do not
forward a captured body unchanged to a different protocol.

To validate an environment and exercise local tool operations without inference:

```sh
understudy replay --run <run-id> --harness <private-contract-harness.cjs> \
  --environment <private-environment.cjs> --offline --id <validation-id> --json
```

Offline replay does not initialize inference or authentication. Omit `--model`,
`--max-calls`, `--max-output-tokens`, and comparison target options;
`request(...)` is unavailable in this
mode. Use deterministic local tool operations and checks. The environment's
declarations, schemas, coverage, reproducibility, and contract tests are validated
before either an offline harness or a candidate harness runs. Inspect the saved
report, following the [tool-environment guide](replay-tool-environment.md).

Tool operations have a separate journal-wide limit: `--max-tool-calls <count>`
accepts 1 through 10,000 and defaults to 1,000 for new journals. It counts recorded
and simulated tool operations, including rejected calls and environment gaps.
Reusing a committed operation on resume does not consume another operation.

To run a harness with model requests:

```sh
understudy replay --run <run-id> --harness <private-harness.cjs> \
  --environment <private-environment.cjs> \
  --model <verified-model-id> --max-calls <limit> --max-output-tokens <limit> --json
```

Omit `--environment` when a harness uses only strict recorded replay. Supplying
an environment enables the separate `simulateTool` API; it never changes
`mockTool` into a simulator. A mixed environment names its recorded-only tools
in `recordedTools` and defines other handlers in `tools`; the same name cannot
appear in both. Use `mockTool` for the recorded subset and `simulateTool` for
the defined handlers. The host enforces this split: either API used for the
wrong mode records an environment gap and stops, rather than switching modes.
Recorded coverage remains assumed and limited to exact
captured returns, even when overall structural validation succeeds.

Optional `--target-project` and `--target-workload` select the existing authorized
scope for comparison traffic. `--id <replay-id>` resumes the same journal without
resending recorded requests. Changing the harness, source evidence, candidate
model, request or tool limits, target, request environment, or tool-environment
contract needs a new replay id. Never resume to conceal a changed test.

## Request environment

The CLI sends `x-understudy-environment: test` on every model request, including
continuations, across the replay protocols. Use the existing authorized project
and workload; no environment registration or extra test workload is needed.
The environment separates reporting and production dataset selection. It shares
the workload's routing, capture settings, and normal billing. Verify the actual
model in receipts; the label does not override workload routing or enable capture.
If capture needs changing, use the existing workload commands only within the
user's explicit authorization for that setting and data retention.

Establish source provenance and authorization to replay and retain the captured
data before live testing. For imported exports, verify trusted export provenance
or confirmation from the authorized data owner and resolve the source scope live.
Imported labels and local integrity hashes alone do not establish ownership or
permission. Keep this evidence in private run notes; do not send live requests
while the origin or authorization remains unverified.

The journal identity and model inputs record the requested `requestEnvironment`;
model outputs and receipts record the echoed value. The CLI requires `test` and
stops if the response label is missing or different, retaining the HTTP evidence.
Inspect that evidence and report the environment discrepancy as an unresolved
execution dependency. Do not count it as a model-quality failure or retry around
it. Old journals without an environment binding require a new replay id; preserve
their results and original conditions rather than relabeling them as test traffic.

Production workload exports default to production data. Preserve the source
environment in the evidence. Additional gateway calls outside the replay API
must set and verify their own environment; a shared trace ID does not propagate it.

## Harness API

The API contains:

| Member | Contract |
| --- | --- |
| `model` | The selected candidate model id, or `null` in offline mode. |
| `environment` | `{version, digest, context, validation}` for the supplied environment, otherwise `null`. `validation` is its saved report. Inspect coverage before interpreting a case result. |
| `taskIds` | All reconstructed task ids; choose explicit real tasks. |
| `await task(taskId)` | Returns `{task, requests}` with verified captured details. Each request has `turnId`, `body`, and `protocol`. |
| `await request({id, taskId, protocol, body})` | Makes one bounded, journaled model request. The API accepts `messages`, `chat`, or `responses`. Returns the normalized `response`, `calls`, `text`, `terminal`, `invalid`, `dependency`, and a receipt with the exact raw response and provenance. |
| `await mockTool({id, caseId, taskId, turnId, call})` | Matches a candidate `{id, name, arguments}` to an unused recorded exchange. Returns `{id, result, isError, fixtureKey}`. This method never invokes the real tool. |
| `await simulateTool({id, caseId, attemptId, taskId, turnId, call, context?})` | Runs the named reviewed environment handler against case-local state. The tool must also be declared at the selected captured turn. Keeps the original `{id, name, arguments}` and explicit context in evidence. Returns `{id, result, isError, provenance: "simulated", productionAction: false, receipt}` for success, supported argument rejection, or a declared application failure; an environment gap is journaled and stops execution instead of becoming a tool reply. |
| `appendToolResults(body, protocol, response, results)` | Builds a standard continuation containing the candidate response and supplied results. The harness may construct a different reviewed history when required. |

Operation `id` values are unique within a replay, stable on resume, and use
letters, digits, dots, underscores, or hyphens. `caseId` distinguishes independent
task attempts so each has its own fixture consumption. Repeated calls within a
case consume distinct captured occurrences. Await all operations before returning.
The return value is JSON-serializable agent output, never a CLI-awarded pass.

Simulated state is isolated by `taskId`, `caseId`, and `attemptId`. Reuse all three
and each operation's stable `id` only to resume the same attempt; use a new
attempt for a deliberate retry. Invocation order determines execution order,
including calls queued before an earlier operation has finished. The handler
receives owned arguments and state, so later mutation cannot alter the operation
or its evidence. Inspect simulated state before and after alongside handler,
contract, and environment versions when reviewing effects.

Tool matching uses task, captured turn, tool name, normalized arguments, and unused
occurrence. Inputs that violate a supported schema produce tool rejections the
model may recover from. Without an environment, calling a tool that is neither
declared nor observed at the selected captured step is an `unexpected_tool_call`
rejection. Missing
recordings for valid declared calls, missing source contracts, and unsupported
schemas are environment gaps; preserve their evidence and stop or mark the case
unresolved rather than asking the model to correct valid arguments. A rejected
call does not advance the harness's fixture step; a successful parallel call
remains consumed while the other calls recover. Do not include the original
expected arguments in an error message.

If captured declarations differ from the verified application contract,
`mockTool` accepts an explicit `schema`. For application-supplied context it also
accepts `effectiveArguments`; keep `call.arguments` exactly as the candidate
produced them. Both forms are journaled. Explain the source and rationale for
these adaptations in the private review. They must implement real application
behavior, not force an incorrect candidate call to match a fixture. New or
rephrased writes with no matching captured receipt remain gaps in strict recorded
replay. Use a separately declared and validated stateful handler when the task
requires simulated writes and consistent later reads. Never automatically switch
to simulation on a miss or fabricate an acknowledgment. A handler's declared
contract, coverage, tests, and effects must remain inspectable in the private run.

Model requests preserve the harness's ordinary body fields, including reasoning
settings. The CLI enforces the selected model, streaming, and output-token limit.
It does not assert unsupported settings are accepted by the server. Inspect
`invalid`, `dependency`, HTTP evidence, and the final task result when interpreting
the run.

The output identifies `replays/<replay-id>/journal.json` and its frozen
`harness.cjs`. The journal stores exact model inputs, responses, tool inputs,
matched results, and local digests. An interrupted network request stays pending
and is not automatically resent. A stopped replay needs inspection, even if the
process returned structured output. Preserve the journal and its harness with
the run notes; changed execution conditions require a new replay id.

The replay receipt also exposes `preflightArtifact`, a path or `null`. A new
environment attempt saves `preflight.json` with its bound identity, raw harness
and environment source bytes encoded as base64, and the validation report before
returning a validation failure or starting the harness. A failed validation may
have preflight evidence without a journal; preserve that evidence and follow
the [validation-resume rules](replay-tool-environment.md#offline-validation).

New journals use version 2's explicit execution semantics. Existing version 1
journals resume under their original recorded-replay behavior and cannot opt into
simulation, offline mode, or an explicit tool-call limit. Preserve earlier results
and diagnostics under their original conditions; use a new replay ID to adopt
the new semantics. Damaged
journals are rejected, never silently repaired or reinterpreted.

Request bodies and tool-operation inputs are owned snapshots taken at API
invocation, before queued execution. The transmitted body, saved input, and
digest describe that snapshot; later conversation or nested argument mutation
must not change it. Returned values are isolated from saved evidence. Let the
host persist state and evidence before treating a simulated operation as
successful. Stable IDs reuse committed operations on an unchanged resume; do
not edit a journal or weaken integrity checks to recover a damaged historical run.
