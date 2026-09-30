#!/usr/bin/env bun
/**
 * How often does a team of Bots see one job through to delivery, on the golden path?
 *
 *   REAL_BOT_EVAL_API_KEY=sk-… bun scripts/golden-path-eval.ts \
 *     --base-url https://api.example.com/v1 --model team-model [--judge-model judge-model] \
 *     [--only research,small-tool] [--setup manual|coordinator|solo|both|all] [--ablate spec]… \
 *     [--runs 1] [--timeout-min 30] \
 *     [--approvals deny|allow-once] [--min-pass 0.8] [--min-rate 0.7] [--price 0.5,2] [--out dir]
 *
 * For every task × setup × run it starts an isolated runtime in this process (its own data dir
 * under the output folder, its own free port, an in-memory keystore, never the Keychain, never the
 * daemon you are running), points it at the endpoint through the local API, seeds the workspace
 * with the task's files, forms the team — `manual`: you create the role Bots and a group;
 * `coordinator`: you create one Coordinator and ask it, in your direct, to hire them and open a
 * group — posts the task in the group without an @, and waits until the job settles or the clock
 * runs out. Then it runs the task's checks, asks the goal-coverage judge (the same prompt as
 * `eval:goal-coverage`) whether the delivery covers the brief, and counts what needed you.
 *
 * A Markdown summary and a JSON file land in `.scratch/golden-path-eval/<timestamp>/` (git-ignored)
 * with every run's data dir and workspace beside them. The key is read from an env var, handed to
 * a re-executed copy of this script on stdin (so no Bot shell can read it from the environment),
 * and never written anywhere.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ablationLabel, ablationList, AblationError, NO_ABLATION, parseAblation, type Ablation } from "../src/ablation";
import { createCompletionsClient } from "../src/completions";
import { scrubbedEnv } from "./golden-path/env";
import { aggregate, formatDuration, formatSummary, type RunResult, type SummaryMeta } from "./golden-path/report";
import { runOnce, type RunOptions } from "./golden-path/run";
import { loadTaskSet, parseSetups, requireSetups, selectTasks, type Setup } from "./golden-path/tasks";

type Options = {
  baseUrl: string;
  model: string;
  judgeModel: string | null;
  apiKeyEnv: string;
  tasks: string;
  only: string[] | null;
  setups: Setup[];
  ablations: Ablation[];
  runs: number;
  timeoutMin: number;
  judgeTimeoutMs: number;
  approvals: "allow-once" | "deny";
  minPass: number;
  minRate: number | null;
  price: RunOptions["price"];
  out: string | null;
  list: boolean;
  keyStdin: boolean;
  help: boolean;
};

const DAEMON_DIR = resolve(import.meta.dir, "..");
const REPO_DIR = resolve(DAEMON_DIR, "../..");
const DEFAULT_TASKS = join(DAEMON_DIR, "eval", "golden-path", "tasks.json");

const HELP = `golden-path-eval — how often a team of Bots delivers a whole job on the golden path

Required:
  --base-url <url>        OpenAI-compatible base URL (…/v1) the team (and the judge) run on
  --model <name>          the team's model: every Bot, the organizer, judgements and checks

Optional:
  --judge-model <name>    goal-coverage judge model (default: --model)
  --api-key-env <NAME>    env var holding the key (default REAL_BOT_EVAL_API_KEY)
  --tasks <file>          task set (default apps/daemon/eval/golden-path/tasks.json)
  --only <id,…>           only these task ids (also the only way to run a task marked "extra" —
                          left out of the default selection, e.g. the L/S/R/G benchmark families)
  --setup <which>         manual | coordinator | solo | both | all, comma-separated (default both)
  --ablate <spec>         repeatable: a side-call switch or group to turn off, comma/+ separated
                          (none | organizer | calls | nudges | bare | organize-message |
                           organize-settle | closing-check | route-pick | review | learning |
                           judgement | plan-nudge | direct-report); default: one condition, none
  --runs <n>              runs per task × setup × ablation (default 1)
  --timeout-min <n>       wall clock per run from your first message (default 30)
  --judge-timeout-ms <n>  judge first-byte timeout (default 120000)
  --approvals <how>       deny | allow-once — how approval cards are answered (default deny); counted either way
  --min-pass <0..1>       coverage a run needs to count as completed (default 0.8)
  --min-rate <0..1>       exit 1 if the completion rate is below this
  --price <in,out[,cached]>  USD per million tokens, so spend rows carry an estimate
  --out <dir>             output folder (default .scratch/golden-path-eval/<timestamp>/)
  --list                  validate the task set and print what would run; runs nothing
  --key-stdin             read the key from stdin instead of the env var
  --help

Exit: 0 when the benchmark ran (whatever the rate), 1 when --min-rate is given and not met,
2 on bad arguments or a runner failure, 130 when interrupted.
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: "",
    model: "",
    judgeModel: null,
    apiKeyEnv: "REAL_BOT_EVAL_API_KEY",
    tasks: DEFAULT_TASKS,
    only: null,
    setups: parseSetups("both"),
    ablations: [NO_ABLATION],
    runs: 1,
    timeoutMin: 30,
    judgeTimeoutMs: 120_000,
    approvals: "deny",
    minPass: 0.8,
    minRate: null,
    price: null,
    out: null,
    list: false,
    keyStdin: false,
    help: false,
  };
  const next = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  const fraction = (flag: string, value: string): number => {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${flag} must be between 0 and 1`);
    return n;
  };
  let ablateGiven = false;
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
      case "--judge-model":
        opts.judgeModel = next(flag, i++);
        break;
      case "--api-key-env":
        opts.apiKeyEnv = next(flag, i++);
        break;
      case "--tasks":
        opts.tasks = resolve(next(flag, i++));
        break;
      case "--only":
        opts.only = next(flag, i++).split(",").map((id) => id.trim()).filter(Boolean);
        break;
      case "--setup":
        opts.setups = parseSetups(next(flag, i++));
        break;
      case "--ablate": {
        const value = next(flag, i++);
        if (!ablateGiven) {
          opts.ablations = [];
          ablateGiven = true;
        }
        try {
          opts.ablations.push(parseAblation(value));
        } catch (error) {
          throw error instanceof AblationError ? new Error(`--ablate: ${error.message}`) : error;
        }
        break;
      }
      case "--runs": {
        const n = Number.parseInt(next(flag, i++), 10);
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("--runs must be an integer from 1 to 50");
        opts.runs = n;
        break;
      }
      case "--timeout-min": {
        const n = Number.parseFloat(next(flag, i++));
        if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) throw new Error("--timeout-min must be a positive number of minutes");
        opts.timeoutMin = n;
        break;
      }
      case "--judge-timeout-ms": {
        const n = Number.parseInt(next(flag, i++), 10);
        if (!Number.isFinite(n) || n < 1000) throw new Error("--judge-timeout-ms must be an integer >= 1000");
        opts.judgeTimeoutMs = n;
        break;
      }
      case "--approvals": {
        const value = next(flag, i++);
        if (value !== "deny" && value !== "allow-once") throw new Error("--approvals must be deny or allow-once");
        opts.approvals = value;
        break;
      }
      case "--min-pass":
        opts.minPass = fraction(flag, next(flag, i++));
        break;
      case "--min-rate":
        opts.minRate = fraction(flag, next(flag, i++));
        break;
      case "--price": {
        const parts = next(flag, i++).split(",").map((part) => Number.parseFloat(part));
        if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
          throw new Error("--price takes input,output[,cached_input] in USD per million tokens");
        }
        opts.price = { input: parts[0]!, output: parts[1]!, ...(parts[2] !== undefined ? { cached_input: parts[2] } : {}) };
        break;
      }
      case "--out":
        opts.out = resolve(next(flag, i++));
        break;
      case "--list":
        opts.list = true;
        break;
      case "--key-stdin":
        opts.keyStdin = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  const seenLabels = new Set<string>();
  opts.ablations = opts.ablations.filter((ablation) => {
    const label = ablationLabel(ablation);
    if (seenLabels.has(label)) return false;
    seenLabels.add(label);
    return true;
  });
  return opts;
}

/** The base URL as shown in the report: no userinfo, no query. */
function shownUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function commit(): string | null {
  const run = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_DIR, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() || null : null;
}

/**
 * Runs this script again without the key (or anything else that looks like a secret) in its
 * environment, and hands the key over on stdin. Bot shells inherit the process's starting
 * environment, so this is the only way to keep the key out of their reach.
 */
async function reexec(argv: string[], key: string, keyEnv: string): Promise<number> {
  const child = Bun.spawn([process.execPath, import.meta.path, ...argv, "--key-stdin"], {
    env: scrubbedEnv(process.env, keyEnv),
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  child.stdin.write(`${key}\n`);
  await child.stdin.end();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    });
  }
  return await child.exited;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const loaded = loadTaskSet(opts.tasks);
  const tasks = selectTasks(loaded.set, opts.only);
  requireSetups(tasks, opts.setups);
  // Run index outermost, then task, then setup, then ablation: interleaved, so an interrupt after a
  // handful of runs still leaves a spread across every cell instead of finishing one cell first.
  const matrix: Array<{ task: (typeof tasks)[number]; setup: Setup; ablation: Ablation; index: number }> = [];
  for (let i = 1; i <= opts.runs; i += 1) {
    for (const task of tasks) {
      for (const setup of opts.setups) {
        for (const ablation of opts.ablations) {
          matrix.push({ task, setup, ablation, index: i });
        }
      }
    }
  }
  if (opts.list) {
    process.stdout.write(
      `${tasks.length} task(s) × ${opts.setups.length} setup(s) × ${opts.ablations.length} ablation(s) × ${opts.runs} run(s) = ${matrix.length} run(s)\n`,
    );
    for (const task of tasks) {
      const manual = task.setups.manual;
      const parts = [`  ${task.id.padEnd(12)} ${task.title}`];
      if (manual) parts.push(`    manual: group ${manual.group} with ${manual.bots.map((b) => b.name).join(", ")}`);
      if (task.setups.coordinator) parts.push(`    coordinator: ${task.setups.coordinator.bot.name} hires them`);
      if (task.setups.solo) parts.push(`    solo: ${task.setups.solo.bot.name} alone in your direct`);
      parts.push(`    delivers: ${task.deliverables.join(", ")}; ${task.checks.length} content check(s), ${task.verify.length} command(s) run afterwards`);
      if (task.mcp) parts.push(`    mcp: media fixture, video_polls=${task.mcp.video_polls}`);
      if (task.script.length > 0) {
        const labelled = task.script.filter((step) => step.expect_plan !== null).length;
        parts.push(`    script: ${task.script.length} step(s)${labelled ? `, ${labelled} labelled (attribution)` : ""}`);
      }
      process.stdout.write(`${parts.join("\n")}\n`);
    }
    const showAblations = opts.ablations.length > 1 || opts.ablations.some((a) => ablationLabel(a) !== "none");
    if (showAblations) {
      process.stdout.write("ablations:\n");
      for (const ablation of opts.ablations) {
        const label = ablationLabel(ablation);
        const off = ablationList(ablation);
        process.stdout.write(`  ${label}: ${off.length ? off.join(", ") : "(nothing off)"}\n`);
      }
    }
    if (opts.setups.includes("solo")) {
      process.stdout.write("note: judgement has no effect on solo (a direct has only one Bot, nothing to decide)\n");
    }
    process.stdout.write(`Each run spends up to ${opts.timeoutMin} min of team turns plus one judge call. --list runs nothing.\n`);
    return 0;
  }
  if (!opts.baseUrl || !opts.model) throw new Error("--base-url and --model are required");
  shownUrl(opts.baseUrl);
  if (!opts.keyStdin) {
    const key = process.env[opts.apiKeyEnv];
    if (!key) throw new Error(`set ${opts.apiKeyEnv}`);
    return reexec(argv, key, opts.apiKeyEnv);
  }
  const apiKey = (await Bun.stdin.text()).trim();
  if (!apiKey) throw new Error("--key-stdin: no key on stdin");

  let aborting = false;
  let abortedAt = 0;
  const onSignal = (): void => {
    const now = Date.now();
    if (!aborting) {
      aborting = true;
      abortedAt = now;
      process.stderr.write("\nstopping: this run is cleaned up and the results so far are written; interrupt again to quit now\n");
      return;
    }
    // The terminal and the parent both deliver the first interrupt; only a later one quits.
    if (now - abortedAt > 1500) process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const startedAt = new Date();
  const outDir = opts.out ?? join(REPO_DIR, ".scratch", "golden-path-eval", startedAt.toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const judgeModel = opts.judgeModel ?? opts.model;
  const runOptions: RunOptions = {
    baseUrl: opts.baseUrl,
    apiKey,
    model: opts.model,
    judgeModel,
    timeoutMs: opts.timeoutMin * 60_000,
    judgeTimeoutMs: opts.judgeTimeoutMs,
    approvals: opts.approvals,
    minPass: opts.minPass,
    price: opts.price,
    client: createCompletionsClient(),
    aborted: () => aborting,
    log: (line) => process.stderr.write(`${line}\n`),
  };
  const version = (JSON.parse(readFileSync(join(DAEMON_DIR, "package.json"), "utf8")) as { version?: string }).version ?? null;
  const metaBase = {
    model: opts.model,
    judge_model: judgeModel,
    base_url: shownUrl(opts.baseUrl),
    started_at: startedAt.toISOString(),
    timeout_min: opts.timeoutMin,
    approvals: opts.approvals,
    min_pass: opts.minPass,
    commit: commit(),
    tasks_file: relative(REPO_DIR, loaded.file),
  };
  const results: RunResult[] = [];
  const ablationsMeta = Object.fromEntries(opts.ablations.map((a) => [ablationLabel(a), ablationList(a)]));
  const write = (): string => {
    const meta: SummaryMeta = { ...metaBase, finished_at: new Date().toISOString() };
    const agg = aggregate(results);
    const summary = formatSummary({ meta, aggregate: agg, runs: results });
    writeFileSync(join(outDir, "summary.md"), summary);
    writeFileSync(
      join(outDir, "results.json"),
      JSON.stringify(
        { meta: { ...meta, version, runs_per_cell: opts.runs, setups: opts.setups, ablations: ablationsMeta, min_rate: opts.minRate }, aggregate: agg, runs: results },
        null,
        2,
      ),
    );
    return summary;
  };
  process.stderr.write(`golden-path-eval: ${matrix.length} run(s) on ${opts.model} → ${outDir}\n`);
  for (const cell of matrix) {
    if (aborting) break;
    const result = await runOnce({ loaded, task: cell.task, setup: cell.setup, ablation: cell.ablation, index: cell.index, outDir, opts: runOptions });
    results.push(result);
    write();
    const score = result.score === null ? "not judged" : `coverage ${Math.round(result.score * 100)}%`;
    const ablationTag = ablationLabel(cell.ablation) === "none" ? "" : `--${ablationLabel(cell.ablation)}`;
    process.stderr.write(
      `[${cell.task.id}/${cell.setup}${ablationTag}#${cell.index}] ${result.outcome} in ${formatDuration(result.wall_ms)} · ${score} · checks ${result.checks.filter((c) => c.ok).length}/${result.checks.length} · interventions ${result.interventions.total} → ${result.completed ? "completed" : "not completed"}\n`,
    );
  }
  const summary = write();
  process.stdout.write(summary);
  process.stderr.write(`wrote ${join(outDir, "summary.md")} and results.json\n`);
  if (aborting) return 130;
  if (opts.minRate !== null) {
    const rate = aggregate(results).overall.rate;
    if (rate < opts.minRate) {
      process.stderr.write(`completion rate ${Math.round(rate * 100)}% is below ${Math.round(opts.minRate * 100)}%\n`);
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
