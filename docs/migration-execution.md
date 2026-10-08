# Replay boundary

The CLI hosts a trusted, agent-authored local harness. It provides scoped model
requests, captured tool matching, call and output-token limits, and a durable
journal. The agent's harness supplies task selection, request construction,
continuation, decomposition, recovery, and success review. There is no fixed
phase planner, cluster policy, experiment workflow, grader, or UI in the CLI.

The replay API accepts `messages`, `chat`, and `responses`. The harness supplies
the selected protocol's request and continuation format. A model's catalog
membership does not establish support for all three endpoints.

The maintained API and usage instructions live in the
[harness guide](replay-harness.md) and
[tool-environment contract](replay-tool-environment.md).
Keep customer-specific logic, fixtures, journals, and any viewer
in the application's Git-ignored `.understudy/migrations/<run-id>/`. Keep these
files out of tracked history and application packages.

Each model operation has a stable id and records its exact request before
inference. The journal records HTTP status, raw response, request id, effective
model, requested and returned request environment, latency, and local digests. Resuming reuses matching recorded operations;
it rejects changed inputs and does not resend requests with unknown outcomes.
A changed harness, model, source, target, request environment, or limit needs a new replay id.

Replay labels every model request `x-understudy-environment: test`, including
continuations, and verifies the response echoes `test`. A missing or different
echo is recorded and stops further model requests, including queued calls or
attempts to resume that journal. The dependency code is
`unverified_request_environment`; its HTTP response remains available for review.
Older journals without an environment binding require a new replay id and remain
unchanged. See the [environment guidance](replay-harness.md#request-environment)
for source provenance, capture settings, and reporting scope.

Tool matching uses task, turn, tool, normalized arguments, and unused occurrence
within an independent case. Supported argument rejections may be supplied back
to the model for recovery; missing recordings and other environment gaps stop
execution and remain separate from model failures.
Rejected calls do not consume recordings. Successful parallel calls do. Optional
reviewed schemas and effective application arguments are recorded alongside the
candidate's original call. No real customer tool is executed by the mock API.

Replay accepts an existing exported `UNDERSTUDY_API_KEY` after verifying access
to the exact OAuth-selected scope; otherwise it uses the stored inference key
from the global user store, never a credential file in the application project.
It does not create credentials or save them in evidence. It verifies model
availability and actual response provenance. Any available catalog model may be
selected; the open-weight label is informational. Catalog membership alone does
not establish support for a particular protocol or setting.

A monetary budget is optional. The agent tracks costs and honors a user-supplied
cap when present. The replay's call and output-token limits remain required to
bound each execution; they do not require a dollar budget.

The host executes trusted local JavaScript and is not an operating-system
sandbox. Use the provided recorded-tool and simulation APIs, without importing
customer-tool clients.
A recorded harness result is agent output, not a CLI-awarded task pass. Review
complete candidate behavior against task facts and retain evidence limitations.
The incumbent is comparison evidence, not an answer key.
