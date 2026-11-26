import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitChangesResponse,
  GitCommitDetail,
  GitDiffResponse,
  GitLogResponse,
  GitProjectTreeResponse,
  GitRepoSummary,
  GitWorktreesResponse,
} from "@real-bot/protocol";
import { createLocalApi } from "../local-api";
import { memoryKeyStore } from "../secrets";
import { Store } from "../store";

let tmpRoot = "";
let repoDir = "";
let dataDir = "";

function gitSync(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Route Tester",
      GIT_AUTHOR_EMAIL: "route@example.com",
      GIT_COMMITTER_NAME: "Route Tester",
      GIT_COMMITTER_EMAIL: "route@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "deskfolk-git-routes-"));
  repoDir = join(tmpRoot, "proj");
  dataDir = join(tmpRoot, "data");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  gitSync(repoDir, ["init", "-b", "main"]);
  writeFileSync(join(repoDir, "hello.ts"), "export const x = 1;\n");
  gitSync(repoDir, ["add", "."]);
  gitSync(repoDir, ["commit", "-m", "init"]);
  writeFileSync(join(repoDir, "hello.ts"), "export const x = 2;\n");
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("project-git local-api routes", () => {
  test("serves git summary, changes, diff, worktrees, log, and commit detail and rejects invalid inputs", async () => {
    const store = new Store({ endpointKey: memoryKeyStore(null) });
    const session = store.createProjectSession({ dir: repoDir, agent: "claude_code", configDir: null, locale: "zh" });
    const api = createLocalApi({ store, token: "tok", schedule: false, onQuit: () => {} });

    const call = async (path: string) => {
      const req = new Request(`http://127.0.0.1:17890${path}`, {
        method: "GET",
        headers: { Authorization: "Bearer tok" },
      });
      return api.fetch(req, {} as never);
    };

    try {
      const sumRes = await call(`/v1/project-sessions/${session.id}/git`);
      expect(sumRes?.status).toBe(200);
      const summary = (await sumRes!.json()) as GitRepoSummary;
      expect(summary.is_repo).toBe(true);
      expect(summary.branch).toBe("main");
      expect(summary.dirty_count).toBe(1);

      const chRes = await call(`/v1/project-sessions/${session.id}/git/changes?base=working`);
      expect(chRes?.status).toBe(200);
      const changes = (await chRes!.json()) as GitChangesResponse;
      expect(changes.files.map((f) => f.path)).toEqual(["hello.ts"]);

      const diffRes = await call(`/v1/project-sessions/${session.id}/git/diff?base=working&path=hello.ts`);
      expect(diffRes?.status).toBe(200);
      const diff = (await diffRes!.json()) as GitDiffResponse;
      expect(diff.patch).toContain("+export const x = 2;");

      const wtRes = await call(`/v1/project-sessions/${session.id}/git/worktrees`);
      expect(wtRes?.status).toBe(200);
      const worktrees = (await wtRes!.json()) as GitWorktreesResponse;
      expect(worktrees.worktrees.length).toBe(1);
      expect(worktrees.worktrees[0]!.session_ids).toEqual([session.id]);

      const treeRes = await call(`/v1/project-sessions/${session.id}/git/tree`);
      expect(treeRes?.status).toBe(200);
      const tree = (await treeRes!.json()) as GitProjectTreeResponse;
      expect(tree.git_available).toBe(true);
      expect(tree.repos.length).toBe(1);
      expect(tree.repos[0]!.id).toBe(".");
      expect(tree.repos[0]!.worktrees[0]!.session_ids).toEqual([session.id]);

      const logRes = await call(`/v1/project-sessions/${session.id}/git/log?limit=10`);
      expect(logRes?.status).toBe(200);
      const log = (await logRes!.json()) as GitLogResponse;
      expect(log.commits.length).toBe(1);

      const commitRes = await call(`/v1/project-sessions/${session.id}/git/commits/${log.commits[0]!.oid}`);
      expect(commitRes?.status).toBe(200);
      const detail = (await commitRes!.json()) as GitCommitDetail;
      expect(detail.subject).toBe("init");

      // Invalid path & oid return 422.
      const badDiff = await call(`/v1/project-sessions/${session.id}/git/diff?base=working&path=../etc/passwd`);
      expect(badDiff?.status).toBe(422);
      const badCommit = await call(`/v1/project-sessions/${session.id}/git/commits/not-a-sha`);
      expect(badCommit?.status).toBe(422);
      const badBase = await call(`/v1/project-sessions/${session.id}/git/changes?base=evil`);
      expect(badBase?.status).toBe(422);
    } finally {
      store.close();
    }
  });
});
