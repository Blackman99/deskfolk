import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhExecutor } from "./exec";
import { clearGitHubCaches, fetchGitHubIssues, fetchGitHubPulls, fetchGitHubRelated, probeGitHubStatus } from "./graphql";
import { extractBranchAndCommitRefs, extractChatGitHubRefs, parseGitRemoteUrl } from "./remote";

let rootTmp = "";
let repoDir = "";

function gitSync(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

beforeAll(() => {
  rootTmp = mkdtempSync(join(tmpdir(), "deskfolk-gh-test-"));
  repoDir = join(rootTmp, "repo");
  mkdirSync(repoDir, { recursive: true });
  gitSync(repoDir, ["init", "-b", "main"]);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  gitSync(repoDir, ["add", "."]);
  gitSync(repoDir, ["commit", "-m", "init"]);
  gitSync(repoDir, ["remote", "add", "origin", "git@github.com:acme/deskfolk.git"]);
  gitSync(repoDir, ["checkout", "-b", "fix/108-diff-view"]);
  writeFileSync(join(repoDir, "a.txt"), "b\n");
  gitSync(repoDir, ["add", "."]);
  gitSync(repoDir, ["commit", "-m", "fix diff view (#108)"]);
});

afterAll(() => {
  if (rootTmp) rmSync(rootTmp, { recursive: true, force: true });
});

beforeEach(() => {
  clearGitHubCaches();
});

describe("github remote & ref extraction", () => {
  test("parses SSH, HTTPS, and enterprise remote URLs", () => {
    expect(parseGitRemoteUrl("git@github.com:acme/deskfolk.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "deskfolk",
      url: "git@github.com:acme/deskfolk.git",
    });
    expect(parseGitRemoteUrl("https://github.com/acme/deskfolk")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "deskfolk",
      url: "https://github.com/acme/deskfolk",
    });
    expect(parseGitRemoteUrl("ssh://git@github.corp.internal/team/app.git")).toEqual({
      host: "github.corp.internal",
      owner: "team",
      repo: "app",
      url: "ssh://git@github.corp.internal/team/app.git",
    });
  });

  test("extracts matching repo issue/PR URLs from chat messages and ignores other repos", () => {
    const refs = extractChatGitHubRefs(
      [
        "See https://github.com/acme/deskfolk/issues/42 and https://github.com/acme/deskfolk/pull/77",
        "Unrelated https://github.com/other/repo/issues/99",
      ],
      [{ host: "github.com", owner: "acme", repo: "deskfolk" }],
    );
    expect(refs.issues).toEqual([42]);
    expect(refs.prs).toEqual([77]);
  });

  test("extracts issue numbers from branch names and commit messages", () => {
    expect(extractBranchAndCommitRefs("fix/108-diff-view", ["Fixes #204 and refs #108"])).toEqual([108, 204]);
  });
});

describe("github graphql queries with injected fake gh", () => {
  test("reports no_gh and not_authed cleanly", async () => {
    const missingGh: GhExecutor = async () => ({
      ok: false, code: -1, stdout: "", stderr: "gh not found", truncated: false, timedOut: false, unavailable: true,
    });
    const statusMissing = await probeGitHubStatus(repoDir, { ghExec: missingGh });
    expect(statusMissing.state).toBe("no_gh");
    expect(statusMissing.owner).toBe("acme");

    const unauthedGh: GhExecutor = async () => ({
      ok: false, code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run: gh auth login", truncated: false, timedOut: false,
    });
    const statusAuth = await probeGitHubStatus(repoDir, { ghExec: unauthedGh, refresh: true });
    expect(statusAuth.state).toBe("not_authed");
  });

  test("fetches related branch PR, closing issues, chat/commit references, and serves stale cache on offline error", async () => {
    let failNow = false;
    const fakeGh: GhExecutor = async (_cwd, args) => {
      const joined = args.join(" ");
      if (joined.includes("viewer { login }")) {
        return { ok: true, code: 0, stdout: JSON.stringify({ data: { viewer: { login: "alice" } } }), stderr: "", truncated: false, timedOut: false };
      }
      if (failNow) {
        return { ok: false, code: 1, stdout: "", stderr: "dial tcp: no such host", truncated: false, timedOut: false };
      }
      if (joined.includes("closingIssuesReferences")) {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({
            data: {
              primary: {
                pullRequests: {
                  nodes: [{
                    number: 90,
                    title: "Add Git & GitHub views",
                    state: "OPEN",
                    isDraft: false,
                    url: "https://github.com/acme/deskfolk/pull/90",
                    body: "Implements ADR 0118",
                    updatedAt: "2026-11-25T10:00:00Z",
                    additions: 120,
                    deletions: 10,
                    changedFiles: 5,
                    headRefName: "fix/108-diff-view",
                    baseRefName: "main",
                    reviewDecision: "APPROVED",
                    author: { login: "alice" },
                    labels: { nodes: [{ name: "feature", color: "0e8a16" }] },
                    closingIssuesReferences: {
                      nodes: [{
                        number: 108,
                        title: "Support diff view",
                        state: "OPEN",
                        url: "https://github.com/acme/deskfolk/issues/108",
                        updatedAt: "2026-11-24T10:00:00Z",
                        author: { login: "bob" },
                        labels: { nodes: [] },
                        assignees: { nodes: [{ login: "alice" }] },
                      }],
                    },
                    commits: {
                      nodes: [{
                        commit: {
                          statusCheckRollup: {
                            contexts: {
                              nodes: [
                                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/deskfolk/runs/1" },
                                { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
                              ],
                            },
                          },
                        },
                      }],
                    },
                    comments: { totalCount: 1, nodes: [{ author: { login: "bob" }, body: "LGTM", createdAt: "2026-11-25T11:00:00Z", url: "https://github.com/acme/deskfolk/pull/90#issuecomment-1" }] },
                  }],
                },
              },
              refs: {
                r0: {
                  __typename: "Issue",
                  number: 42,
                  title: "Chat mentioned issue",
                  state: "OPEN",
                  url: "https://github.com/acme/deskfolk/issues/42",
                  updatedAt: "2026-11-20T00:00:00Z",
                  author: { login: "carol" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                },
              },
            },
          }),
          stderr: "",
          truncated: false,
          timedOut: false,
        };
      }
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ data: { search: { nodes: [] } } }),
        stderr: "",
        truncated: false,
        timedOut: false,
      };
    };

    const res = await fetchGitHubRelated(repoDir, {
      chatMessages: ["Please also look at https://github.com/acme/deskfolk/issues/42"],
      ghExec: fakeGh,
    });
    expect(res.status.state).toBe("ok");
    expect(res.status.login).toBe("alice");
    expect(res.branch_pr?.number).toBe(90);
    expect(res.branch_pr?.checks?.passed).toBe(1);
    expect(res.branch_pr?.checks?.pending).toBe(1);
    expect(res.closing_issues.map((i) => i.number)).toEqual([108]);
    expect(res.referenced_issues.map((i) => i.number)).toEqual([42]);
    expect(res.referenced_issues[0]!.source).toBe("chat");
    expect(res.stale).toBe(false);

    // Offline refresh returns stale cached data + error message.
    failNow = true;
    const stale = await fetchGitHubRelated(repoDir, {
      chatMessages: ["Please also look at https://github.com/acme/deskfolk/issues/42"],
      ghExec: fakeGh,
      refresh: true,
    });
    expect(stale.stale).toBe(true);
    expect(stale.branch_pr?.number).toBe(90);
    expect(stale.error).toContain("no such host");

    failNow = false;
    const prs = await fetchGitHubPulls(repoDir, { filter: "open", ghExec: fakeGh });
    expect(prs.items).toEqual([]);
    const issues = await fetchGitHubIssues(repoDir, { filter: "mine", ghExec: fakeGh });
    expect(issues.items).toEqual([]);
  });
});
