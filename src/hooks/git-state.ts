import { z } from "zod";

import { defaultManagementUrl, requestManagementJson } from "../management/client.js";
import type { PrivateJsonStore } from "../storage/private-json.js";
import { normalizeGitRepo } from "./repo.js";

const sessionIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const understudyKeyPattern = /^sk_[A-Za-z0-9_-]+$/;
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const stateRetentionMs = 14 * 24 * 60 * 60 * 1000;
const stateMaxSessions = 500;

export const hookStateSchema = z
  .object({
    version: z.literal(1),
    sessions: z.record(
      z.string(),
      z.object({ repo: z.string(), branch: z.string(), headSha: z.string(), lastSeenMs: z.number() }).strict(),
    ),
  })
  .strict();
export type HookState = z.infer<typeof hookStateSchema>;

export interface HookCredential {
  apiKey: string;
  organizationId: string;
}

export interface GitStateDependencies {
  now(): number;
  readInput(): Promise<string>;
  /** Trimmed stdout, or null when git fails. */
  git(cwd: string, args: readonly string[]): Promise<string | null>;
  state: PrivateJsonStore<HookState>;
  credential(): Promise<HookCredential | null>;
  fetchImplementation?: typeof fetch;
}

export type GitStateOutcome = "skipped" | "unchanged" | "recorded" | "failed";

/**
 * Reports a coding tool session's git state to Understudy when it changed
 * since this session's last report. Sends the session id, repository
 * identity, branch, HEAD and its committer time; never paths, diffs, or
 * remote credentials. Every failure is swallowed: a hook must never slow or
 * break the agent.
 */
export async function reportGitState(
  options: { harness: "claude_code"; apiUrl: string },
  dependencies: GitStateDependencies,
): Promise<GitStateOutcome> {
  try {
    const observedAt = dependencies.now();
    const input = parseHookInput(await dependencies.readInput());
    if (!input) return "skipped";
    const head = await dependencies.git(input.cwd, ["log", "-1", "--format=%H%x00%ct"]);
    const [sha, committedSeconds] = head?.split("\0") ?? [];
    if (!sha || !shaPattern.test(sha) || !/^\d+$/.test(committedSeconds ?? "")) return "skipped";
    const branch = (await dependencies.git(input.cwd, ["symbolic-ref", "-q", "--short", "HEAD"])) ?? "";
    const remote = await dependencies.git(input.cwd, ["config", "--get", "remote.origin.url"]);
    const repo = (remote && normalizeGitRepo(remote)) ?? "";

    const stored = (await dependencies.state.read()) ?? { version: 1 as const, sessions: {} };
    const previous = stored.sessions[input.sessionId];
    const current = { repo, branch, headSha: sha, lastSeenMs: observedAt };
    if (previous && previous.repo === repo && previous.branch === branch && previous.headSha === sha) {
      await dependencies.state.write(pruned(stored, input.sessionId, current, observedAt));
      return "unchanged";
    }

    const credential = await dependencies.credential();
    if (!credential) return "skipped";
    await requestManagementJson(
      {
        accessToken: credential.apiKey,
        organizationId: credential.organizationId,
        credentialClass: "organization_key",
        baseUrl: options.apiUrl,
        fetchImplementation: dependencies.fetchImplementation,
      },
      {
        method: "POST",
        path: `/admin/v1/orgs/${encodeURIComponent(credential.organizationId)}/team/work-events`,
        body: {
          harness: options.harness,
          session_id: input.sessionId,
          observed_at_ms: observedAt,
          prev_seen_at_ms: previous?.lastSeenMs ?? null,
          repo,
          branch,
          head_sha: sha,
          head_committed_at_ms: Number(committedSeconds) * 1000,
        },
        action: "Work event",
        timeoutMs: 3_000,
      },
      z.object({ recorded: z.literal(true) }),
    );
    // Only a recorded change is remembered, so a failed one is sent again.
    await dependencies.state.write(pruned(stored, input.sessionId, current, observedAt));
    return "recorded";
  } catch {
    return "failed";
  }
}

function parseHookInput(text: string): { sessionId: string; cwd: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { session_id: sessionId, cwd } = parsed as Record<string, unknown>;
  if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) return null;
  if (typeof cwd !== "string" || !cwd.startsWith("/") && !/^[A-Za-z]:\\/.test(cwd)) return null;
  return { sessionId, cwd };
}

function pruned(
  state: HookState,
  sessionId: string,
  current: HookState["sessions"][string],
  now: number,
): HookState {
  const sessions = Object.entries({ ...state.sessions, [sessionId]: current })
    .filter(([, session]) => session.lastSeenMs >= now - stateRetentionMs)
    .sort(([, a], [, b]) => b.lastSeenMs - a.lastSeenMs)
    .slice(0, stateMaxSessions);
  return { version: 1, sessions: Object.fromEntries(sessions) };
}

/**
 * The key and organization to report with: an Understudy key from the
 * environment (the harness's own `ANTHROPIC_API_KEY` when it is one, never a
 * provider key), else the CLI's stored credentials.
 */
export function resolveHookCredential(
  environment: NodeJS.ProcessEnv,
  stored: { apiKey?: string; organizationId?: string }[],
): HookCredential | null {
  const fromEnvironment = [environment.UNDERSTUDY_API_KEY, environment.ANTHROPIC_API_KEY]
    .map((value) => value?.trim())
    .find((value) => value && understudyKeyPattern.test(value));
  const apiKey = fromEnvironment ?? stored.find((entry) => entry.apiKey)?.apiKey;
  const organizationId =
    environment.UNDERSTUDY_ORG_ID?.trim() || stored.find((entry) => entry.organizationId)?.organizationId;
  return apiKey && organizationId ? { apiKey, organizationId } : null;
}

/**
 * `--api-url`, else `UNDERSTUDY_API_URL`, else production. An origin only:
 * https, or http to this machine for local development.
 */
export function resolveApiUrl(flag: string | undefined, environment: NodeJS.ProcessEnv): string | null {
  let url: URL;
  try {
    url = new URL(flag ?? environment.UNDERSTUDY_API_URL ?? defaultManagementUrl);
  } catch {
    return null;
  }
  const local = localHosts.has(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin;
}
