/**
 * Verify the current HEAD on a candidate branch across GitHub Actions before fast-forwarding
 * `main`, so Windows and Linux CI failures are caught before `main` moves.
 *
 *   pnpm land [--all] [--dry-run] [--no-watch] [--no-delete] [--branch <name>]
 *
 * By default it triggers `ci.yml` and `windows.yml`, plus `nsh-desktop.yml` whenever commits
 * ahead of `origin/main` touch `apps/desktop-nsh/`, `apps/daemon/`, `packages/protocol/`,
 * `.github/workflows/nsh-desktop.yml`, or `scripts/linux-desktop-deps.sh` (or with `--all`).
 * Never force-pushes and never modifies another checkout's working tree.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const all = args.includes("--all");
const noWatch = args.includes("--no-watch");
const noDelete = args.includes("--no-delete");
const branchFlagIndex = args.indexOf("--branch");
const customBranch = branchFlagIndex >= 0 ? args[branchFlagIndex + 1] : undefined;

const DESKTOP_TRIGGER = /^(apps\/desktop-nsh\/|apps\/daemon\/|packages\/protocol\/|\.github\/workflows\/nsh-desktop\.yml$|scripts\/linux-desktop-deps\.sh$)/;

function run(cmd: string, cmdArgs: string[], opts: { allowFail?: boolean; inherit?: boolean } = {}): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
  });
  const ok = res.status === 0;
  if (!ok && !opts.allowFail) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (exit ${res.status})${detail ? `:\n${detail}` : ""}`);
  }
  return { ok, stdout: (res.stdout ?? "").trim(), stderr: (res.stderr ?? "").trim() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

type RunSummary = {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
};

async function findRunForSha(workflow: string, branch: string, sha: string, sinceMs: number): Promise<RunSummary> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { stdout } = run("gh", [
      "run", "list",
      "--workflow", workflow,
      "--branch", branch,
      "--event", "workflow_dispatch",
      "--limit", "10",
      "--json", "databaseId,headSha,status,conclusion,url,createdAt",
    ]);
    const rows = JSON.parse(stdout || "[]") as Array<RunSummary & { createdAt: string }>;
    const match = rows.find((row) => row.headSha === sha && Date.parse(row.createdAt) >= sinceMs - 10_000);
    if (match) return match;
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for ${workflow} run on ${branch} (${sha.slice(0, 8)}) to appear`);
}

function main(): Promise<void> {
  return (async () => {
    const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]).stdout;
    if (dirty) {
      throw new Error("Working tree has uncommitted tracked changes. Commit or stash them before running `pnpm land`.");
    }

    run("git", ["fetch", "origin", "main"], { inherit: true });
    const headSha = run("git", ["rev-parse", "HEAD"]).stdout;
    const shortSha = headSha.slice(0, 8);
    const originMain = run("git", ["rev-parse", "origin/main"]).stdout;

    if (headSha === originMain) {
      console.log(`HEAD (${shortSha}) is already at origin/main; nothing to land.`);
      return;
    }

    const isAncestor = run("git", ["merge-base", "--is-ancestor", originMain, headSha], { allowFail: true }).ok;
    if (!isAncestor) {
      throw new Error(`origin/main (${originMain.slice(0, 8)}) has commits not in HEAD (${shortSha}). Rebase or merge first.`);
    }

    const changed = run("git", ["diff", "--name-only", `${originMain}..${headSha}`]).stdout.split(/\r?\n/).filter(Boolean);
    const workflows = ["ci.yml", "windows.yml"];
    if (all || changed.some((file) => DESKTOP_TRIGGER.test(file))) {
      workflows.push("nsh-desktop.yml");
    }

    const branch = customBranch || `land/${shortSha}`;
    console.log(`Commit:    ${shortSha} (${changed.length} file(s) changed vs origin/main)`);
    console.log(`Branch:    ${branch}`);
    console.log(`Workflows: ${workflows.join(", ")}`);

    if (dryRun) {
      console.log("[dry-run] No push or workflow dispatch executed.");
      return;
    }

    run("git", ["push", "origin", `${headSha}:refs/heads/${branch}`], { inherit: true });

    const dispatchedAt = Date.now();
    for (const wf of workflows) {
      console.log(`Dispatching ${wf} on ${branch}...`);
      run("gh", ["workflow", "run", wf, "--ref", branch], { inherit: true });
    }

    const runs: Array<{ workflow: string; run: RunSummary }> = [];
    for (const wf of workflows) {
      const found = await findRunForSha(wf, branch, headSha, dispatchedAt);
      console.log(`  ${wf}: ${found.url}`);
      runs.push({ workflow: wf, run: found });
    }

    if (noWatch) {
      console.log("--no-watch set: leaving candidate branch up and not advancing main.");
      return;
    }

    console.log("\nWatching all workflow runs in parallel...");
    const watchers = runs.map(({ workflow, run: r }) => {
      const proc = Bun.spawn(["gh", "run", "watch", String(r.databaseId), "--exit-status"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return proc.exited.then(async (code) => {
        const stderr = await new Response(proc.stderr).text();
        return { workflow, id: r.databaseId, url: r.url, ok: code === 0, stderr: stderr.trim() };
      });
    });

    const results = await Promise.all(watchers);
    const failed = results.filter((r) => !r.ok);
    for (const r of results) {
      console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.workflow} (${r.url})`);
    }

    if (failed.length > 0) {
      console.error(`\nCandidate CI failed on ${branch}; main was NOT updated.`);
      console.error(`Delete the branch when done: git push origin :refs/heads/${branch}`);
      process.exit(1);
    }

    console.log("\nAll candidate workflows passed. Fast-forwarding origin/main...");
    const pushed = run("git", ["push", "origin", `${headSha}:refs/heads/main`], { allowFail: true, inherit: true });
    if (!pushed.ok) {
      console.error("Could not fast-forward origin/main (origin/main moved while CI was running). Rebase and re-run `pnpm land`; never force-push.");
      process.exit(1);
    }

    if (!noDelete) {
      run("git", ["push", "origin", `:refs/heads/${branch}`], { allowFail: true, inherit: true });
    }
    console.log(`Landed ${shortSha} on main.`);
  })();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
