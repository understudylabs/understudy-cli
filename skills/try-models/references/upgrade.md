# Work with an older Understudy installation

Check which executable the shell resolves with `type -a understudy`. For an
application-led trial, verify `understudy status --help`,
`understudy workloads --help`, and `understudy requests --help`.
If an older binary takes precedence, use the intended binary explicitly or adjust
PATH. Installing a binary alone does not place skills in an agent's skill directory
or replace an agent plugin. `understudy skills install` installs all bundled
skills into the shared agent skills directory used by Codex. For another host,
use `understudy skills install --harness claude`, `--harness cursor`, or
`--harness opencode`. An explicit `--directory <skills-directory>` remains
available for custom locations, and an optional skill name selects just that
skill. Start a new agent session and verify it can read this skill and its
references before removing older skill access. Older CLIs may require the
explicit name and directory; check `understudy skills install --help`.

Inventory the user's active Understudy plugin or skill links and commands still
in use. Replace only the superseded Understudy integration after the new workflow
is verified. Preserve unrelated plugins and skills, credentials, and
saved runs. Disable via the agent's existing plugin manager or remove only links
whose old ownership is verified; honor its reload requirement. If replacing the
verified old global npm package, use its package manager to uninstall it after
verifying command resolution. Never delete an old checkout with active links.

`try-models` replaces `migrate-workload`. Run `understudy skills install` with the
same target options to refresh bundled skills. It replaces local edits and stale
resources inside selected bundled skill directories; unrelated skills remain.
There is no separate update command or persistent backup step.

The installer does not remove retired skill names. Inspect active skill roots and
plugin links, then remove a confirmed obsolete direct `migrate-workload`
installation once the replacement works. Disable plugin-owned copies through
their owner; do not delete an active link's target. Reload or start a new session
and verify the agent can read `try-models` and no longer discovers the old workflow.
`understudy skills list` reports bundled contents, not the agent's loaded skills.

Keep existing downloads, results and credentials. Renaming the skill does not
require moving or deleting the application's `.understudy/` data. Reuse relevant
scoped captures, but review old reports and scripts before reuse; they may describe
a different model configuration or a larger evaluation workflow.
