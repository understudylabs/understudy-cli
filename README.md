# Understudy CLI

Use the Understudy CLI to connect an existing application to Understudy, manage
its projects and workloads, and see what happens to its model requests.
The terminal command is `understudy`.

You can use it directly, call it from scripts, or let a coding agent use it
through a skill. The CLI supplies the operations; skills explain how to combine
them into a workflow, such as connecting an application or testing another model.

- **Set up an application:** sign in, create workloads, and connect its existing SDK.
- **Manage resources:** inspect projects, models, API keys, capture settings, and model routes.
- **Understand traffic:** inspect individual requests, captured contents, errors, usage, and costs.
- **Test a model change:** try a candidate in your application, or replay captured interactions privately.

This README describes the current source tree. An installed release may differ;
use `understudy --help` to see what your installation supports.

## Get started

Build and install from this checkout with **Node.js 22 or newer**:

```sh
npm ci
npm run build
npm link
understudy --help
```

To connect an application with a coding agent, [install the skills](#connect-your-application-with-a-skill)
and let the agent guide login and setup. Email-code sign-in is the recommended
flow in a coding-agent terminal:

```sh
understudy login --email "<email>" --send-code
understudy login --code "<code>"
understudy auth whoami
understudy projects list
```

Replace `<code>` with the six-digit code from the email, preserving any leading
zero. You can give the code to the agent in the conversation or run the completion
command directly, including in its `!` shell. Both commands use the same
machine/container, user home and CLI service.

An **organization** owns your account's resources. A **project** groups an
application or service. A **workload** identifies a stable model-backed task,
such as extracting fields or drafting a reply. One agent can contain several
workloads; its deterministic database or search tools are not additional model
workloads.

From your application directory, select an existing project and inspect it.
Replace `<project>` with its slug or ID:

```sh
understudy context set --project "<project>"
understudy workloads list
understudy report workload-status --window 1h
```

Context saves defaults for that exact directory. Explicit command options can
override them. Remote operations stay within the signed-in organization;
`--org`, where supported, checks that identity rather than switching it.

Browser `understudy login` remains available and creates an OAuth session;
email login creates an organization key. Bare `understudy login --code` also
supports a hidden interactive prompt or supplied stdin. See
[authentication and context](docs/auth-context.md) for their capabilities.

## Connect your application with a skill

Install all bundled skills in one command. For Codex and the shared agent skills
directory:

```sh
understudy skills install
```

For another coding agent, choose its harness:

```sh
understudy skills install --harness claude
understudy skills install --harness cursor
understudy skills install --harness opencode
```

Run the command for the agent you use. `setup-understudy`, `recommend-models`,
`try-models`, `rollout-workload`, `check-workload`, `build-evals`, `compare-models`,
and `adapt-model-api`, with their resources,
are included. You do not need to list
skills or know their filesystem paths first. Start a new agent session in your
application repository for automatic discovery and confirm it can see the installed
skills. An agent continuing an existing session can instead read the installed
`SKILL.md` directly from the `entrypoint` returned by installation with `--json`.
If its host cannot read that file, save the task handoff and resume in a new session. Installation
is local and requires no login. Rerun it after upgrading the CLI to replace older
bundled skills, including edits and stale files inside their directories. See the
[installation and upgrade guide](docs/upgrading.md) for details.

Then ask your coding agent:

> Use setup-understudy to connect this application's existing inference to
> Understudy. Propose the smallest stable model tasks and their workload names,
> and let me approve the names and setup plan before creating resources or sending
> traffic. Ask whether to retain request IDs with application records: yes, no,
> or do it later. Keep the current SDK and models, then verify the approved integration.

The [setup skill](skills/setup-understudy/SKILL.md) guides code discovery, workload
names and boundaries, SDK/base-URL changes, credential delivery, the application
commit, and runtime verification. It includes references for OpenAI-compatible
clients, Anthropic Messages, Vercel AI SDK, and Mastra.
Setup preserves the current API format, model, prompts and tools. Model testing,
eval construction and API conversion happen in their own later workflows.

**`understudy setup` and the setup skill do different jobs.** The command
provisions private inference access for CLI requests. The skill guides the agent
through connecting your application's code and verifying that it works.

## Commands at a glance

Every command below starts with `understudy`. Use `--help` at any level for exact
arguments and filters, for example `understudy workloads route --help`.

### Sign in and configure

| Command | What it does |
| --- | --- |
| `login`, `logout` | Sign in through a browser or email code; clear local sign-in state. |
| `auth status`, `auth whoami`, `auth clear` | Inspect saved authentication, verify the active organization, or clear local authentication. |
| `context show`, `context set`, `context clear` | Inspect, select, or clear this directory's project/workload defaults. |
| `status` | Check authentication and integration readiness. |
| `setup` | Provision private inference access for CLI probes and replay. |
| `test` | Send one small, billable synthetic request through the gateway. |
| `skills list`, `skills install` | Discover, install, or refresh skills bundled with this CLI. |

### Manage resources

| Group | Subcommands | What it manages |
| --- | --- | --- |
| `projects` | `list`, `show`, `create`, `update`, `delete`, `switch`, `ensure-default` | Application/service groupings. `switch` saves the project as this directory's default. |
| `workloads` | `list`, `show`, `create`, `update`, `route` | Model tasks, capture settings, and explicit model traffic routes. |
| `models` | `list`, `show` | Models in your organization's catalog. |
| `keys` | `list`, `create`, `exec`, `revoke` | API key metadata, private key storage, and credential delivery to a child process. |

New workloads have capture disabled by default. Setting a model route enables
capture unless `--capture off` is supplied. A model route changes which model
serves traffic; connecting an application's SDK to the gateway is a separate step.
Capture retains interaction contents for prompt/response debugging and replay;
request metadata remains available without it. During setup, choose retention
for the intended traffic rather than copying settings from unrelated workloads.
See the [resource command guide](docs/resource-commands.md).

### Inspect traffic, usage, and billing

| Group | Subcommands | What you can learn |
| --- | --- | --- |
| `report` | `health`, `usage`, `errors`, `costs`, `summary`, `usage-summary`, `workload-status`, `providers`, `cost-breakdown`, `cost`, `failures` | Organization/project health, usage, errors, declared routing, and recorded costs. Bare `report` returns a summary. |
| `billing` | `balance`, `summary`, `trend`, `usage-by-model` | Organization balance and billing usage. |
| `requests` | `list`, `show` | Individual request metadata. |
| `captures` | `list`, `get`, `export` | Available retained interactions and explicit payload downloads. |

A **request** is one gateway model call. A **capture** contains its retained
request/response data, when available and permitted. You can inspect
request metadata without downloading prompts or responses. Failure counts are
diagnostic evidence; interpreting why a task failed belongs to the agent or person
reviewing them.

Capture reads and exports return summaries by default; downloading full payloads
requires `--include-payload --yes`.

For example, using the project selected above:

```sh
understudy requests list --window 1h --environment production
understudy report failures --window 1h --environment production
understudy report usage --project "<project>" --window 7d --json
understudy billing balance
```

See [reporting and billing](docs/reporting-commands.md) for scope and cost coverage,
and [requests and captures](docs/capture-commands.md) for filters and
download behavior. `report` is the single aggregate-reporting group;
`requests list/show` inspect individual calls. See the
[upgrade notes](docs/reporting-commands.md#one-reporting-command-group)
for the removed duplicate spellings.

### Diagnose an existing workload

Ask your coding agent:

> Use check-workload to inspect this workload's production traffic over the last
> day. Explain failures, slow or expensive calls, and anything worth investigating,
> with example request IDs and gaps in the evidence.

The [diagnostic skill](skills/check-workload/SKILL.md) combines existing `report`,
`requests`, `captures` and workload reads with application context. It resolves
scope, reads aggregates, and inspects a few relevant calls before recommending
next actions. It keeps calculated cost, pricing coverage, actual serving and
application outcomes distinct. This is a bounded read-only check; it does not
send inference, change routing, build an eval or start ongoing monitoring.
No additional CLI commands or platform APIs are required.

### Choose and compare models for a task

Ask your coding agent:

> Use recommend-models to find two or three open-weight models from our available
> Understudy catalog that fit this task. Use OpenRouter for model information and
> estimated relative prices. Explain which to try first, then compare the shortlist
> with the current model using our application's local test runner.

The [recommendation skill](skills/recommend-models/SKILL.md) starts with the
authenticated Understudy catalog and reviews every eligible model
through OpenRouter's public API before choosing a shortlist. Its private candidate
matrix records task fit, adaptations, sources, costs and reasons for selection,
deferral or exclusion, with unresolved matches and research coverage visible.
It analyzes task evidence locally, uses public model identifiers for research,
and labels OpenRouter prices as estimates. It
does not require new platform capability or pricing APIs, an OpenRouter key, or
an eval framework. `models list` inventories vetted models; `--gateway` adds
declared API formats. External capabilities retain their source and serving scope.

Recommendation-only requests produce a Markdown shortlist. The skill starts with
existing Understudy requests and captures and asks for a different source only when needed.
For a requested comparison, it continues into `try-models`: select a few
examples, change only the model, run bounded spot checks, and ask whether you
want a small local UI or a Markdown comparison of outputs, tool effects, latency
and available cost. An existing preference is reused. A requested UI is built,
opened and linked; if opening is unavailable, the agent says so. Poor results
lead to another agreed candidate; custom graders and prompt/harness optimization are
separate work, not automatic prerequisites.

When the user requests adoption of a chosen model, `rollout-workload` inspects the application's
existing flags, allowlists and cohort controls. It prepares a reversible change
and applies an already-authorized switch or gradual rollout. Missing activation
scope is resolved with the user; spot-check results do not automatically promote
traffic. Each skill reuses earlier findings and authorization.

### Build an eval for a workload

> Use build-evals in Low mode for this workload and the task/request IDs I care
> about. Preserve the current application and show which important behaviors pass
> or fail.

The [eval skill](skills/build-evals/SKILL.md) starts by understanding one workload's
application responsibility and resolving its organization, project, and workload
identity through the CLI. It selects that workload's traces, reconstructs tasks,
and builds a repeatable eval. Existing evals can keep their runner, schemas,
graders, and reports without converting to a new format. It includes Low and
Medium workflows and optional tools for a private application adapter, grader
controls, saved-output regrading, local HTML and Markdown reports, human review,
and calibration tools. Low produces a quick regression check; Medium adds
failure discovery, coverage, and measurement
validation. Medium includes actual-input and grading review, a workload-specific
case-review workflow, an eval validity check, product and retrieval measurements,
and a complete invented trace-to-eval example. Captured and derived evidence,
results, and new private eval code stay in the application's ignored,
package-excluded `.understudy/evals/` directory. Existing runner, grader, and
viewer source can stay in place. The CLI supplies capture/replay primitives; the
skill's optional Node scripts provide an eval lifecycle when needed. Reports
retain workload scope and failure evidence for later decisions; changing workload
definitions or configuration is outside this workflow.

For an offline demonstration, install `build-evals` and follow its three-command
synthetic example from a separate scratch application directory. It runs without
credentials or model calls and intentionally exposes two boundary errors.

### Compare models on an existing eval

> Use compare-models with our existing eval and vetted shortlist. Keep prompts,
> tools and checks fixed, run the current model and candidates, and show their
> outputs and regressions in a local side-by-side UI before recommending one.

The [comparison skill](skills/compare-models/SKILL.md) reuses the application's
native eval runner and viewer. Its optional offline helper compares saved runs
from `build-evals`, preserving missing results, costs and per-call serving
receipts. The bundled runner accepts `run --model <id>` and passes that model to
an adapter through `context.model`; the adapter remains responsible for using
it and retaining actual serving evidence. Reports distinguish fallback results
from evidence for the requested candidate. The skill opens and inspects a local
comparison UI and leaves exact rerun commands. Prompt optimization, hill climbing
and live rollout are subsequent, explicitly requested work.

The [synthetic walkthrough](skills/compare-models/references/demo.md) exercises
three invented model variants and the UI without credentials or model calls.
`compare-models` needs a matching sibling `build-evals` installation only when
using that optional helper. Native eval workflows require neither conversion of
their eval files nor the bundled runtime.

### Adapt the API when a model needs it

The [API adaptation skill](skills/adapt-model-api/SKILL.md) prepares an
Anthropic Messages application to use OpenAI-compatible Chat Completions when
needed by `try-models`, `compare-models` or `build-evals`, or when explicitly
requested. It preserves the original path, explains unsupported features and
tests the application wrapper before a bounded run. This is optional preparation
for the selected target, never an onboarding requirement. Reports distinguish
the API adaptation from the model change; no new CLI command is involved.

### Work with captured interactions

| Command | What it does |
| --- | --- |
| `requests list`, `requests show` | Find individual calls by workload/window or look up an exact Understudy request ID. |
| `captures get`, `captures export` | Read retained contents for selected request IDs, a request snapshot or an indexed workload day. |
| `migrate` | Resolve a workload, download its captures, and reconstruct interactions into a resumable local run. |
| `replay` | Run or resume a private harness that calls models and uses recorded or explicitly simulated tools. |

The [`try-models` skill](skills/try-models/SKILL.md) provides the procedural
spot-check flow; the [rollout skill](skills/rollout-workload/SKILL.md) handles
adoption through existing app controls. Ask your coding agent:

> Use try-models to spot-check suitable models on a few existing Understudy
> captures. Keep the prompt and tools unchanged and show the outputs side by side.
> Ask whether I want Markdown or a small local comparison UI.

`models list` returns the complete organization catalog; `models show <model>`
inspects one entry. Add `--gateway` to either command to read declared request
formats using saved gateway access. Unknown metadata stays unknown. Catalog
membership does not promise feature support, quality or savings. A small
spot-check is not a formal eval or proof of whole-workload readiness.
All bundled skills are available through `skills install`; no source checkout is
needed to read their workflows and references after installation.

`setup-understudy` checks whether the application retains `x-understudy-request-id`
alongside its own job or record ID in existing logs or storage, and guides the
small integration needed when it does not. One application operation can have
many request IDs. Those IDs lead directly to `requests show` and, when retained,
`captures get`; neither command requires tracing or a reconstructed task ID.
The earlier `traces` command family and `requests trace` have been removed.

Start with [migration commands](docs/migration-commands.md) and the
[replay contract](docs/migration-execution.md) when you need captured replay.
`migrate` downloads evidence; it does not choose a model or change live routing.
Live replay sends billable model requests in the test environment; `replay --offline`
validates the harness without model calls. Neither executes the application's
real tools. Recorded replay and stateful simulation have
different evidence limits, described in the [replay evidence guide](docs/replay-evidence.md).

## Using commands from scripts

Most commands support `--json` for structured output. Browser login is interactive;
`keys exec` inherits its child process's output and does not support `--json`.

For application credential delivery, `keys create --name <name>` returns a
non-secret reference to a privately stored key. Pass that reference to
`keys exec <reference> -- <command> [args...]` to supply the key through the child
environment. See [key management](docs/resource-commands.md) for the contract.

Private credentials and saved context live under `~/.understudy/`. Captures,
replay harnesses, and results belong in the application's ignored `.understudy/`
directory. Keep this CLI source checkout free of application data. See
[privacy and data boundaries](docs/privacy-and-data-boundaries.md).

## How the code is organized

A command follows a short path: **entrypoint → command handler → feature service
→ platform API or local storage**. Skills invoke those commands and keep workflow
decisions in readable Markdown.

| Location | Responsibility |
| --- | --- |
| [`src/bin.ts`](src/bin.ts), [`src/cli.ts`](src/cli.ts) | Start the CLI, register commands, and handle shared errors/output options. |
| [`src/commands/`](src/commands/) | Parse arguments, format results, and delegate to services. |
| `src/projects/`, `src/workloads/`, `src/models/`, `src/keys/` | Resource operations and their validation. |
| `src/report/`, `src/requests/`, `src/captures/` | Reporting, request inspection, and capture access. |
| `src/auth/`, `src/context/`, `src/status/`, `src/test/` | Sign-in, saved defaults, readiness checks, and explicit gateway probes. |
| [`src/management/`](src/management/) | Shared organization-scoped platform HTTP and session handling. |
| [`src/inference/`](src/inference/) | Gateway request transport and inference credential/scope checks. |
| [`src/migrations/`](src/migrations/) | Capture reconstruction, replay execution, tool environments, and journals. |
| [`src/storage/`](src/storage/) | Shared private-file persistence; features also own their specific storage formats. |
| [`src/skills/`](src/skills/), [`skills/`](skills/) | Skill listing/installation code and the authoritative Markdown workflows. |
| [`scripts/`](scripts/), [`tests/`](tests/) | Build/package checks, skill bundling, and tests using synthetic fixtures. |

When adding a capability, keep its command handler thin and its implementation
in the corresponding service. Reuse the shared authentication, scope, and HTTP
code. Put workflow choices—such as workload boundaries, model selection, or
interpreting failures—in the skill. The build embeds selected reviewed Markdown;
edit the source skill rather than generated bundle files.

## Development

Run the local checks before opening a pull request:

```sh
npm run check
git diff --check
```

The standalone build targets Apple Silicon on macOS 13 or newer and embeds Bun,
so the resulting executable needs no separate Node.js or Bun installation. With
the pinned build toolchain described in [Security](docs/security.md):

```sh
npm run build:binary
npm run check:binary
```

Build output goes to `artifacts/`. Building or merging a change does not publish
a release. See [Security](docs/security.md) for signing and release requirements,
and [Upgrading](docs/upgrading.md) for existing CLI and agent installations.

## License

The first-party CLI is licensed under the [MIT License](LICENSE), copyright
2026 Understudy Labs. [NOTICES.txt](NOTICES.txt) preserves the notice for reused
Understudy Labs components. Third-party dependencies retain their own licenses.
Standalone binary distribution remains subject to the review and release
requirements in [Security](docs/security.md).
