#!/usr/bin/env bun
/**
 * Run the tool-selection cases against one or more models on an OpenAI-compatible endpoint.
 *
 *   REAL_BOT_EVAL_API_KEY=sk-… bun scripts/tool-selection-eval.ts \
 *     --base-url https://api.example.com/v1 --model model-a --model model-b [--repeat 3]
 *
 * Each case is one completion with the same system prompt and tools array a real direct-session
 * turn would send; only the first tool call is judged (plus forbidden calls anywhere in the
 * completion). Results print as a Markdown report and are written as JSON under
 * `.scratch/tool-selection-eval/` (git-ignored). The key never leaves the process.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { THINKING_LEVELS, type Locale, type ThinkingLevel } from "@real-bot/protocol";
import { createCompletionsClient } from "../src/completions";
import {
  buildEvalTurn,
  EVAL_CATEGORIES,
  formatReport,
  rate,
  scoreCompletion,
  summarize,
  validateCases,
  type EvalCase,
  type EvalCategory,
  type EvalRow,
} from "../src/tool-selection-eval";

type Options = {
  baseUrl: string;
  models: string[];
  apiKeyEnv: string;
  thinking: ThinkingLevel;
  repeat: number;
  cases: string;
  only: string[];
  category: EvalCategory | null;
  locale: Locale | null;
  out: string | null;
  concurrency: number;
  timeoutMs: number;
  minPass: number | null;
  help: boolean;
};

const DAEMON_DIR = resolve(import.meta.dir, "..");
const REPO_DIR = resolve(DAEMON_DIR, "../..");
const DEFAULT_CASES = join(DAEMON_DIR, "eval", "tool-selection-cases.json");

const HELP = `tool-selection-eval — does a Bot read the right skill / pick the right tool first?

Required:
  --base-url <url>        OpenAI-compatible base URL (…/v1)
  --model <name>          model to run; repeat the flag for several models

Optional:
  --api-key-env <NAME>    env var holding the key (default REAL_BOT_EVAL_API_KEY)
  --thinking <level>      ${THINKING_LEVELS.join(" | ")} (default none)
  --repeat <n>            attempts per case per model (default 1)
  --cases <path>          cases file (default apps/daemon/eval/tool-selection-cases.json)
  --only <id,id>          run only these case ids
  --category <name>       ${EVAL_CATEGORIES.join(" | ")}
  --locale <zh|en>
  --concurrency <n>       parallel completions (default 2)
  --timeout-ms <n>        per-completion timeout (default 120000)
  --out <path>            JSON output (default .scratch/tool-selection-eval/<timestamp>.json)
  --min-pass <0..1>       exit 1 if any model's overall pass rate is below this
  --help
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: "",
    models: [],
    apiKeyEnv: "REAL_BOT_EVAL_API_KEY",
    thinking: "none",
    repeat: 1,
    cases: DEFAULT_CASES,
    only: [],
    category: null,
    locale: null,
    out: null,
    concurrency: 2,
    timeoutMs: 120_000,
    minPass: null,
    help: false,
  };
  const next = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  const int = (flag: string, raw: string, min: number): number => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}`);
    return n;
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
        opts.models.push(next(flag, i++));
        break;
      case "--api-key-env":
        opts.apiKeyEnv = next(flag, i++);
        break;
      case "--thinking": {
        const level = next(flag, i++);
        if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
          throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
        }
        opts.thinking = level as ThinkingLevel;
        break;
      }
      case "--repeat":
        opts.repeat = int(flag, next(flag, i++), 1);
        break;
      case "--cases":
        opts.cases = resolve(next(flag, i++));
        break;
      case "--only":
        opts.only = next(flag, i++)
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      case "--category": {
        const cat = next(flag, i++);
        if (!(EVAL_CATEGORIES as readonly string[]).includes(cat)) {
          throw new Error(`--category must be one of ${EVAL_CATEGORIES.join(", ")}`);
        }
        opts.category = cat as EvalCategory;
        break;
      }
      case "--locale": {
        const loc = next(flag, i++);
        if (loc !== "zh" && loc !== "en") throw new Error("--locale must be zh or en");
        opts.locale = loc;
        break;
      }
      case "--concurrency":
        opts.concurrency = int(flag, next(flag, i++), 1);
        break;
      case "--timeout-ms":
        opts.timeoutMs = int(flag, next(flag, i++), 1000);
        break;
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

function selectCases(all: EvalCase[], opts: Options): EvalCase[] {
  let cases = all;
  if (opts.only.length > 0) {
    const wanted = new Set(opts.only);
    const missing = opts.only.filter((id) => !all.some((c) => c.id === id));
    if (missing.length > 0) throw new Error(`--only names unknown cases: ${missing.join(", ")}`);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  if (opts.category) cases = cases.filter((c) => c.category === opts.category);
  if (opts.locale) cases = cases.filter((c) => c.locale === opts.locale);
  return cases;
}

async function runPool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!opts.baseUrl) throw new Error("--base-url is required (see --help)");
  if (opts.models.length === 0) throw new Error("at least one --model is required (see --help)");
  const apiKey = process.env[opts.apiKeyEnv];
  if (!apiKey) throw new Error(`env ${opts.apiKeyEnv} is empty; export the endpoint key there`);

  const raw: unknown = JSON.parse(readFileSync(opts.cases, "utf8"));
  const cases = selectCases(validateCases(raw, opts.cases), opts);
  if (cases.length === 0) throw new Error("no cases selected");

  const client = createCompletionsClient({ originLimit: opts.concurrency });
  const rows: EvalRow[] = [];
  const tasks: Array<() => Promise<void>> = [];
  for (const model of opts.models) {
    for (const c of cases) {
      for (let attempt = 1; attempt <= opts.repeat; attempt += 1) {
        tasks.push(async () => {
          const turn = buildEvalTurn(c);
          const started = Date.now();
          const result = await client.complete({
            baseUrl: opts.baseUrl,
            apiKey,
            model,
            thinkingLevel: opts.thinking,
            messages: turn.messages,
            tools: turn.tools,
            signal: AbortSignal.timeout(opts.timeoutMs),
          });
          const outcome = scoreCompletion(c, result, turn.toolNames);
          const row: EvalRow = {
            model,
            caseId: c.id,
            category: c.category,
            locale: c.locale,
            attempt,
            ms: Date.now() - started,
            outcome,
          };
          rows.push(row);
          const mark = outcome.pass ? "pass" : "FAIL";
          const tail = outcome.pass ? "" : ` — ${outcome.reason ?? ""}`;
          console.log(`[${model}] ${c.id} #${attempt} ${mark} (${row.ms} ms) got=${outcome.got}${tail}`);
        });
      }
    }
  }
  console.log(`running ${tasks.length} completions (${cases.length} cases × ${opts.models.length} models × ${opts.repeat})…`);
  await runPool(tasks, opts.concurrency);

  rows.sort((a, b) => a.model.localeCompare(b.model) || a.caseId.localeCompare(b.caseId) || a.attempt - b.attempt);
  const summaries = summarize(rows);
  console.log("");
  console.log(formatReport(summaries, rows));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = opts.out ?? join(REPO_DIR, ".scratch", "tool-selection-eval", `${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        base_url: opts.baseUrl,
        models: opts.models,
        thinking: opts.thinking,
        repeat: opts.repeat,
        cases: cases.map((c) => c.id),
        summary: summaries,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${outPath}`);

  if (opts.minPass !== null) {
    const below = summaries.filter((s) => s.overall.total > 0 && s.overall.passed / s.overall.total < opts.minPass!);
    if (below.length > 0) {
      console.error(`below --min-pass ${opts.minPass}: ${below.map((s) => `${s.model} ${rate(s.overall)}`).join(", ")}`);
      return 1;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
