#!/usr/bin/env bun
/**
 * How often does a model actually call the tool it was offered — end_turn / submit / work_on —
 * instead of just saying it will and stopping? The contract P4b/P4c introduce needs this answered
 * before it lands (the gate ADR 0040 sets for entering P4b: bounce rate < 10%). Runs the fixed case bank in
 * `eval/protocol-probe-cases.json` against a real endpoint, one completion per case, and up to
 * `--max-retries` more with a nudge message when the model did not comply.
 *
 *   REAL_BOT_EVAL_API_KEY=sk-… bun scripts/protocol-probe.ts \
 *     --base-url https://api.example.com/v1 --model grk-4.7-build-fast --model gemini-3.8-flash-high
 *
 * `--dry-run` runs the same pipeline against a small scripted client instead of the network, so the
 * case bank and the scoring can be checked with no key and no spend. A Markdown report prints and a
 * JSON file is written to `.scratch/protocol-probe/<timestamp>.json` (git-ignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isThinkingLevel, type ThinkingLevel } from "@real-bot/protocol";
import type { ChatMessage, CompletionResult, CompletionsClient } from "../src/completions";
import { createCompletionsClient } from "../src/completions";
import {
  BOUNCE_GATE,
  buildProbeTurn,
  formatReport,
  nudge,
  readAttempt,
  scoreCase,
  summarize,
  validateCases,
  type AttemptResult,
  type ProtocolCase,
  type ProtocolCaseResult,
  type ProtocolSummary,
} from "../src/protocol-probe";

type Options = {
  baseUrl: string;
  models: string[];
  apiKeyEnv: string;
  thinking: ThinkingLevel;
  cases: string;
  maxRetries: number;
  timeoutMs: number;
  out: string | null;
  dryRun: boolean;
  help: boolean;
};

const DAEMON_DIR = resolve(import.meta.dir, "..");
const REPO_DIR = resolve(DAEMON_DIR, "../..");
const DEFAULT_CASES = join(DAEMON_DIR, "eval", "protocol-probe-cases.json");

const HELP = `protocol-probe — does a model actually call the tool it was offered?

Required (unless --dry-run):
  --base-url <url>        OpenAI-compatible base URL (…/v1)
  --model <name>          model to probe; repeat the flag for several

Optional:
  --api-key-env <NAME>    env var holding the key (default REAL_BOT_EVAL_API_KEY)
  --thinking <level>      reasoning_effort name (default none)
  --cases <path>          case bank (default apps/daemon/eval/protocol-probe-cases.json)
  --max-retries <n>       nudges past the first attempt before a case counts as never compliant (default 2)
  --timeout-ms <n>        per-completion timeout (default 60000)
  --out <path>            JSON output (default .scratch/protocol-probe/<timestamp>.json)
  --dry-run               score the case bank against a small scripted client; no network, no key
  --help

Exit: 0 when every model's bounce rate is under ${BOUNCE_GATE * 100}%, 1 when any is at or over it, 2 on bad arguments.
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: "",
    models: [],
    apiKeyEnv: "REAL_BOT_EVAL_API_KEY",
    thinking: "none",
    cases: DEFAULT_CASES,
    maxRetries: 2,
    timeoutMs: 60_000,
    out: null,
    dryRun: false,
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
        opts.models.push(next(flag, i++));
        break;
      case "--api-key-env":
        opts.apiKeyEnv = next(flag, i++);
        break;
      case "--thinking": {
        const level = next(flag, i++);
        if (!isThinkingLevel(level)) throw new Error("--thinking must be a reasoning_effort name");
        opts.thinking = level as ThinkingLevel;
        break;
      }
      case "--cases":
        opts.cases = resolve(next(flag, i++));
        break;
      case "--max-retries": {
        const n = Number.parseInt(next(flag, i++), 10);
        if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error("--max-retries must be an integer from 0 to 5");
        opts.maxRetries = n;
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
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return opts;
}

/**
 * A deterministic stand-in for a real endpoint: no network, no key. Every case bounces once (a
 * plain-text "I'll call it" with no tool call) and then complies on the retry, except the last case
 * in the bank, which never complies — so no case in a `--dry-run` report is ever compliant on the
 * first try (bounce rate 100%, by design: this run exercises the FAIL wording and the extra-spend
 * accounting, not a passing gate) and exactly one row is never compliant at all.
 */
function scriptedClient(cases: readonly ProtocolCase[]): CompletionsClient {
  const alwaysBounces = cases.at(-1)?.id;
  const calls = new Map<string, number>();
  return {
    async complete(request): Promise<CompletionResult> {
      const situation = request.messages.find((m) => m.role === "user")?.content;
      const c = cases.find((item) => item.situation === situation);
      const key = c?.id ?? "?";
      const attempt = (calls.get(key) ?? 0) + 1;
      calls.set(key, attempt);
      const usage = { input_tokens: 200, output_tokens: 20, total_tokens: 220, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null };
      if (c && c.id !== alwaysBounces && attempt >= 2) {
        return { ok: true, content: "", toolCalls: [{ id: "c1", name: c.expect, arguments: "{}" }], finishReason: "tool_calls", hadChoices: true, usage, missingReason: null };
      }
      return { ok: true, content: "Sure, I'll take care of that now.", toolCalls: [], finishReason: "stop", hadChoices: true, usage, missingReason: null };
    },
    async judge(): Promise<never> {
      throw new Error("protocol-probe never asks the client to judge");
    },
  };
}

async function runCase(client: CompletionsClient, opts: Options, baseUrl: string, apiKey: string, model: string, c: ProtocolCase): Promise<ProtocolCaseResult> {
  const turn = buildProbeTurn(c);
  const messages: ChatMessage[] = [...turn.messages];
  const attempts: AttemptResult[] = [];
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    const result = await client.complete({
      baseUrl,
      apiKey,
      model,
      thinkingLevel: opts.thinking,
      messages,
      tools: turn.tools,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const read = readAttempt(result, c.offered, c.expect);
    attempts.push(read);
    if (read.toolCalled === c.expect || attempt === opts.maxRetries) break;
    // read.failKind is non-null here: readAttempt only returns null when toolCalled === c.expect,
    // and that case just broke the loop above.
    const reason = read.failKind!;
    if (result.ok && result.toolCalls.length > 0) {
      // Echo back what it actually called (an unoffered name, more than one, or just the wrong one)
      // so the transcript stays honest — the nudge that follows must not read as if nothing had
      // been called.
      messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) messages.push({ role: "tool", content: "not accepted for this turn", tool_call_id: call.id });
    } else if (result.ok) {
      messages.push({ role: "assistant", content: result.content || null });
    }
    // A transport failure carries no assistant turn to echo: the next attempt just retries the same request.
    messages.push({ role: "user", content: nudge(c.offered, reason) });
  }
  return scoreCase(c, attempts);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const cases = validateCases(JSON.parse(readFileSync(opts.cases, "utf8")), opts.cases);
  const models = opts.dryRun ? (opts.models.length > 0 ? opts.models : ["dry-run-model"]) : opts.models;
  if (models.length === 0) throw new Error("at least one --model is required (see --help)");
  if (!opts.dryRun && !opts.baseUrl) throw new Error("--base-url is required unless --dry-run (see --help)");
  const apiKey = opts.dryRun ? "" : process.env[opts.apiKeyEnv];
  if (!opts.dryRun && !apiKey) throw new Error(`env ${opts.apiKeyEnv} is empty; export the endpoint key there`);

  const client = opts.dryRun ? scriptedClient(cases) : createCompletionsClient();
  const byModel: Record<string, { summary: ProtocolSummary; rows: ProtocolCaseResult[] }> = {};
  for (const model of models) {
    const rows: ProtocolCaseResult[] = [];
    for (const c of cases) {
      const row = await runCase(client, opts, opts.baseUrl, apiKey ?? "", model, c);
      rows.push(row);
    }
    const summary = summarize(rows);
    byModel[model] = { summary, rows };
    console.log(formatReport(model, summary, rows));
    console.log("");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = opts.out ?? join(REPO_DIR, ".scratch", "protocol-probe", `${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ ran_at: new Date().toISOString(), base_url: opts.dryRun ? null : opts.baseUrl, dry_run: opts.dryRun, cases: opts.cases, max_retries: opts.maxRetries, by_model: byModel }, null, 2)}\n`,
  );
  console.log(`wrote ${outPath}`);

  const failing = Object.entries(byModel).filter(([, { summary }]) => summary.bounce_rate >= BOUNCE_GATE);
  if (failing.length > 0) {
    console.error(`bounce rate at or above the P4b gate (${BOUNCE_GATE * 100}%): ${failing.map(([model]) => model).join(", ")}`);
    return 1;
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
