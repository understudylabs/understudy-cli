# Work hooks

`understudy hooks install` adds two command hooks to Claude Code's settings
(`--settings <file>`, else `$CLAUDE_CONFIG_DIR/settings.json`, else
`~/.claude/settings.json`). Claude Code runs them on each prompt and after each
shell command. Understudy uses what they report to show what each pull request
cost: a request belongs to the pull request holding the next commit its
session made.

`understudy hooks uninstall` removes only these hooks. Reinstalling replaces
them, so it is safe to run after moving or updating the CLI.

## What leaves the machine

Only when a session's git state changes, one request to
`POST /admin/v1/orgs/{org}/team/work-events` carrying:

- the Claude Code session id;
- the repository as `host/owner/name`, from `origin`, without credentials;
- the branch name, or nothing on a detached HEAD;
- the HEAD commit and its committer time;
- when the hook ran, and when this session's previous state was last seen.

No code, diffs, prompts, file paths, or remote credentials are sent. Outside a
git repository the hook sends nothing.

## Credentials and failures

The hook reports with `UNDERSTUDY_API_KEY`, else Claude Code's
`ANTHROPIC_API_KEY` when it is an Understudy key (never a provider key), else
the key stored by `understudy setup`. The organization comes from
`UNDERSTUDY_ORG_ID` or the stored credentials. The API origin is `--api-url`
at install, else `UNDERSTUDY_API_URL`, else production; plain http is accepted
only for localhost.

The hook prints nothing and always exits 0, because Claude Code adds a hook's
output to the model's context. A failed report leaves the local state
unchanged, so the next hook sends it again. Local state is
`~/.understudy/work-hook-state.json` (owner-only), holding each recent
session's last reported state for 14 days.
