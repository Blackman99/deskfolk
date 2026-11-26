import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundDiffResponseBytes, clampDiffMaxBytes, readGitDiff } from "./diff";
import { HttpError } from "../errors";
import { isSafeRepoRelPath, isValidCommitOid } from "./exec";
import { readGitCommitDetail, readGitLog } from "./log";
import { inspectGitMarker, resetRepoDiscoveryCache, resolveProjectRepo, safeRealpath } from "./repo";
import { readGitChanges, readGitSummary } from "./status";
import { mapSessionsToWorktrees, readGitProjectTree, readGitWorktrees } from "./worktrees";

let rootTmp = "";
let repoDir = "";
let nestedWtDir = "";
let nestedRepoDir = "";
let siblingWtDir = "";
let firstCommitOid = "";
let secondCommitOid = "";

function gitSync(cwd: string, args: string[]): string {
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
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

beforeAll(() => {
  rootTmp = mkdtempSync(join(tmpdir(), "deskfolk-git-test-"));
  repoDir = join(rootTmp, "main-repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  gitSync(repoDir, ["init", "-b", "main"]);
  writeFileSync(join(repoDir, "README.md"), "# Hello\nline 2\n");
  writeFileSync(join(repoDir, "src", "app.ts"), "export const v = 1;\n");
  gitSync(repoDir, ["add", "."]);
  gitSync(repoDir, ["commit", "-m", "initial commit"]);
  firstCommitOid = gitSync(repoDir, ["rev-parse", "HEAD"]);

  // Feature branch commit for graph & merge-base tests.
  gitSync(repoDir, ["checkout", "-b", "feat/demo"]);
  writeFileSync(join(repoDir, "src", "app.ts"), "export const v = 2;\nexport const extra = true;\n");
  gitSync(repoDir, ["add", "src/app.ts"]);
  gitSync(repoDir, ["commit", "-m", "feat: update app (#42)"]);
  secondCommitOid = gitSync(repoDir, ["rev-parse", "HEAD"]);

  // Linked sibling worktree and nested worktree under `.wt/`.
  siblingWtDir = join(rootTmp, "wt-sibling");
  gitSync(repoDir, ["worktree", "add", "-b", "fix/sibling", siblingWtDir, "main"]);
  writeFileSync(join(siblingWtDir, "README.md"), "# Sibling dirty\n");

  nestedWtDir = join(repoDir, ".wt", "nested");
  gitSync(repoDir, ["worktree", "add", "--detach", nestedWtDir, firstCommitOid]);
  writeFileSync(join(nestedWtDir, "README.md"), "# Nested dirty\n");

  // Standalone nested repository inside `repoDir` to verify multi-repo discovery & session pairing.
  nestedRepoDir = join(repoDir, "nested-repo");
  mkdirSync(nestedRepoDir, { recursive: true });
  gitSync(nestedRepoDir, ["init", "-b", "dev"]);
  writeFileSync(join(nestedRepoDir, "index.ts"), "export const nested = true;\n");
  gitSync(nestedRepoDir, ["add", "."]);
  gitSync(nestedRepoDir, ["commit", "-m", "init nested repo"]);
  resetRepoDiscoveryCache();

  // Working tree changes on main repo: staged, unstaged, untracked, and binary untracked.
  writeFileSync(join(repoDir, "README.md"), "# Hello\nline 2\nline 3\n");
  writeFileSync(join(repoDir, "staged.txt"), "staged line\n");
  gitSync(repoDir, ["add", "staged.txt"]);
  writeFileSync(join(repoDir, "untracked.txt"), "brand new\nfile\n");
  writeFileSync(join(repoDir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
});

afterAll(() => {
  if (rootTmp) rmSync(rootTmp, { recursive: true, force: true });
});

describe("git engine", () => {
  test("validates commit oids and repo-relative paths strictly", () => {
    expect(isValidCommitOid(firstCommitOid)).toBe(true);
    expect(isValidCommitOid("abc1234")).toBe(true);
    expect(isValidCommitOid("main")).toBe(false);
    expect(isValidCommitOid("--exec=evil")).toBe(false);
    expect(isSafeRepoRelPath("src/app.ts")).toBe(true);
    expect(isSafeRepoRelPath("../escape")).toBe(false);
    expect(isSafeRepoRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRepoRelPath("a\0b")).toBe(false);
  });

  test("resolves repo root, subdirectory, multi-repo parent, nested standalone repo, and rejects foreign worktrees", async () => {
    expect(inspectGitMarker(repoDir)?.kind).toBe("repo");
    expect(inspectGitMarker(nestedWtDir)?.kind).toBe("worktree");
    expect(inspectGitMarker(nestedRepoDir)?.kind).toBe("repo");

    const rootRes = await resolveProjectRepo(repoDir);
    expect(rootRes.isRepo).toBe(true);
    expect(rootRes.repoId).toBe(".");
    expect(safeRealpath(rootRes.repoRoot!)).toBe(safeRealpath(repoDir));
    expect(rootRes.relativePrefix).toBe("");
    // Root repo + nested-repo discovered; `.wt/nested` is a linked worktree, NOT a separate repo.
    expect(rootRes.repos.map((r) => r.id)).toEqual([".", "nested-repo"]);

    const nestedRepoRes = await resolveProjectRepo(repoDir, { repo: "nested-repo" });
    expect(nestedRepoRes.repoId).toBe("nested-repo");
    expect(safeRealpath(nestedRepoRes.targetDir)).toBe(safeRealpath(nestedRepoDir));

    const subRes = await resolveProjectRepo(join(repoDir, "src"));
    expect(subRes.isRepo).toBe(true);
    expect(subRes.relativePrefix).toBe("src");

    // Multi-repo parent folder deduplicates `wt-sibling` (linked worktree of `main-repo`) by common dir.
    const parentRes = await resolveProjectRepo(rootTmp);
    expect(parentRes.isRepo).toBe(true);
    expect(parentRes.defaultWorktree).toBeNull();
    expect(parentRes.repos.map((r) => r.id)).toEqual(["main-repo"]);

    const wtRes = await resolveProjectRepo(repoDir, { worktree: nestedWtDir });
    expect(safeRealpath(wtRes.targetDir)).toBe(safeRealpath(nestedWtDir));

    // When repo and worktree disagree, worktree wins.
    const wtWins = await resolveProjectRepo(repoDir, { repo: "nested-repo", worktree: nestedWtDir });
    expect(wtWins.repoId).toBe(".");
    expect(safeRealpath(wtWins.targetDir)).toBe(safeRealpath(nestedWtDir));

    await expect(resolveProjectRepo(repoDir, { worktree: siblingWtDir })).rejects.toThrow("worktree is not part of this repository");
    await expect(resolveProjectRepo(repoDir, { worktree: "/tmp" })).rejects.toThrow("worktree is not part of this repository");
  });

  test("reads git summary with branch, counts, strips nested worktree untracked entries, and respects optional other-dirty flag", async () => {
    const summary = await readGitSummary(repoDir);
    expect(summary.is_repo).toBe(true);
    expect(summary.repo_id).toBe(".");
    expect(summary.branch).toBe("feat/demo");
    expect(summary.head_oid).toBe(secondCommitOid);
    expect(summary.staged_count).toBe(1);
    expect(summary.unstaged_count).toBe(1);
    expect(summary.untracked_count).toBeGreaterThanOrEqual(2);
    // Default summary skips sibling status fan-out.
    expect(summary.other_dirty_worktrees).toBe(0);
    expect(summary.signature.length).toBe(12);

    const withOther = await readGitSummary(repoDir, { includeOtherWorktrees: true });
    expect(withOther.other_dirty_worktrees).toBe(1);

    const siblingSummary = await readGitSummary(siblingWtDir, { includeOtherWorktrees: true });
    expect(siblingSummary.other_dirty_worktrees).toBe(0);

    // Nested `.wt/nested` must not show up as an untracked file in Changes.
    const working = await readGitChanges(repoDir, { base: "working" });
    expect(working.files.some((f) => f.path.startsWith(".wt/"))).toBe(false);
  });

  test("reads changes across working, staged, unstaged, and merge-base baselines", async () => {
    const working = await readGitChanges(repoDir, { base: "working" });
    const paths = working.files.map((f) => f.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("staged.txt");
    expect(paths).toContain("untracked.txt");

    const staged = await readGitChanges(repoDir, { base: "staged" });
    expect(staged.files.map((f) => f.path)).toEqual(["staged.txt"]);

    const mergeBase = await readGitChanges(repoDir, { base: "merge-base" });
    expect(mergeBase.base_ref).toBe("main");
    expect(mergeBase.files.map((f) => f.path)).toContain("src/app.ts");
  });

  test("reads single-file diffs for tracked, untracked, binary, and commit targets", async () => {
    const mod = await readGitDiff(repoDir, { path: "README.md", base: "working" });
    expect(mod.binary).toBe(false);
    expect(mod.patch).toContain("+line 3");

    const untracked = await readGitDiff(repoDir, { path: "untracked.txt", base: "working" });
    expect(untracked.untracked).toBe(true);
    expect(untracked.patch).toContain("+brand new");
    expect(untracked.patch).toContain("+file");

    const bin = await readGitDiff(repoDir, { path: "blob.bin", base: "working" });
    expect(bin.binary).toBe(true);
    expect(bin.patch).toBe("");

    const commitDiff = await readGitDiff(repoDir, { path: "src/app.ts", commit: secondCommitOid });
    expect(commitDiff.base).toBe("commit");
    expect(commitDiff.patch).toContain("+export const extra = true;");

    await expect(readGitDiff(repoDir, { path: "../secret", base: "working" })).rejects.toThrow("invalid repository-relative path");
  });

  test("lists worktrees and pairs nested worktree sessions to deepest worktree", async () => {
    const mapped = mapSessionsToWorktrees(
      [repoDir, siblingWtDir, nestedWtDir],
      [
        { id: "s-main", dir: join(repoDir, "src"), live: false },
        { id: "s-nested", dir: nestedWtDir, live: true },
        { id: "s-sibling", dir: siblingWtDir, live: false },
      ],
    );
    expect(mapped.get(repoDir)?.sessionIds).toEqual(["s-main"]);
    expect(mapped.get(nestedWtDir)?.sessionIds).toEqual(["s-nested"]);
    expect(mapped.get(nestedWtDir)?.liveSessionIds).toEqual(["s-nested"]);
    expect(mapped.get(siblingWtDir)?.sessionIds).toEqual(["s-sibling"]);

    const wt = await readGitWorktrees(repoDir, {
      sessions: [{ id: "s-nested", dir: nestedWtDir, live: true }],
    });
    expect(wt).not.toBeNull();
    // Only worktrees inside `repoDir` (main + nested), excluding `siblingWtDir` outside the project.
    expect(wt!.worktrees.length).toBe(2);
    expect(wt!.worktrees.some((w) => safeRealpath(w.path) === safeRealpath(siblingWtDir))).toBe(false);
    const main = wt!.worktrees.find((w) => safeRealpath(w.path) === safeRealpath(repoDir));
    expect(main?.is_main).toBe(true);
    expect(main?.is_current).toBe(true);
    const nested = wt!.worktrees.find((w) => safeRealpath(w.path) === safeRealpath(nestedWtDir));
    expect(nested?.detached).toBe(true);
    expect(nested?.dirty_count).toBe(1);
    expect(nested?.live_session_ids).toEqual(["s-nested"]);

    // Opening a linked external worktree as its own project shows only itself (and preserves is_main: false).
    const siblingOnly = await readGitWorktrees(siblingWtDir);
    expect(siblingOnly?.worktrees.length).toBe(1);
    expect(safeRealpath(siblingOnly!.worktrees[0]!.path)).toBe(safeRealpath(siblingWtDir));
    expect(siblingOnly!.worktrees[0]!.is_main).toBe(false);
    expect(siblingOnly!.worktrees[0]!.is_current).toBe(true);

    // Zero-status project tree pairs sessions across ALL discovered repos by deepest path.
    const tree = await readGitProjectTree(repoDir, {
      sessions: [
        { id: "s-main", dir: repoDir, live: false },
        { id: "s-nested-wt", dir: nestedWtDir, live: true },
        { id: "s-nested-repo", dir: nestedRepoDir, live: false },
      ],
    });
    expect(tree.repos.map((r) => r.id)).toEqual([".", "nested-repo"]);
    const rootTreeRepo = tree.repos[0]!;
    expect(rootTreeRepo.worktrees.length).toBe(2);
    expect(rootTreeRepo.worktrees.find((w) => w.is_main)?.session_ids).toEqual(["s-main"]);
    expect(rootTreeRepo.worktrees.find((w) => !w.is_main)?.session_ids).toEqual(["s-nested-wt"]);
    const childTreeRepo = tree.repos[1]!;
    expect(childTreeRepo.worktrees.length).toBe(1);
    expect(childTreeRepo.worktrees[0]!.session_ids).toEqual(["s-nested-repo"]);

    // Parent folder project boundary includes all 3 worktrees of `main-repo` (main + sibling + nested).
    const parentTree = await readGitProjectTree(rootTmp);
    expect(parentTree.default_worktree).toBeNull();
    expect(parentTree.repos.length).toBe(1);
    expect(parentTree.repos[0]!.worktrees.length).toBe(3);
  });

  test("reads commit log with in-project worktree markers and commit detail", async () => {
    const log = await readGitLog(repoDir, { scope: "branch", limit: 10 });
    expect(log).not.toBeNull();
    expect(log!.commits.length).toBeGreaterThanOrEqual(2);
    expect(log!.commits[0]!.oid).toBe(secondCommitOid);
    expect(log!.commits[0]!.subject).toBe("feat: update app (#42)");
    // First commit carries nested worktree badge, not the external sibling worktree outside repoDir.
    const baseCommit = log!.commits.find((c) => c.oid === firstCommitOid);
    const wtRefs = baseCommit?.refs.filter((r) => r.kind === "worktree") ?? [];
    expect(wtRefs.length).toBe(1);
    expect(wtRefs[0]!.name).toBe("wt:nested");

    const detail = await readGitCommitDetail(repoDir, secondCommitOid);
    expect(detail.oid).toBe(secondCommitOid);
    expect(detail.files.map((f) => f.path)).toEqual(["src/app.ts"]);
    expect(detail.files[0]!.additions).toBe(2);
    expect(detail.files[0]!.deletions).toBe(1);
  });

  test("clampDiffMaxBytes and boundDiffResponseBytes keep JSON wire payload below 1 MiB", () => {
    expect(clampDiffMaxBytes(undefined)).toBe(512 * 1024);
    expect(clampDiffMaxBytes(1024)).toBe(16 * 1024);
    expect(clampDiffMaxBytes(2_000_000)).toBe(700 * 1024);
    expect(clampDiffMaxBytes(200 * 1024)).toBe(200 * 1024);

    // Worst-case CJK + JSON-escaped quotes/backslashes whose UTF-8 JSON length expands >3x.
    const heavyLine = `+${"中文\\\"\\\\".repeat(80)}\n`;
    const hugePatch = heavyLine.repeat(2000);
    const bounded = boundDiffResponseBytes({
      path: "src/huge.ts",
      base: "working",
      commit: null,
      patch: hugePatch,
      binary: false,
      truncated: false,
      untracked: false,
      bytes: Buffer.byteLength(hugePatch, "utf8"),
      reason: null,
    });
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(900 * 1024);
  });

  test("stale repo and worktree return dedicated 422 error codes distinct from invalid_args", async () => {
    let repoErr: unknown = null;
    try {
      await resolveProjectRepo(repoDir, { repo: "does-not-exist" });
    } catch (err) {
      repoErr = err;
    }
    expect(repoErr).toBeInstanceOf(HttpError);
    expect((repoErr as HttpError).status).toBe(422);
    expect((repoErr as HttpError).code).toBe("git_repo_not_found");

    let wtErr: unknown = null;
    try {
      await resolveProjectRepo(repoDir, { worktree: join(repoDir, ".wt", "removed-branch") });
    } catch (err) {
      wtErr = err;
    }
    expect(wtErr).toBeInstanceOf(HttpError);
    expect((wtErr as HttpError).status).toBe(422);
    expect((wtErr as HttpError).code).toBe("git_worktree_not_found");
  });
});
