const remoteProtocols = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);
const repoPattern = /^[a-z0-9.-]+(?:\/[a-z0-9._-]+){2,}$/;
const repoMaxCharacters = 200;

/**
 * A git remote as `host/owner/name`, lowercased, without credentials, port,
 * or `.git`, matching the Understudy service's normalization. Null for local
 * paths, `file://` remotes, and anything unparsable.
 */
export function normalizeGitRepo(remote: string): string | null {
  const value = remote.trim();
  let host: string;
  let pathname: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!remoteProtocols.has(url.protocol)) return null;
    host = url.hostname;
    pathname = url.pathname;
  } else {
    // scp-like `user@host:owner/name`; `host:/abs/path` is a local-style path.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(value);
    if (!scp) return null;
    host = scp[1]!;
    pathname = scp[2]!;
  }
  const segments = pathname.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  const repo = [host, ...segments].join("/").toLowerCase();
  return repo.length <= repoMaxCharacters && repoPattern.test(repo) ? repo : null;
}
