# Retain request IDs with application records

Use this procedure when onboarding an application's inference wrapper. Inspect
its installed SDK and existing durable records first; do not add a second logging
system or require a database migration merely to retain correlation metadata.
Follow the main skill's explicit Yes / No / Do it later choice before adding
durable storage. For No or Do it later, preserve existing logging and record the
limitation or deferred work. A transient response header can still verify an
approved probe without establishing durable application-record correlation.

## Follow the response lifecycle

1. Find the app's existing job, record or conversation identifier and the
   per-call/attempt record associated with it. Reuse its persistence, retention
   and access controls. A shared mutable "last request ID" is unsafe for parallel
   calls; keep association local to the invocation and preserve multiple attempts.
2. Locate the installed SDK's supported raw response, error-header, middleware
   or transport hook. Explicitly read `x-understudy-request-id`. The gateway
   assigns it per incoming HTTP request; provider body `id`, `x-request-id` and
   an SDK's `_request_id` are separate identities. Preserve provider IDs needed
   for protocol continuation under their existing fields.
3. Record the header with the app's correlation IDs as soon as headers are
   available, for both successful and unsuccessful HTTP responses. If an SDK
   throws on HTTP errors, inspect its error headers or underlying supported
   transport hook rather than only the parsed success result. Keep existing
   outcome/status and attempt fields; an illustrative new field is
   `understudy_request_id`, not a replacement for the app's primary key.
4. For streaming, retain the ID before handing the body to its normal consumer.
   Keep it when that consumer later fails or cancels, and let existing outcome
   handling record the failure. Do not drain, buffer, clone or convert the stream
   to obtain an ID, or mark the task successful merely because headers arrived.
5. Cover SDK retries, app retries, tool-loop continuations and fallback clients
   within the selected scope. Each new gateway HTTP attempt can return another
   ID. A final-result hook may hide earlier retries; use a supported per-attempt
   hook where available and report any remaining visibility gap. Preserve retry
   policy and errors rather than reimplementing them for correlation.

No response or no header means the Understudy ID is unavailable. Preserve the
app's attempt/error record with its existing null/absent convention; do not
substitute another identifier, fabricate an ID, or send another inference request
just to obtain one. Metadata persistence must follow the application's existing
failure handling without masking an inference error or replaying tool effects.
Keep prompts, outputs, credentials and bulk headers out of this change.

## Check the integration offline

Use the application's existing test framework with wholly synthetic app IDs and
response headers. Exercise the supported paths:

- Success persists the exact Understudy header beside the right app ID, even
  when provider body `id` and SDK `_request_id` contain different values.
- An HTTP error persists the header and preserves the original error behavior.
- A stream persists its header before consumption and retains it after a later
  failure/cancellation, without changing the consumer's output or lifecycle.
- Retries and concurrent calls retain their own IDs against the correct app
  records; the final attempt does not overwrite prior attempts.
- Missing headers/network failures remain unavailable and do not trigger extra
  inference or borrow a provider ID.

Verify the actual persistence boundary, not only an in-memory getter. Keep any
real correlation records in the application's protected runtime storage and
private setup evidence, outside source history and packages.
If an optional persistence or schema change is approved, verify that concurrent
writes and unavailable-schema handling preserve every existing application log
record. A fallback that omits request IDs leaves correlation pending, even when
inference and the original logging continue to work.

## Look up a retained request

With the already verified organization and the request's exact project, workload
and environment, use:

```text
understudy requests show <request-id> --org <org> --project <project> --workload <workload> --environment <environment> --json
understudy captures get <request-id> --org <org> --project <project> --workload <workload> --environment <environment> --json
```

`requests show` reads request metadata; `captures get` separately summarizes a
stored capture. Use the capture command when capture inspection is in scope.
Missing, disabled, expired or denied capture access does not establish that
metadata is absent. Capture expectation/capability metadata alone does not prove
that a stored body is available. Full bodies require explicit
`--include-payload --yes`; do not enable capture merely to make lookup succeed.
Follow the main skill's bounded ingestion wait when request metadata is pending.

One saved ID locates one request, not every call in a job or conversation. The
application's own IDs and per-attempt records supply that association; this setup
step does not reconstruct a task or create a new platform task identity.
