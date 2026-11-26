/**
 * GitHub remote parsing and issue/PR reference extraction from branch names, commits, and
 * project session messages (ADR 0118).
 */
import { defaultGitExec, type GitExecutor } from "../git/exec";

export type ParsedGitRemote = {
  host: string;
  owner: string;
  repo: string;
  url: string;
};

/**
 * Parses SSH (`git@host:owner/repo.git`, `ssh://git@host/owner/repo.git`) and HTTPS
 * (`https://host/owner/repo.git`) git remote URLs into `{ host, owner, repo }`.
 */
export function parseGitRemoteUrl(rawUrl: string): ParsedGitRemote | null {
  const url = rawUrl.trim();
  if (!url) return null;

  // SCP-like SSH: git@github.com:owner/repo.git
  const scp = url.match(/^(?:[^@\s]+@)?([a-zA-Z0-9.-]+):([^/\s]+)\/([^\s/]+?)(?:\.git)?\/?$/);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    const owner = scp[2]!;
    const repo = scp[3]!;
    if (owner && repo) return { host, owner, repo, url };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") return null;
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0]!;
    const repo = segments[1]!.replace(/\.git$/i, "");
    if (!host || !owner || !repo) return null;
    return { host, owner, repo, url };
  } catch {
    return null;
  }
}

export type ResolvedGitHubRemotes = {
  primary: ParsedGitRemote | null;
  upstream: ParsedGitRemote | null;
  rawUrl: string | null;
};

async function readRemoteUrl(cwd: string, name: string, exec: GitExecutor): Promise<string | null> {
  const res = await exec(cwd, ["remote", "get-url", name], { coalesceKey: `remote-url:${cwd}:${name}` });
  return res.ok && res.stdout.trim() ? res.stdout.trim() : null;
}

/** Resolves the repository's primary remote and optional upstream fork remote. */
export async function resolveRepoRemotes(
  cwd: string,
  branch: string | null,
  exec: GitExecutor = defaultGitExec,
): Promise<ResolvedGitHubRemotes> {
  let trackingRemote: string | null = null;
  if (branch) {
    const cfg = await exec(cwd, ["config", "--get", `branch.${branch}.remote`], { coalesceKey: `branch-remote:${cwd}:${branch}` });
    if (cfg.ok && cfg.stdout.trim()) trackingRemote = cfg.stdout.trim();
  }

  const order = [...new Set([trackingRemote, "origin", "upstream"].filter((v): v is string => Boolean(v)))];
  let primary: ParsedGitRemote | null = null;
  let rawUrl: string | null = null;
  for (const name of order) {
    const url = await readRemoteUrl(cwd, name, exec);
    if (!url) continue;
    if (!rawUrl) rawUrl = url;
    const parsed = parseGitRemoteUrl(url);
    if (parsed) {
      primary = parsed;
      break;
    }
  }

  let upstream: ParsedGitRemote | null = null;
  const upstreamUrl = await readRemoteUrl(cwd, "upstream", exec);
  if (upstreamUrl) {
    const parsedUp = parseGitRemoteUrl(upstreamUrl);
    if (parsedUp && (!primary || parsedUp.owner !== primary.owner || parsedUp.repo !== primary.repo)) {
      upstream = parsedUp;
    }
  }

  return { primary, upstream, rawUrl };
}

/** Extracts full GitHub issue/PR URLs matching this repository from chat message bodies. */
export function extractChatGitHubRefs(
  messages: readonly string[],
  targets: readonly { host: string; owner: string; repo: string }[],
): { issues: number[]; prs: number[] } {
  const issues = new Set<number>();
  const prs = new Set<number>();
  if (targets.length === 0) return { issues: [], prs: [] };

  const urlRegex = /https?:\/\/([a-zA-Z0-9.-]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)\b/gi;
  for (const body of messages) {
    if (!body || !body.includes("http")) continue;
    urlRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(body)) !== null) {
      const host = match[1]!.toLowerCase();
      const owner = match[2]!.toLowerCase();
      const repo = match[3]!.toLowerCase();
      const kind = match[4]!.toLowerCase();
      const num = Number(match[5]);
      if (!Number.isInteger(num) || num <= 0) continue;
      const matchesRepo = targets.some(
        (t) => t.host.toLowerCase() === host && t.owner.toLowerCase() === owner && t.repo.toLowerCase() === repo,
      );
      if (!matchesRepo) continue;
      if (kind === "pull") prs.add(num);
      else issues.add(num);
    }
  }
  return { issues: [...issues], prs: [...prs] };
}

/** Extracts `#123` / `issue-123` / `fix/123-...` issue/PR numbers from branch name and branch commit messages. */
export function extractBranchAndCommitRefs(branch: string | null, commitMessages: readonly string[]): number[] {
  const nums = new Set<number>();
  if (branch) {
    const branchPatterns = [
      /(?:^|[/_-])(?:issue|gh|pr|fix|feat|bug)[/_-]?#?(\d+)(?:$|[/_-])/gi,
      /(?:^|\/)#?(\d+)[_-]/g,
    ];
    for (const re of branchPatterns) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(branch)) !== null) {
        const n = Number(match[1]);
        if (Number.isInteger(n) && n > 0 && n < 10_000_000) nums.add(n);
      }
    }
  }
  const hashRe = /(?:^|[\s([,])#(\d+)\b/g;
  for (const msg of commitMessages) {
    if (!msg || !msg.includes("#")) continue;
    hashRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = hashRe.exec(msg)) !== null) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > 0 && n < 10_000_000) nums.add(n);
    }
  }
  return [...nums];
}
