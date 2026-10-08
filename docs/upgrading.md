# Upgrade the CLI and agent skills

The new CLI and its Markdown skills cover application setup, model recommendations,
spot checks using captured requests, comparison views, gradual rollout through app
controls, and read-only workload diagnostics. The older distribution also supplied
other commands and agent integrations. This is not command-for-command
compatibility.

Both the Node build and standalone binary contain the maintained skills and their
reviewed references and resources. `understudy skills list` shows this CLI
version's bundled inventory; the [README](../README.md) describes the workflows.
Installing the CLI does not write those files into an agent's
skill directory, activate a skill, remove an older npm installation, or replace
an agent plugin. `understudy skills install` installs all bundled skills together.

1. Install and verify the new CLI. Use `type -a understudy`,
   `understudy --version`, and `understudy skills --help` to check which command
   your shell resolves. The installer reports a different command taking
   precedence; put the new installation first in PATH and restart the shell.
2. Run `understudy skills install`, adding `--harness` for your coding agent as
   described below. The same command refreshes an older installation. Verify the
   agent can read the bundled skills and their references.
   Inventory older Understudy plugins, linked skills, and the commands the user
   still needs. Do not assume a binary update changes these.
3. Once the replacement workflow works, disable the superseded Understudy plugin
   through that agent's plugin manager, or unlink only confirmed old Understudy
   skill links. Preserve unrelated plugins and user-written skills. Follow the
   agent's actual reload/activation requirement.
4. For an installation verified to be the old global npm package, remove that
   package with `npm uninstall -g @understudylabs/understudy-agent-tools`. Recheck
   command resolution afterward. Do not delete the old checkout while active
   plugins or links still depend on it. Do not automatically run this removal
   during binary installation.

## Install the bundled skills

Install all skills in the shared agent skills directory used by Codex:

```sh
understudy skills install
```

Choose another coding agent with a short option:

```sh
understudy skills install --harness claude
understudy skills install --harness cursor
understudy skills install --harness opencode
```

| Harness | Default skill directory |
| --- | --- |
| Default / `codex` | `~/.agents/skills` |
| `claude` | `~/.claude/skills` |
| `cursor` | `~/.cursor/skills` |
| `opencode` | `~/.config/opencode/skills` |

Locations follow the host documentation for [Codex](https://learn.chatgpt.com/docs/build-skills),
[Claude Code](https://code.claude.com/docs/en/skills),
[Cursor](https://cursor.com/docs/skills), and [OpenCode](https://opencode.ai/docs/skills/).

Claude honors `CLAUDE_CONFIG_DIR`. OpenCode honors `OPENCODE_CONFIG_DIR`, then
an absolute `XDG_CONFIG_HOME`, before using its default. The command reports its destination;
it does not infer a host from whichever directories happen to exist. An existing
linked skill root is resolved to its real directory; links inside a named skill
are still refused.

To install only one skill, add its name: `understudy skills install setup-understudy
--harness claude`. For a custom root, use `understudy skills install --directory
<skills-directory>` instead of `--harness`. Each skill gets its own directory
inside that root. The earlier `skills install <name> --directory <root>` form
still works. `understudy skills list` is optional discovery, not an install step.

Listing and installation are local and require neither credentials nor network
access. The JSON output includes the CLI version, content-based skill version,
and per-file SHA-256 digests. Add `--json` for machine-readable results. Batch
installation returns the destination and a `skills` array; named installation
retains its existing single-skill result. Each skill reports its absolute directory,
entrypoint and an `installed` or `unchanged` status. The skill version identifies
its exact bundled contents independently of the CLI's version number.

Run the same `skills install` command after updating the CLI. Identical skills
return `unchanged`; missing, older, edited, or incomplete skills return `installed`
after refresh. Selected bundled skill directories are managed output: installation
replaces local edits and removes obsolete or extra files inside those directories.
There are no separate status/update commands or persistent skill backups.

The installer stages each selected skill before replacement, refuses linked or
special-file destinations, and checks every selected skill before changing a
batch. If a filesystem failure interrupts installation, resolve it and rerun the
same command. Earlier completed skills are listed in the error and remain intact.

Installation leaves unrelated skill directories, application `.understudy/`
downloads and results, and credentials untouched. It does not fetch a newer CLI,
remove retired skill names, or replace agent plugins. Start a new agent session
and verify which skills the agent can read.

### Replace `migrate-workload` with `try-models`

The model-comparison skill is now named `try-models`. It shows a few existing
examples side by side and stops at the comparison. Formal evaluation remains
separate work; `rollout-workload` handles requested adoption.

The installer does not remove retired skill names. Before activating this bundle,
inspect the agent's active skill roots and plugins for `migrate-workload`. Remove
a confirmed obsolete direct installation after the replacement works; disable or
unlink plugin-owned copies through their owner. Keep unrelated skills and active
link targets. Refresh bundled handoffs with `understudy skills install` for the
same target.

Run `understudy skills install` for the intended harness, then reload or start a
new agent session. Verify the agent can read `try-models` and its references and
no longer discovers the old `migrate-workload` workflow. `understudy skills list`
shows the CLI's bundled inventory, not which skills an agent has loaded. This
rename does not require moving downloaded captures, saved results or credentials.

Writing the files is separate from loading them into an agent. Follow the host's
reload or activation requirements, verify the agent can read the reported
`SKILL.md` and references, then ask it to use `setup-understudy` to connect the
application. CLI installation success alone does not prove the host has loaded
the skill or that application onboarding has completed.

Keep credentials and saved runs. The installer does not
sign out, revoke credentials, delete global state, or move migration data. Runs
created by the new migration command live in the application's `.understudy/`.
For earlier global runs, follow the copy-and-resume instructions in
[the migration interface](migration-commands.md). Keep the original records until
the copied evidence, harness, and viewer have been verified.
