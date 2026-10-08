# Resolve a workload and capture its evidence

Read the application's actual code first: identify the responsibility being
evaluated and where its model calls receive workload attribution. Use one existing
Understudy workload for this eval. An application task can span several workloads;
keep the other steps as explicit context or dependencies, outside this workload's
selected examples and measurements. If an existing broad/default workload mixes
responsibilities, document the subset and limitation for later workload-design
discussion. Do not silently reassign traffic to make the eval look cleaner.

Run these existing CLI commands from the application's Git root, or its resolved
state root outside Git. Replace placeholders with returned values; never infer
an ID from a display name. Node.js 22+ and Git are required for the bundled helpers.

### 1. Resolve identity and workload membership

```sh
understudy status --json
understudy auth whoami --json
understudy context show --json
understudy projects list --json
understudy workloads list --project <project-id> --json
understudy workloads show <workload-id> --project <project-id> --json
```

Inspect status fields even if it exits with code 1: missing inference access can
coexist with `management: connected`. That does not block authorized capture
reads. `auth whoami` verifies the organization. Workload reads resolve exact IDs
or names inside the selected project and authenticated organization. Check that
the returned `workload.projectId` equals `project.id` and that the responsibility
matches the inspected code. A matching name alone does not establish that mapping.

`context show` reports stored defaults without remote verification. Prefer the
explicit project/workload selectors below; they override those resource defaults
without changing saved context. If a stale organization context blocks a read,
record that setup issue rather than silently clearing it. Only when the developer
wants this selection saved as the application's defaults, use:

```sh
understudy context set --org <organization-id> \
  --project <project-id> --workload <workload-id> --json
```

`--org` asserts the authenticated organization; it does not switch tenants.
An unresolved identity or missing workload is a setup gap. Continue preparing
the local task contract, but do not fabricate IDs or query another workload as
a substitute. Changing workload definitions, capture settings, or routing is
separate setup work. Capture being off now does not prove that older captures
never existed; an empty listing does not prove the workload had no traffic.

Prepare the private eval directory before saving lookup results. Record source
`understudy`, `organizationId` from verified identity, and `projectId`,
`workloadId`, and `name` from the resolved resources in the existing eval metadata
or `eval.md`. The bundled path uses `manifest.workload` for these same fields.
Keep non-secret lookup responses under `source/`, with verification time and the
code-to-workload mapping in `eval.md`. Record project slug, source environment,
`captureEnabled`, `captureSampleRate`, and configured routing as context, without
changing them. Inference headers use project **slug** and workload **name**;
management IDs must not be substituted into those headers.

Existing private captures can be used offline when their saved identity and
membership establish this scope. Record when identity was verified and whether
current settings are unknown. No fresh login is needed merely to grade saved
outputs with a local grader.

### 2. Choose tasks, then verify their request IDs

An application task ID must first be mapped to gateway request IDs using
Understudy/application records or the user's evidence. One request is one model
call; an optional `trace_id` is not a verified task boundary. There is no CLI
task-ID or trace-ID lookup. Ask which ordinary, expensive, difficult, or previously
broken tasks matter, then check the supplied request IDs against this workload:

```sh
understudy requests show <request-id> \
  --org <organization-id> --project <project-id> --workload <workload-id> \
  --environment production --json
```

Use the actual source environment instead of `production` when appropriate.
Preserve the returned organization, project, workload, and canonical request
identity. For older IDs that `requests show` cannot accept, a scoped
`captures get <request-id>` without payload flags can verify retained capture
membership from its metadata output. This call still fetches the full capture
internally; it does not guarantee a payload-free download.
If a selected task spans workloads, include only this workload's calls as eval
source members. Describe required upstream/downstream context separately; a
task spanning several responsibilities is not evidence of success for every one.

If the user has no IDs, start with a stated metadata window:

```sh
understudy requests list \
  --org <organization-id> --project <project-id> --workload <workload-id> \
  --environment production --window 24h --all --json
```

Choose relevant requests from the returned metadata. `--all` follows metadata
pages; it does not download bodies. Supported windows are `10m`, `1h`, `6h`,
`24h`, and `7d`. Preserve the returned `--window-start`, `--window-end`, and
`--snapshot-watermark`, together with unchanged filters, to repeat that snapshot.

Save verified request membership, one UUID per line, in a private file. Include
the selected workload's continuations, and keep a separate task-to-request map
with ordering evidence and missing context. Do not use unrelated requests merely
to reach a target case count.

### 3. Download the retained bodies and build cases

```sh
understudy captures export \
  --request-ids-file .understudy/evals/<eval-name>/request-ids.txt \
  --org <organization-id> --project <project-id> --workload <workload-id> \
  --environment production --include-payload --yes \
  --out .understudy/evals/<eval-name>/source/captures --json
```

Both payload flags are required. Do not combine explicit IDs with window or
date selection flags. Keep manifests, unchanged bytes, and missing/failed entries.
Resume the same selection in the same directory; changed inputs need a new one.
`requests show` requires UUIDv7; `captures get <id>` also accepts older UUIDs.
For a single capture, `captures get` takes the same scope/payload flags and
`--out <private-file>`; its output path resolves from the current directory,
whereas export and ID-file paths resolve from the application root.

Payload fields can contain JSON or streamed response text. Preserve the raw
`customer_request_body` and `response_body`, then decode according to the recorded
endpoint and stream format. Do not mistake an incomplete stream for an empty
successful answer. A finished download does not prove complete task context.
Use a clearly named call/continuation eval when that is all the evidence supports.

Construct cases in the existing format, or bundled `cases.jsonl`, retaining each
case's membership and expected-outcome authority. If the resolved workload has no usable traces,
bootstrap from application contracts and clearly labeled synthetic examples;
keep its real workload identity. Only the wholly invented offline demo uses
`workload.source: synthetic`.

After the baseline, connect findings and new failure examples back to the same
workload. Add missing coverage in a versioned eval revision. Record proposed
workload, prompt, tool, or model changes as later decisions; this workflow ends
with measurement and does not apply those changes.
