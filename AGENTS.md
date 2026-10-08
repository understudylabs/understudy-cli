# Understudy CLI repository rules

This repository is a fresh implementation with independent history. Treat
these rules as release criteria, not suggestions.

## Repository trust

- Keep this repository on its own new history. Do not graft, merge, or copy
  history from another repository.
- Keep the repository private. The approved review remote is the private
  `understudylabs/understudy-cli` repository. Do not make it public, add another
  remote, publish a package, or make a release without separate approval.
- Treat all tracked and packed content as eventually public. Git history is not
  a secret store.

## Content boundary

Tracked files, commits, fixtures, tests, documentation, generated output, and
package contents must not contain:

- customer-derived prompts, completions, payloads, traces, or metadata;
- customer, organization, project, workload, request, or user identifiers;
- credentials, tokens, cookies, authorization values, or secret-bearing URLs;
- absolute private filesystem paths or references to private repositories; or
- transformed, redacted, hashed, or summarized versions of customer material.

Fixtures must be wholly invented, minimal, and clearly synthetic. Private
credentials and integration records belong outside every inspected repository
in the per-user global `~/.understudy/` directory. On POSIX systems, private
directories must be owner-only and private files must be readable and writable
only by their owner. Application migration runs belong in that application's
Git-ignored `.understudy/`, including traces, fixtures, harnesses, results, and
viewers. Keep them out of history and application packages. This does not permit
customer data in this CLI source checkout: use a separate application workspace.
Environment files, logs, and package archives remain excluded from source evidence.

See `docs/privacy-and-data-boundaries.md` and `docs/security.md` for the full
boundary.

## Reading the previous codebase

Prefer the established CLI's working behavior and reviewed implementation logic
when carrying capabilities forward. Adapt that logic to this repository's module
structure: thin command handlers, services, transport, private storage, and tests.

When carrying a capability forward:

1. State the destination contract in this repository.
2. Reuse reviewed, public-safe implementation logic where practical, keeping
   this repository's architecture and naming and applicable license notices.
3. Add focused, wholly synthetic proof.

Do not copy history, customer-derived values, fixtures, private comments, or
internal-only assumptions. Inspect reused logic for the content boundary above;
do not import whole files or unrelated workflows merely to preserve source shape.

## Working boundary

- Do not send live traffic or use credentials while source ownership, data
  origin, or scope is uncertain.
- Organization-scoped reporting, capture reads, and project, workload, model,
  and key management are in scope. Match the platform's credential contract:
  tenant admin APIs accept OAuth or an organization key; customer APIs that
  require OAuth remain OAuth-only. Explicit workload route changes are thin
  primitives; do not add automatic workflow judgment.
- Workload migration may capture and reconstruct real interactions and host an
  agent-authored private harness. Keep transport, recorded-tool matching, limits,
  and journals deterministic. Workflow, harness adaptations, clusters, reviews,
  and presentation belong to the maintained Markdown skill and private agent code.
  Replay mocks never execute customer tools or change routing.
- Monitoring, Desktop, local model serving, and training job execution remain
  deferred.
- Until automated tracked-and-packed-content checks exist, manual inspection is
  evidence only. Do not claim that `.gitignore` or these documents enforce the
  boundary.
