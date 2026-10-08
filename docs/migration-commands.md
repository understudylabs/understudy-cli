# Capture reconstruction and replay commands

For ordinary model spot checks, follow [`try-models`](../skills/try-models/SKILL.md)
using requests, captures and the application's runner. The commands below are
for explicitly requested capture reconstruction and private replay.

Start that path with `understudy migrate --project <name> --workload <name>`.
The command resolves the exact workload, downloads yesterday's UTC captures,
reconstructs tasks, and writes private capture evidence. `--resume <id>` reuses
those captures.
It does not execute a replay or prescribe clusters, reviews, stages, or a UI.

To download the last seven completed UTC days:

```sh
understudy migrate --project <name> --workload <name> --last-days 7 --json
```

Alternatively, pass `--from YYYY-MM-DD --to YYYY-MM-DD` for an exact range of
completed UTC days. The start is inclusive and the end is exclusive; do not
combine these options with `--last-days`. Without dates, the command selects
the previous completed UTC day. If that day has no indexed captures, it reports
that fact; select an earlier date explicitly. The export goes directly to the
indexed export API and follows every page for every selected day, including empty days.

The CLI downloads up to 16 capture objects concurrently, validates their scope,
and verifies local sizes and hashes. Large or unknown-size objects share a
bounded buffer allowance rather than all being buffered simultaneously.
It saves each completed page without its
temporary download URLs. After interruption, use the reported `--resume <id>`
with the same project and workload and no date options. The saved date range
does not move forward; completed days and pages are reused, and an interrupted
page may be downloaded again.

Human-readable mode shows per-day capture and byte counts during download and
marks verification and reconstruction. `--json` keeps stdout as one result and
does not interleave progress messages.

`export-coverage.json` records the selected range, per-day counts, unavailable
objects, verified bytes, and export elapsed time. `capture-evidence.json` reports
`completeForWindow` separately from full-inventory coverage. Each day has its
own frozen index cutoff; the week is not one atomic snapshot. Coverage describes
indexed captures, not uncaptured traffic or a guarantee that every interaction
begins and ends inside the date range. Timing depends on capture volume and
network throughput. Reconstructed task and fixture gaps remain explicit.

The supporting primitives are:

- `understudy replay --run <id> --harness <private.cjs> --model <id> --max-calls <n>
  --max-output-tokens <n>`: execute the agent's local harness using bounded model
  requests and recorded tool mocks. Optional `--id <id>` resumes an unchanged
  replay journal. Optional `--target-project` and `--target-workload` identify
  authorized comparison traffic. There is no experiment or phase-plan schema.
- `understudy models list --json`: list available model identities.

See the [harness API](replay-harness.md) for offline execution, protocol support,
limits and resume behavior, the [tool-environment contract](replay-tool-environment.md)
for optional stateful simulation, and the [replay evidence guide](replay-evidence.md)
for response decoding and evidence limits.
Installed Node packages and standalone binaries include the harness and
tool-environment reference in `understudy replay --help`; no source checkout or
skill installation is needed to read it.

Use `--json` for coding-agent operations. Run commands in the application project.
Runtime files stay under `.understudy/migrations/<run-id>/` at its Git root,
including in linked worktrees. Without Git, use the current directory or an
enclosing directory with project state. The global home store is never selected
just because a project is underneath it. The CLI adds a root ignore rule before
writing, rejects tracked state, and keeps files owner-only. Credentials stay in
the global user store. Exclude runtime state from application packages too.
The CLI writes `capture-evidence.json`, `tasks.json`, `tool-fixture-plan.json`,
and replay journals. Inspect those local JSON files directly when using this
advanced path. Derived task IDs describe the reconstruction's grouping, not an
application task identity or a guarantee of complete execution coverage.
For large runs, `tasks.json` contains summaries with a `detail` reference. Read
the referenced file inside the run directory after verifying its `bytes`,
`sha256`, task ID and request IDs against the summary; absent bodies in a summary
are not evidence of missing captures.
The commands do not launch an agent or choose a comparison workflow. Existing
private reports remain untouched.

Existing global runs are preserved. To reuse one, copy the complete selected run
into the project state, retaining its permissions, evidence, and journals. Do not
copy global credentials or unrelated runs. Use project-local paths for generated
harnesses and viewers. Relative capture paths and unchanged replay journals remain
valid. Keep loose exports under the project's `.understudy/` for direct analysis;
this CLI no longer exposes a local import command. Never merge colliding run directories.
