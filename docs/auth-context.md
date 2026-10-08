# Authentication and application context

The CLI supports two explicit credential classes. Email-code sign-in is the
recommended flow in a coding-agent terminal. Bare `understudy login` starts
browser OAuth. Email sign-in creates an organization API key that works
with tenant admin reporting, billing, request/capture reads, resource
management, and inference. It is not an OAuth member session; customer API
operations that require OAuth still require browser login. A sign-in
replaces the active local identity, never silently falls back to another one.

## Email sign-in

Use an email address the user supplied or confirmed, then run:

```text
understudy login --email <email> --send-code
understudy login --code <code>
```

Replace `<code>` with the six-digit code from that email. The explicit argument
is the default coding-agent experience and works without interactive stdin or a
TTY. The user can provide the code in the agent conversation for the agent to
complete login, or run the command directly in the terminal or its `!` shell.
Treat the code as a string and validate exactly six digits before constructing a
command; preserve leading zeros rather than converting it to a number.

Both steps must share the same machine/container, user home and CLI service
because the pending claim is saved there. Run completion from the application
directory to save its context there. A remote agent's claim cannot be completed
by a separate laptop installation; pass the code to the agent running in the
original environment. Do not move claim files or credentials between them.

An agent authorized to sign in to the selected account can use its approved
email connector to retrieve that request's fresh sign-in code and complete login
automatically with `login --code <code>`. Restrict the search to that mailbox,
recipient, purpose and request time. Connector access does not select the account;
verify the resulting organization with `auth whoami`. API keys, claim tokens and
OAuth tokens remain private and are never supplied in this code argument.

Bare `understudy login --code` remains available for a hidden interactive prompt
or code supplied through stdin. Automated stdin callers must close the stream.
Empty or whitespace-only stdin produces an input-specific recovery message;
malformed input receives the six-digit validation error. A local input error does
not mean the email code was rejected by the service; complete the same pending
sign-in with `login --code <code>` rather than requesting another code.

Both email steps support `--json`. Omitting `--send-code` with `--email` still
requests the code and exits; it does not hold an interactive prompt open. Browser
`understudy login` remains an alternative and is required for OAuth-only operations.

Pending sign-in state is stored privately for at most ten minutes. Failed code
attempts retain it; completion or expiration clears it. `auth clear` clears a
pending claim before a new code is requested. Discovery and credential-bearing
requests require HTTPS, same-origin endpoints without URL credentials, queries,
or fragments, and reject redirects. Failure messages do not include server
response bodies or credentials. They include a valid request UUID from the
response header when available for support. Rejected verification suggests
browser sign-in if the latest code still fails; an HTTP status alone does not
establish that the user entered the wrong code.

The issued key is saved before online verification, so a temporary outage does
not discard its one-time value. If verification fails after issuance, inspect
`auth status` and retry `auth whoami`; do not automatically register again. An
inference-storage failure can be recovered with `setup`, using the saved active
organization credential. Email login bootstraps empty inference storage without
printing the key. Existing inference access is preserved; `inferenceReady` is
false when it belongs to another organization or service. Replacing inference
access requires the separate setup action and preserves any key still used for
active management authentication. If storing a newly issued sign-in key fails,
the CLI attempts to revoke it and clear the spent claim. Its error states which
cleanup succeeded; a consumed code must not be retried.

When a successful email claim includes a default project, the CLI resolves it
in the issued key's organization and saves it as this directory's project
context, clearing any old workload selection. It stores the verified roster
metadata rather than trusting claim labels. If this verification or local
context write fails, authentication remains saved; use `context set --project`
to recover without consuming another email claim. Older sign-in responses
without a default project leave context unchanged.

`auth status` reports stored state without network verification. `auth whoami`
checks the organization against a scoped server response and reports the
credential class; it does not claim to discover other organizations or verify
personal profile details. Organization-key management sessions recheck their
organization before a remote operation. `status` additionally checks integration
readiness; a stored inference credential for another service reports
`service-mismatch` without contacting that service. `test` sends an explicitly
requested synthetic inference call only when both its organization and service
match the active identity.

`logout` and `auth clear` remove active local authentication and pending email
state. `auth clear --inference` also removes local inference access. These are
local cleanup operations, not remote key revocation. Key revocation is a
separate management action.

Existing OAuth sessions remain readable from the existing private session
filename. Its schema now has an explicit credential-class discriminator. No
credential value is displayed by authentication or context commands.

## Application defaults

`context set --project <selector> [--workload <selector>]` verifies the exact
project and workload in the authenticated organization before saving defaults.
Projects accept an exact ID, slug, or name; ambiguous names fail. Workloads
accept an exact ID or name. `--org` only asserts the current organization; it
cannot switch identity or grant access. `context set --workload <selector>` can
reuse the saved project. An explicit project passed to `context set` begins a
new selection and clears the old workload unless one is also supplied.

`context show` reads local defaults and labels them unverified. Remote commands
using defaults revalidate membership against the current organization. Explicit
selectors override defaults; an explicitly selected different project does not
inherit the old workload. A saved organization mismatch requires clearing or
setting context again. Organization-wide operations can intentionally ignore
application defaults.

`projects switch <selector>` (alias `projects use`) provides the same project
selection behavior. Workload commands use this saved project when `--project`
or its `--project-id` alias is omitted, revalidating it on every remote operation.
An explicit workload-command project selector starts a fresh selection and does
not depend on a stale saved project or workload.

`context clear` affects only the current application directory. Context is
stored in owner-only global state keyed by the canonical directory identity;
it does not write identifiers or credentials into the application repository.
Defaults apply to that exact directory, not automatically to parent or child
directories. Private state and receipts must remain outside CLI source history
and package contents.
