# Requests and captures

These commands expose customer APIs within the authenticated organization.
`--org` asserts that identity; it cannot select another organization. Optional
`--project` and `--workload` selectors use the application's saved context and
are resolved against the current organization's project/workload hierarchy.
Remote reads support browser OAuth and tenant organization keys, including keys
from email sign-in, through the authenticated organization's admin API. The
server determines read and payload permissions. The CLI never falls back to an
operator API. Request IDs identify individual gateway calls; optional trace
metadata does not establish application task boundaries.

## Request metadata

| Command | Contract |
| --- | --- |
| `requests list` | One page of a filtered, frozen request snapshot; `--all` reads every page. |
| `requests show <id>` | Exact UUIDv7 request lookup, customer cost, coverage, and payload capability. |
| `report failures` | Failure counts and dimensions over a filtered time window. |

Request listing, failure context, and snapshot capture export support
`--environment`, `--window`, `--outcome`, `--status-code`, `--error-reason`,
`--provider`, `--requested-model`, `--served-model`, `--route`, `--capture-state`,
and `--include-rejection-details`. The customer provider filter accepts
`managed`. Capture state means `disabled`, `expected`, or `unknown` when the
request was recorded; it is not a payload availability verdict.

The default environment is `all`; the default window is `1h`. Supported windows
are `10m`, `1h`, `6h`, `24h`, and `7d`. To repeat an exact snapshot, supply all
three anchors: `--window-start`, `--window-end`, and `--snapshot-watermark`.
Each is an exact UTC instant with milliseconds, and the start/end duration must
equal `--window`. Arbitrary date ranges are not supported by this API.

Paginated commands accept `--limit` from 1 to 100, `--cursor`, and `--all`.
Keep filters unchanged with a cursor. An all-pages traversal starts without a
cursor, retains the first page's snapshot, continues empty pages, and rejects
repeated cursors, duplicate requests, or changed scope. Output retains coverage
and traversal status. Failure context is an aggregate and has no pagination;
it does not accept a request ID or establish a cause for a failure.

## Captured bodies

| Command | Contract |
| --- | --- |
| `captures list --project <selector>` | Stored-object listing; optional workload, pagination, and workload environment filter. |
| `captures get <id> --project <selector>` | Metadata summary of one capture; any UUID version, optional workload assertion and private `--output`/`--out`. |
| `captures export --project <selector>` | All metadata pages in a filtered request snapshot, then available scoped capture summaries. |
| `captures export <id>` / `--request-ids-file <path>` | Explicit request selection; the ID file contains one UUID per line. |
| `captures export --date <YYYY-MM-DD>` / `--last 1d` | Indexed workload export with a completed UTC day or frozen rolling day; requires project/workload and full payload opt-in. |

Ordinary stored-object listing has no request-model/status filters and is not an
atomic snapshot. The workload endpoint defaults to `production`; use
`--environment all` explicitly to include every environment. Project-only
listing defaults to all and cannot filter environment. Default page size is 25;
empty pages with a continuation are scanned by `--all`. Both omitted and null
terminal cursors are accepted, but a truncated page must have a continuation.

`captures list --from <timestamp> --to <timestamp>` performs indexed timestamp
search for a selected workload. Bounds are timezone-qualified instants with at
most millisecond precision, the end is exclusive, and the interval is at most
24 hours and cannot extend into the future. The command freezes a containing
24-hour index window and its ingestion cutoff, then selects matching timestamps.
It exposes metadata without signed URLs. This production-only indexed selection
is separate from request-log filters; pagination and request-log filters cannot
be combined with it. `captures export` does not accept these timestamp flags.

Indexed workload-day export cannot be combined with explicit request IDs or
request-log filters. It has a distinct coverage and resume contract from a
filtered request snapshot. A retained `trace_id` may be absent or span multiple
application operations; it is not used to select or group examples.

Capture reads and explicit/snapshot exports return or save summaries by default:
request identity, public model metadata, tag names/count, and body-presence flags.
Full customer-visible bodies require **both** `--include-payload --yes`. Indexed
workload-day exports require those flags because their contract is raw object
materialization. Summaries still require capture GET permission and body
availability; the CLI fetches the envelope to produce the summary.

Downloads default to the application's ignored `.understudy/downloads/<id>/`
directory with owner-only files and directories. `--download-id` chooses a stable
ID; `--out` chooses a private directory inside that application's `.understudy/`.
Explicit and snapshot batch exports consistently use directories, including a
single request ID. Use `captures get <id> --out <file>` for a single output file.
ID-list inputs also belong inside private `.understudy/` state. Blank lines and
`#` comments are ignored and duplicate IDs are removed.

The manifest freezes service origin, authenticated organization, selectors,
metadata snapshot, request membership and payload mode. Repeating the same
command and directory resumes that selection without refreshing the feed.
Every reused body or summary must match its recorded size and SHA-256.
`--no-resume` re-downloads the same frozen request selection; it does not select
new requests. Changed scope, origin, inputs or payload mode require a new
output directory. Indexed day exports always resume their saved window; start
another directory for a fresh rolling day. Metadata and indexed output formats
cannot share a directory, and a common private lock prevents concurrent writers.

`--concurrency` accepts 1–16, default 4; `--retries` accepts 0–5, default 2.
Explicit/snapshot downloads admit at most eight bodies simultaneously to keep
their 16 MiB-per-response reservations within 128 MiB. Transient network failures
and HTTP 408/425/429/5xx responses are retried with exponential backoff; HTTP 501
is a capability error and is not retried. HTTP 404/410 records a payload gap.
Exhausted transient errors remain failed entries that resume retries. Authorization,
malformed responses and scope mismatches stop the operation after active workers
settle and preserve an interrupted manifest. Checkpoints are batched every 100
completed lookups or one second, plus initial/final/interrupted state. A hard
process interruption can require downloading files completed since the previous
checkpoint again.

Request and indexed metadata selections fail above 100,000 members or
64 MiB of metadata; no truncation or sampling is substituted. Response pages
are bounded at 4 MiB. Customer capture JSON is bounded at 16 MiB per response.
Indexed raw objects retain the migration exporter's separate 64 MiB object limit
and 128 MiB aggregate byte reservations. Selection metadata is retained in memory
within those explicit bounds; JSON parsing also requires working memory.

Customer request/response strings are preserved when full bodies are selected.
Known public metadata is retained and unexpected supplier diagnostics are omitted
from customer API captures. Their hashes identify the saved customer-visible
JSON bytes, not the original storage objects. Indexed raw exports preserve their
original downloaded bytes and have a separate scope/size/hash-verified index.
Complete request metadata traversal does not prove payload retention or coverage
of the whole workload.

## Local evidence and coverage

A finished full-payload download covering exactly one workload with available captures also
writes `import-index.jsonl`. Keep
its manifest alongside it so excluded requests, payload gaps, and snapshot bounds
remain reviewable. A download spanning multiple workloads does not produce
this index. It records source files for local analysis, not verified task IDs.
The `traces` command family and `requests trace` have been removed. Use scoped
request IDs and captures; automatic task linking is not part of this workflow.

Indexed timestamp search and workload-day export call the configured server's
indexed capture API. If that server returns HTTP 501, the CLI reports the actual
capability error and preserves any saved run; it does not substitute a request
snapshot. Source-checkout readiness is not proof of deployed availability.
Filtered capture export is a separate selection contract and does not establish
full indexed coverage.
The recommendation and spot-check skills inspect the selected captures and
application context. Advanced existing migration/replay commands are described
separately in [migration commands](migration-commands.md); they are not required
for request lookup or ordinary model spot checks.
