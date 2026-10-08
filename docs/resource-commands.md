# Resource command contracts

These commands use the authenticated organization's management API, except
`models list/show --gateway`, which reads its inference catalog with saved gateway access.
They do not send inference traffic themselves. `keys exec` runs the explicit child command,
which may send traffic. Resource identifiers are exact: projects accept a slug or
id, workloads accept a name or id within a selected project, and models and keys
accept an id. A selector that matches multiple resources is an error.

| Command | Behavior |
| --- | --- |
| `projects list` | Traverse every project cursor and return public project fields. |
| `projects show <project>` | Resolve an exact project from the scoped list. |
| `projects create <slug> --name <name>` | Create a project with an immutable slug. |
| `projects update <project> --name <name>` | Change the display name. |
| `projects delete <project> --confirm` | Soft-delete the selected project. |
| `projects switch <project>` (alias `use`) | Verify and save the project as the current directory context. |
| `projects ensure-default` | Idempotently provision the canonical rehearsal project and default workload. |
| `workloads update <workload> --project <project> --capture-sample-rate <rate>` | Set capture sampling between 0 and 1 independently of the capture enabled flag. |
| `workloads route <workload> --model-id <model> [--traffic-pct <percent>]` | Explicitly route the selected workload to a public model, defaulting to 10 percent. |
| `workloads route <workload> --clear` | Clear its model route. |
| `models show <model>` | Return known model identity, display name, and open-weight metadata. |
| `models list --gateway` / `models show <model> --gateway` | Read the gateway catalog's declared wire formats using saved inference access. |
| `keys list` | Return the key metadata page exposed by the platform. |
| `keys create --name <name>` | Create a key and privately retain its one-time value. |
| `keys exec <reference> -- <command> [args...]` | Inject a stored key into a child environment without printing it. |
| `keys revoke <key> --confirm` | Revoke an exact key in the authenticated organization. |

Project and workload reads reject mismatched ownership, duplicate identities,
and repeated pagination cursors. Writes check that the response identifies the
selected resource and reflects the requested changes. A failed or malformed
write response reports an unknown outcome; commands do not automatically repeat
remote mutations. Project deletion and key revocation require `--confirm`,
including with `--json`.

Workload commands accept `--project` (exact id, slug, or name) or the legacy
`--project-id` alias. Omission uses the current directory context and still
verifies project membership. A route update uses the public model endpoint; it
never picks models or traffic percentages automatically. Setting a route enables
capture by platform default; use `--capture off` to opt out. Clearing leaves
capture unchanged unless `--capture on|off` is explicit. Percentages must be
integers from 0 to 100. Clearing cannot be combined with model or percentage
options. Responses must echo the requested model, workload, project, and share.

The key-list API currently does not expose its upstream pagination cursor. The
CLI therefore returns `completeness: "unknown"` and describes this limitation in
both text and JSON. It cannot discover keys beyond that page. A key outside the
returned page is not revoked by this command.

Key creation returns a non-secret `credentialReference`, never the one-time key
value or its obfuscated prefix. The reference resolves through the CLI's private
global state in `~/.understudy/`; it is bound to service, organization, and key id.
Directories use mode 0700 and files use 0600 on POSIX. It does not switch the
current login or replace an application's gateway credential. If private storage
fails, the command attempts to revoke only the just-created key and reports
whether cleanup succeeded. Successful revocation also removes the corresponding
managed-key file, when present. Other saved authentication remains unchanged.

`keys exec` verifies that the private key reference matches the active
organization and service before launching the explicitly selected command. It
sets `UNDERSTUDY_API_KEY`, `UNDERSTUDY_GATEWAY_URL`, and `UNDERSTUDY_ORG_ID` in
the child environment, never in child arguments or CLI output. It uses no shell,
inherits child streams, and preserves the child exit status. `--json` is rejected
because output belongs to the child. The child can read the credential and is
responsible for its own output and network use; choose a trusted command.

`models list` returns the complete organization catalog; `models show <model>`
selects one exact entry from the same catalog. Both preserve missing open-weight
metadata as `null` in JSON and `unknown` in human output; explicit false remains
`false` / `no`. Catalog availability does not establish workload compatibility.
Older catalog/CLI versions omit endpoint/tool support, limits, response formats,
reasoning controls and prices. `missingCapabilities` identifies absent
information without advertising an unsupported command. The `recommend-models`
skill enriches models in this authenticated catalog through OpenRouter's public
model and endpoint APIs; it never expands the shortlist to arbitrary OpenRouter
models. It uses exact identity matches, researches open-weight status and explains
source conflicts. Existing platform constraints, if returned, retain their scope.
New platform capability or pricing APIs are not prerequisites.

The skill uses OpenRouter prices as the assumed rates for relative whole-task
estimates, with explicit units, call coverage and cache/retry assumptions. These
are estimates rather than customer billing quotes; calculated request costs and
ledger debits remain separate evidence. The bundled worked example is wholly
synthetic. For a requested end-to-end comparison, the skill continues into
`try-models` with the same shortlist and authorized scope, using the
application's runner or a reproducible response/continuation from existing captures.

Add `--gateway` to either model command to read the standard `/v1/models` API.
This uses the saved inference credential only after verifying it belongs to the
active organization and service; it never provisions a key or switches login.
Gateway results identify `source: "gateway_catalog"` and expose `wireShapes`,
such as `openai-chat` or `anthropic-messages`. Missing metadata stays `null` /
`unknown`; an explicitly empty list means no formats were declared. Declared
formats do not establish tool behavior, parameter support, model health, prices,
or which model actually serves a request. The default management catalog remains
usable without inference setup.

These contracts are covered by invented fixtures and mocked HTTP responses.
Source contracts and local tests do not establish live deployment availability.
