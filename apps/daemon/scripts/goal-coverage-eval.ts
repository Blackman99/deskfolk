#!/usr/bin/env bun
/**
 * Did a finished job deliver what it was asked for?
 *
 *   REAL_BOT_EVAL_API_KEY=sk-… bun scripts/goal-coverage-eval.ts \
 *     --base-url https://api.example.com/v1 --model judge-model \
 *     (--task <id> | --session <id> | --latest [n]) [--db <state.sqlite>] [--min-pass 0.8] [--out path]
 *
 * For each job it reads the plan's spec when the organizer has written one (goal, acceptance,
 * rules) and the opening request (`tasks.brief`), an excerpt of every file the job's
 * messages cited, and the Bots' last words, then asks one tool-less completion to judge each
 * requirement in the brief as covered, partial or missing, with evidence. The database is copied
 * first and the copy is opened, so the daemon may keep running on the original. Results print as a
 * Markdown report and are written as JSON under `.scratch/goal-coverage-eval/` (git-ignored). The
 * key never leaves the process.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_SUPPORT_DIRNAME, STATE_DB_NAME, USER_MEMBER } from "@real-bot/protocol";
import { deliveryExcerpt } from "../src/closing-check";
import { createCompletionsClient } from "../src/completions";
import {
  coverageScore,
  formatCoverageReport,
  GOAL_COVERAGE_SYSTEM,
  goalCoveragePayload,
  parseGoalCoverage,
  COVERAGE_EXCERPT_LIMIT,
  COVERAGE_MESSAGES,
  type GoalCoverage,
} from "../src/goal-coverage-eval";
import { memoryKeyStore } from "../src/secrets";
import { parsePlanSpec, Store, type Task } from "../src/store";

type Options = {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  db: string;
  task: string | null;
  session: string | null;
  latest: number;
  timeoutMs: number;
  out: string | null;
  minPass: number | null;
  help: boolean;
};

const DAEMON_DIR = resolve(import.meta.dir, "..");
const REPO_DIR = resolve(DAEMON_DIR, "../..");
const DEFAULT_DB = join(
  process.env.REAL_BOT_DATA_DIR ?? join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME),
  STATE_DB_NAME,
);

const HELP = `goal-coverage-eval — did a finished job deliver what its opening request asked for?

Required:
  --base-url <url>        OpenAI-compatible base URL (…/v1) of the judge
  --model <name>          judge model

Which jobs (one of):
  --task <id>             one job by id
  --session <id>          the session's most recently active job
  --latest [n]            the n most recently opened jobs (default 1)

Optional:
  --db <path>             state.sqlite to copy and read (default the daemon's own, or $REAL_BOT_DATA_DIR)
  --api-key-env <NAME>    env var holding the key (default REAL_BOT_EVAL_API_KEY)
  --timeout-ms <n>        per-completion first-byte timeout (default 120000)
  --out <path>            JSON output (default .scratch/goal-coverage-eval/<timestamp>.json)
  --min-pass <0..1>       exit 1 if any job's coverage is below this
  --help
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: "",
    model: "",
    apiKeyEnv: "REAL_BOT_EVAL_API_KEY",
    db: DEFAULT_DB,
    task: null,
    session: null,
    latest: 0,
    timeoutMs: 120_000,
    out: null,
    minPass: null,
    help: false,
  };
  const next = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    switch (flag) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--base-url":
        opts.baseUrl = next(flag, i++);
        break;
      case "--model":
        opts.model = next(flag, i++);
        break;
      case "--api-key-env":
        opts.apiKeyEnv = next(flag, i++);
        break;
      case "--db":
        opts.db = resolve(next(flag, i++));
        break;
      case "--task":
        opts.task = next(flag, i++);
        break;
      case "--session":
        opts.session = next(flag, i++);
        break;
      case "--latest": {
        const value = argv[i + 1];
        if (value !== undefined && !value.startsWith("--")) {
          const n = Number.parseInt(value, 10);
          if (!Number.isFinite(n) || n < 1) throw new Error("--latest takes a positive integer");
          opts.latest = n;
          i += 1;
        } else {
          opts.latest = 1;
        }
        break;
      }
      case "--timeout-ms": {
        const n = Number.parseInt(next(flag, i++), 10);
        if (!Number.isFinite(n) || n < 1000) throw new Error("--timeout-ms must be an integer >= 1000");
        opts.timeoutMs = n;
        break;
      }
      case "--out":
        opts.out = resolve(next(flag, i++));
        break;
      case "--min-pass": {
        const n = Number.parseFloat(next(flag, i++));
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("--min-pass must be between 0 and 1");
        opts.minPass = n;
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return opts;
}

function openCopy(source: string): { store: Store; dir: string } {
  if (!existsSync(source)) throw new Error(`no database at ${source}`);
  const dir = mkdtempSync(join(tmpdir(), "real-bot-goal-coverage-"));
  const copy = join(dir, STATE_DB_NAME);
  copyFileSync(source, copy);
  // WAL and shm hold writes the main file does not; without them the copy is an older state.
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${copy}${suffix}`);
  }
  return { store: new Store({ filename: copy, endpointKey: memoryKeyStore() }), dir };
}

function selectTasks(store: Store, opts: Options): Task[] {
  if (opts.task) return [store.getTask(opts.task)];
  if (opts.session) {
    const summary = store.sessionTasks(opts.session)[0];
    if (!summary) throw new Error(`session ${opts.session} has no job`);
    return [store.getTask(summary.id)];
  }
  if (opts.latest > 0) {
    return store.db
      .query<Task, [number]>(`SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(opts.latest);
  }
  throw new Error("pick jobs with --task, --session or --latest");
}

function lastWords(store: Store, taskId: string): Array<{ author: string; body: string }> {
  const rows = store.db
    .query<{ author: string; body: string }, [string, number]>(
      `SELECT author, body FROM messages WHERE task_id = ? AND kind = 'bot'
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(taskId, COVERAGE_MESSAGES)
    .reverse();
  return rows.map((row) => {
    let author = row.author;
    if (row.author !== USER_MEMBER) {
      try {
        author = store.getBot(row.author).name;
      } catch {
        author = row.author;
      }
    }
    return { author, body: row.body };
  });
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!opts.baseUrl || !opts.model) throw new Error("--base-url and --model are required");
  const apiKey = process.env[opts.apiKeyEnv];
  if (!apiKey) throw new Error(`set ${opts.apiKeyEnv}`);

  const { store, dir } = openCopy(opts.db);
  const results: Array<{
    task_id: string;
    title: string;
    dir: string;
    brief: string;
    goal: string | null;
    coverage: GoalCoverage | null;
    score: number | null;
    error: string | null;
  }> = [];
  try {
    const root = store.workspacePath();
    const client = createCompletionsClient();
    for (const task of selectTasks(store, opts)) {
      const brief = task.brief ?? "";
      const spec = parsePlanSpec(task.spec);
      const goal = spec?.goal ?? null;
      if (!brief && !spec) {
        results.push({ task_id: task.id, title: task.title, dir: task.dir, brief, goal, coverage: null, score: null, error: "plan has neither a spec nor a brief" });
        continue;
      }
      const deliveries = root
        ? store.taskArtifacts(task.id, (relpath) => existsSync(join(root, relpath))).map((row) => ({
            path: row.path,
            excerpt: deliveryExcerpt(root, row.path, COVERAGE_EXCERPT_LIMIT).excerpt,
          }))
        : [];
      const payload = goalCoveragePayload({
        brief,
        plan: spec ? { goal: spec.goal, acceptance: spec.acceptance, rules: spec.rules } : null,
        deliveries,
        finalMessages: lastWords(store, task.id),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs * 3);
      let raw: string | null = null;
      let error: string | null = null;
      try {
        const answer = await client.judge({
          baseUrl: opts.baseUrl,
          apiKey,
          model: opts.model,
          messages: [
            { role: "system", content: GOAL_COVERAGE_SYSTEM },
            { role: "user", content: JSON.stringify(payload) },
          ],
          signal: controller.signal,
          timeoutMs: opts.timeoutMs,
        });
        if (answer.failKind && answer.failKind !== "incomplete") error = `completion failed: ${answer.failKind}`;
        raw = answer.content;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        clearTimeout(timer);
      }
      const coverage = raw ? parseGoalCoverage(raw) : null;
      if (!coverage && !error) error = "the judge did not answer in the expected shape";
      results.push({
        task_id: task.id,
        title: task.title,
        dir: task.dir,
        brief,
        goal,
        coverage,
        score: coverage ? coverageScore(coverage) : null,
        error,
      });
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const report: string[] = [`# Goal coverage — ${opts.model}`, ""];
  for (const row of results) {
    if (row.coverage) {
      report.push(formatCoverageReport({ title: row.goal ?? row.title, dir: row.dir, model: opts.model, coverage: row.coverage }), "");
    } else {
      report.push(`## ${row.title}`, "", `- 工作目录：\`${row.dir}\``, `- 未评判：${row.error ?? "unknown"}`, "");
    }
  }
  process.stdout.write(`${report.join("\n")}\n`);

  const out =
    opts.out ?? join(REPO_DIR, ".scratch", "goal-coverage-eval", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ model: opts.model, base_url: opts.baseUrl, results }, null, 2));
  process.stderr.write(`wrote ${out}\n`);

  if (opts.minPass !== null) {
    const below = results.filter((row) => row.score === null || row.score < opts.minPass!);
    if (below.length > 0) {
      process.stderr.write(`${below.length} job(s) below ${opts.minPass}\n`);
      return 1;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
