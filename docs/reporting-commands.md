# Reporting and billing contracts

These commands read factual platform records for the authenticated organization.
Tenant admin reporting and billing accept browser OAuth or the organization key
created by email sign-in. The backend verifies that the credential owns the
organization in the request. OAuth-only customer endpoints remain separate.
They do not diagnose causes, choose models, change routing, or initiate payments.
Skills can combine the results with application context to answer those questions.
All commands support `--json`; additional server fields are omitted unless the
CLI explicitly understands their public contract.

## Organization reports

`report`, `report health`, and unfiltered `report usage/errors/costs` retain their
existing organization summary output. Preset windows are `24h`, `7d`, and `30d`.
Health is a current snapshot and does not take a window.

`report usage`, `report errors`, and `report costs` also accept:

- `--project` (slug or ID) and `--workload` (name or ID in that project).
- `--environment` (a request environment name or `all`). Usage/cost defaults
  to `all`; errors defaults to `production`.
- `--from YYYY-MM-DD --to YYYY-MM-DD`, inclusive UTC dates up to 366 days,
  instead of a preset window.
- `--group-by project|workload|model` and `--granularity minute|hour|day`.
  Minute buckets support at most 24 hours; hour buckets support at most 31 days.
- Usage/cost also accept repeatable `--exclude-project` selectors. Errors does
  not have an exclusion API and rejects that option.

`--project-id`, `--workload-id`, and `--exclude-project-id` are also accepted.
Identifier options use the same authenticated hierarchy checks; conflicting
selector aliases fail. `--org` asserts the active organization and does not
switch credentials or grant access to another organization.

Supplying these filters returns `{organizationId, projectId?, workloadId?,
request, data}`. `request` records the effective selection; `data` preserves
the known platform fields, including UTC bounds, time series, totals and
coverage. Filtered reads use saved context when explicit scope is omitted.
The original unfiltered organization summaries remain organization-wide.
There is no server-side model filter on these aggregate APIs: grouping by
model does not select one model. Use request filters for that selection.

Projects and workloads resolve within the current organization's roster.
The CLI checks response scope and filter echoes. Saved context never grants
access to another organization.

## Focused reads

| Command | Scope and selection |
| --- | --- |
| `report failures` | Filtered request window aggregate, using the same selection as `requests list`, without pagination. No request ID argument. |
| `report workload-status --project …` | Project-wide declared routing and observed traffic; duration up to `24h`. |
| `report providers --project …` | Project-wide public provider health; minutes/hours up to `24h`, default `30m`. |
| `report cost <request-or-correlation-id>` | Exact organization-scoped call cost, with the canonical request ID in the response. |
| `report cost-breakdown --project … [--workload …]` | Per-workload token-category costs, request/priced-request counts and coverage; duration up to `30d`, default `7d`. |
| `report usage-summary --project …` | Project usage with any duration up to `30d` (default `7d`), grouped by any unique combination of `workload,model,day`. |
| `report summary` | Organization usage and estimated cost, default `7d`, grouped by project; accepts the aggregate date/filter options. |

Project-wide status/provider reads ignore a saved workload and reject an explicit
workload filter; their APIs return the whole project's aggregates. Their default
environment is `production`. Cost breakdown defaults to `all` and uses saved
project/workload context. None of these commands runs inference.

Human output names the selected request environment. Empty production status or
provider reports suggest `--environment test` or `--environment all`; this does
not establish that traffic exists in those environments. `requests list` defaults
to `all`, so match the project, environment and time window before comparing its
rows with a report. For synthetic probes labeled `test`, pass `--environment test`
to both commands. JSON output keeps its existing shape.

In workload status, `requests` and `status` cover the requested window. The
separate `recent` block covers the trailing 60 minutes, capped by that window.
An idle recent block can coexist with earlier traffic in the full window; it does
not mean `--window` was ignored.

Project usage-summary calls the dedicated project API. It preserves cache-read
share, error rate, request/token counts and estimated customer cost for each
combined group. It defaults to environment `all`, ignores a saved workload,
and rejects workload filters because that API cannot apply them. A response
at the 5,000-group server limit fails with guidance to narrow the window or
grouping; it is never presented as a complete report. This is distinct from
`report usage`, whose organization API groups by one dimension at a time.

Missing prices remain null. Organization usage/cost reporting does not return
priced-request coverage, so the CLI reports that limitation explicitly instead
of inferring complete billing from a dollar total. Cost breakdown has its own
priced-request coverage. Calculated customer cost is not proof of ledger debit.

## Billing reads

`billing balance` returns the current ledger-backed organization balance,
account status and grant summary. It has no time or resource filters.

`billing summary`, `billing trend`, and `billing usage-by-model` accept a
trailing `--window` (default `30d`, maximum `366d`) or exact
`--from`/`--to` ISO timestamps with `Z` or a numeric UTC offset. Timestamps are
validated and normalized to UTC milliseconds; seconds are optional and up to
nine fractional digits are accepted. Unlike the aggregate
report date options, billing's upper timestamp is **exclusive**.

Billing is organization-wide and ignores project/workload context. These APIs
do not offer project or request-environment filtering. `priced_events` counts
pricing events; it is neither a unique priced-request count nor a ledger-debit
count. Estimated cost and balance are separate evidence.

No top-up, invoice, payment-method, or ledger-item export command is claimed.

## One reporting command group

Use `report` for aggregates and `requests list/show` for individual calls. The
duplicate `reporting` group and `requests failure-context` spelling have been
removed. Existing `report` JSON summaries and scoped wrappers are unchanged.

For older scripts, replace `reporting usage` with `report usage-summary`;
replace other `reporting` prefixes with `report`. The retained commands wrap API
data in their documented scoped result rather than returning the former raw
compatibility JSON. Use `report failures` for filtered failure context.

Also check scope when replacing `reporting cost-breakdown`: the removed command
ignored a saved workload; `report cost-breakdown` uses it. Inspect `context show`
and the returned request scope. For a project-wide read, use a context without a
saved workload (or explicitly clear this application's defaults with `context
clear`, then provide `--project`). Other defaults are described above.
