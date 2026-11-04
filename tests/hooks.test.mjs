import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CliError } from "../dist/errors.js";
import { reportGitState, resolveApiUrl, resolveHookCredential } from "../dist/hooks/git-state.js";
import { normalizeGitRepo } from "../dist/hooks/repo.js";
import {
  cliEntry,
  gitStateCommand,
  readSettings,
  resolveClaudeSettingsPath,
  withGitStateHooks,
  withoutGitStateHooks,
  writeSettings,
} from "../dist/hooks/settings.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const syntheticKey = ["sk", "synthetic", "hook", "key"].join("_");
const sha = (character) => character.repeat(40);
const sessionId = "00000000-0000-4000-8000-000000000001";

async function fixture(t) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "synthetic-hooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function memorySessions(initial = {}) {
  const sessions = new Map(Object.entries(initial));
  const pruned = [];
  return {
    sessions,
    pruned,
    sessionState: (id) => ({
      read: async () => sessions.get(id) ?? null,
      write: async (value) => void sessions.set(id, value),
      clear: async () => void sessions.delete(id),
    }),
    lockSession: async (_id, operation) => operation(),
    pruneSessionStates: async (olderThanMs) => {
      pruned.push(olderThanMs);
      for (const [id, session] of sessions) if (session.lastSeenMs < olderThanMs) sessions.delete(id);
    },
  };
}

function dependencies({ git = {}, state, fetchImplementation, credential, input, now = 1_000_000 }) {
  state ??= memorySessions();
  const answers = {
    "log -1 --format=%H%x00%ct": `${sha("a")}\u0000990`,
    "symbolic-ref -q --short HEAD": "feature-a",
    "config --get remote.origin.url": "https://github.com/Acme/Widgets.git",
    ...git,
  };
  return {
    now: () => now,
    readInput: async () => input ?? JSON.stringify({ session_id: sessionId, cwd: "/synthetic/repo", hook_event_name: "PostToolUse" }),
    git: async (_cwd, args) => (args.join(" ") in answers ? answers[args.join(" ")] : null),
    sessionState: state.sessionState,
    lockSession: state.lockSession,
    pruneSessionStates: state.pruneSessionStates,
    credential: async () => (credential === undefined ? { apiKey: syntheticKey, organizationId: "org_synthetic" } : credential),
    fetchImplementation,
  };
}

function recordingFetch(status = 200) {
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ recorded: true }), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImplementation };
}

test("normalizes every remote form of one repository, without credentials", () => {
  const scp = ["git", "@", "github.com:Acme/Widgets.git"].join("");
  const withPassword = ["https://bot:", "synthetic", "@github.com/acme/widgets"].join("");
  for (const remote of [scp, "https://github.com/acme/widgets/", "ssh://git.example.test:22/acme/widgets", withPassword]) {
    assert.match(normalizeGitRepo(remote), /^(github\.com|git\.example\.test)\/acme\/widgets$/);
  }
  for (const remote of ["/srv/git/widgets", "file:///srv/git/widgets", "github.com/acme"]) {
    assert.equal(normalizeGitRepo(remote), null);
  }
});

test("reports a session's first git state, then only changes", async () => {
  const state = memorySessions();
  const { calls, fetchImplementation } = recordingFetch();

  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, dependencies({ state, fetchImplementation })), "recorded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/admin/v1/orgs/org_synthetic/team/work-events");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${syntheticKey}`);
  assert.deepEqual(calls[0].body, {
    harness: "claude_code",
    session_id: sessionId,
    observed_at_ms: 1_000_000,
    prev_seen_at_ms: null,
    repo: "github.com/acme/widgets",
    branch: "feature-a",
    head_sha: sha("a"),
    head_committed_at_ms: 990_000,
  });

  // Unchanged: no request, but the session's last look moves forward.
  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, dependencies({ state, fetchImplementation, now: 1_005_000 })), "unchanged");
  assert.equal(calls.length, 1);
  assert.equal(state.sessions.get(sessionId).lastSeenMs, 1_005_000);

  // A new commit is reported with when the previous state was last seen.
  const changed = dependencies({ state, fetchImplementation, now: 1_010_000, git: { "log -1 --format=%H%x00%ct": `${sha("b")}\u00001008` } });
  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, changed), "recorded");
  assert.equal(calls[1].body.prev_seen_at_ms, 1_005_000);
  assert.equal(calls[1].body.head_sha, sha("b"));
});

test("reports a detached HEAD with no branch and a repository with no origin", async () => {
  const state = memorySessions();
  const { calls, fetchImplementation } = recordingFetch();
  const detached = dependencies({ state, fetchImplementation, git: { "symbolic-ref -q --short HEAD": null, "config --get remote.origin.url": null } });
  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, detached), "recorded");
  assert.equal(calls[0].body.branch, "");
  assert.equal(calls[0].body.repo, "");
});

test("keeps a failed report so the next hook sends it again", async () => {
  const state = memorySessions();
  const { calls, fetchImplementation } = recordingFetch(500);
  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, dependencies({ state, fetchImplementation })), "failed");
  assert.equal(calls.length, 1);
  assert.equal(state.sessions.size, 0);
  const throwing = async () => {
    throw new Error("offline");
  };
  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, dependencies({ state, fetchImplementation: throwing })), "failed");
});

test("skips without a usable hook input, a repository, or a credential", async () => {
  const state = memorySessions();
  const { calls, fetchImplementation } = recordingFetch();
  const options = { harness: "claude_code", apiUrl: "https://api.example.test" };
  for (const input of ["not json", "{}", JSON.stringify({ session_id: "has space", cwd: "/x" }), JSON.stringify({ session_id: sessionId, cwd: "relative" })]) {
    assert.equal(await reportGitState(options, dependencies({ state, fetchImplementation, input })), "skipped");
  }
  assert.equal(await reportGitState(options, dependencies({ state, fetchImplementation, git: { "log -1 --format=%H%x00%ct": null } })), "skipped");
  assert.equal(await reportGitState(options, dependencies({ state, fetchImplementation, credential: null })), "skipped");
  assert.equal(calls.length, 0);
});

test("forgets other sessions untouched for two weeks when a new one starts", async () => {
  const old = { version: 1, repo: "", branch: "", headSha: sha("c"), lastSeenMs: 0 };
  const state = memorySessions({ "old-session": old });
  const { fetchImplementation } = recordingFetch();
  await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, dependencies({ state, fetchImplementation, now: 15 * 86_400_000 }));
  assert.deepEqual([...state.sessions.keys()], [sessionId]);
  assert.deepEqual(state.pruned, [86_400_000]);
});

test("skips remembering the state when the session's lock can't be had", async () => {
  const state = memorySessions();
  const { calls, fetchImplementation } = recordingFetch();
  const deps = { ...dependencies({ state, fetchImplementation }), lockSession: async () => undefined };
  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, deps), "recorded");
  assert.equal(calls.length, 1);
  assert.equal(state.sessions.size, 0);
});

test("never replaces a newer look at the session with an older one", async () => {
  const newer = { version: 1, repo: "github.com/acme/widgets", branch: "feature-a", headSha: sha("a"), lastSeenMs: 2_000_000 };
  const state = memorySessions({ [sessionId]: newer });
  const { fetchImplementation } = recordingFetch();
  assert.equal(await reportGitState({ harness: "claude_code", apiUrl: "https://api.example.test" }, dependencies({ state, fetchImplementation })), "unchanged");
  assert.equal(state.sessions.get(sessionId).lastSeenMs, 2_000_000);
});

test("uses an Understudy key from the environment, never a provider key", () => {
  const storedKey = ["stored", "synthetic"].join("-");
  const stored = [{ apiKey: storedKey, organizationId: "org_stored" }];
  assert.deepEqual(resolveHookCredential({ ANTHROPIC_API_KEY: syntheticKey }, stored), { apiKey: syntheticKey, organizationId: "org_stored" });
  assert.deepEqual(resolveHookCredential({ ANTHROPIC_API_KEY: ["sk", "ant", "synthetic"].join("-") }, stored), { apiKey: storedKey, organizationId: "org_stored" });
  assert.deepEqual(resolveHookCredential({ UNDERSTUDY_API_KEY: syntheticKey, UNDERSTUDY_ORG_ID: "org_env" }, []), { apiKey: syntheticKey, organizationId: "org_env" });
  assert.equal(resolveHookCredential({ UNDERSTUDY_API_KEY: syntheticKey }, []), null);
});

test("accepts an https origin, or http only on this machine", () => {
  assert.equal(resolveApiUrl(undefined, {}), "https://api.understudylabs.com");
  assert.equal(resolveApiUrl(undefined, { UNDERSTUDY_API_URL: "http://localhost:8789" }), "http://localhost:8789");
  assert.equal(resolveApiUrl("http://127.0.0.1:8789/", {}), "http://127.0.0.1:8789");
  for (const value of ["http://api.example.test", "https://api.example.test/v1", ["https://user:", "secret@api.example.test"].join(""), "not a url"]) {
    assert.equal(resolveApiUrl(value, {}), null, value);
  }
});

test("installs the hooks once, keeping every other setting and hook", async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "settings.json");
  const other = { type: "command", command: "/usr/bin/true" };
  await writeFile(file, JSON.stringify({ model: "opus", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [other] }], Stop: [{ hooks: [other] }] } }), { mode: 0o640 });
  const command = gitStateCommand(["/opt/understudy/understudy"], undefined);

  await writeSettings(file, withGitStateHooks(await readSettings(file), command));
  await writeSettings(file, withGitStateHooks(await readSettings(file), command));
  const installed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(installed.model, "opus");
  assert.deepEqual(installed.hooks.Stop, [{ hooks: [other] }]);
  const handler = { type: "command", command, timeout: 10, async: true };
  assert.deepEqual(installed.hooks.PostToolUse, [
    { matcher: "Edit", hooks: [other] },
    { matcher: "Bash|PowerShell", hooks: [handler] },
  ]);
  assert.deepEqual(installed.hooks.PostToolUseFailure, [{ matcher: "Bash|PowerShell", hooks: [handler] }]);
  assert.deepEqual(installed.hooks.UserPromptSubmit, [{ hooks: [handler] }]);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.deepEqual((await readdir(directory)).sort(), ["settings.json"]);

  await writeSettings(file, withoutGitStateHooks(await readSettings(file)));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { model: "opus", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [other] }], Stop: [{ hooks: [other] }] } });
});

test("refuses settings that are not a JSON object, changing nothing", async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "settings.json");
  await writeFile(file, "{ broken");
  await assert.rejects(readSettings(file), CliError);
  assert.equal(await readFile(file, "utf8"), "{ broken");
  assert.deepEqual(await readSettings(path.join(directory, "missing.json")), {});
});

test("finds Claude Code settings and quotes the hook command", () => {
  assert.equal(resolveClaudeSettingsPath(undefined, { homeDirectory: "/srv/synthetic-home", environment: {} }), "/srv/synthetic-home/.claude/settings.json");
  assert.equal(resolveClaudeSettingsPath(undefined, { homeDirectory: "/srv/synthetic-home", environment: { CLAUDE_CONFIG_DIR: "~/alt" } }), "/srv/synthetic-home/alt/settings.json");
  assert.equal(resolveClaudeSettingsPath("~/s.json", { homeDirectory: "/srv/synthetic-home", environment: {} }), "/srv/synthetic-home/s.json");
  assert.equal(
    gitStateCommand(["/usr/bin/node", "/opt/cli/bin.js"], "http://localhost:8789"),
    "'/usr/bin/node' '/opt/cli/bin.js' 'hooks' 'git-state' '--harness' 'claude_code' '--api-url' 'http://localhost:8789'",
  );
  assert.throws(() => gitStateCommand(["/opt/it's/understudy"], undefined), CliError);
  const onDisk = (file) => file.startsWith("/opt/cli/") || file === "/usr/local/bin/understudy";
  assert.deepEqual(cliEntry("/usr/bin/node", "/opt/cli/dist/bin.js", onDisk), ["/usr/bin/node", "/opt/cli/dist/bin.js"]);
  // A package manager's bin link has no extension.
  assert.deepEqual(cliEntry("/usr/bin/node", "/usr/local/bin/understudy", onDisk), ["/usr/bin/node", "/usr/local/bin/understudy"]);
  assert.deepEqual(cliEntry("/opt/understudy/understudy", "/$bunfs/root/understudy", onDisk), ["/opt/understudy/understudy"]);
});

test("the hook command reports a real repository's state and prints nothing", async (t) => {
  const directory = await fixture(t);
  const home = path.join(directory, "home");
  const repository = path.join(directory, "repository");
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "feature-a", repository]);
  git("config", "user.email", "synthetic@example.test");
  git("config", "user.name", "Synthetic");
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  git("commit", "-q", "--allow-empty", "-m", "synthetic");
  const head = git("rev-parse", "HEAD");

  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ recorded: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [binPath, "hooks", "git-state", "--api-url", `http://127.0.0.1:${port}`], {
        env: { PATH: process.env.PATH, HOME: home, UNDERSTUDY_API_KEY: syntheticKey, UNDERSTUDY_ORG_ID: "org_synthetic" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ code, output }));
      child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: repository, hook_event_name: "UserPromptSubmit" }));
    });

  assert.deepEqual(await run(), { code: 0, output: "" });
  assert.deepEqual(await run(), { code: 0, output: "" });
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/admin/v1/orgs/org_synthetic/team/work-events");
  assert.equal(received[0].authorization, `Bearer ${syntheticKey}`);
  assert.deepEqual(
    { ...received[0].body, observed_at_ms: 0, head_committed_at_ms: 0 },
    { harness: "claude_code", session_id: sessionId, observed_at_ms: 0, prev_seen_at_ms: null, repo: "github.com/acme/widgets", branch: "feature-a", head_sha: head, head_committed_at_ms: 0 },
  );
  const [stateFile] = await readdir(path.join(home, ".understudy", "work-hooks"));
  assert.match(stateFile, /^[0-9a-f]{32}\.json$/);
  assert.equal((await stat(path.join(home, ".understudy", "work-hooks", stateFile))).mode & 0o777, 0o600);

  // An unreachable service changes nothing the agent can see.
  await chmod(path.join(home, ".understudy", "work-hooks"), 0o700);
  server.close();
  git("commit", "-q", "--allow-empty", "-m", "synthetic two");
  assert.deepEqual(await run(), { code: 0, output: "" });
});
