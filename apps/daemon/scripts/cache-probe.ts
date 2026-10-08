#!/usr/bin/env bun
/**
 * Does an endpoint reuse its prompt cache between requests? Sends one large request — a real System
 * section and tools array, built from a tool-selection case — several times in a row, with no session
 * id (`plain`) and with an `X-Session-ID` (`session`), and prints every answer's raw `usage` beside what
 * the app records from it (`mapUsage`); a cache field that is absent is told apart from one that is 0.
 *
 * A proxy that spreads requests over several accounts misses the cache on most requests: the cache
 * is per account. CLIProxyAPI keeps one conversation on one account only with
 * `routing.session-affinity: true` (it recognizes the `X-Session-ID` the daemon sends on every
 * request). Repeats that hit here mean the account is kept; whether a real turn's growing steps hit
 * too is read from the spend ledger (per-step `cached_tokens`, see docs/development.md): a made-up
 * conversation grown by hand misses through gemini's Antigravity path even when real turns hit 70%,
 * because the proxy replays the model's own reasoning into each real step.
 *
 *   REAL_BOT_EVAL_API_KEY=sk-… bun scripts/cache-probe.ts \
 *     --base-url https://api.example.com/v1 --model gemini-3.8-flash-high --model grok-4.7-build-fast
 *
 * The key never leaves the process.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isThinkingLevel, type ThinkingLevel } from "@real-bot/protocol";
import { mapUsage } from "../src/completions/wire";
import { buildEvalTurn, validateCases } from "../src/tool-selection-eval";

type Options = {
  baseUrl: string;
  models: string[];
  apiKeyEnv: string;
  repeat: number;
  caseId: string;
  thinking: ThinkingLevel | null;
  groups: Group[];
};

type Group = "plain" | "session";
const GROUPS: readonly Group[] = ["plain", "session"];

const DAEMON_DIR = resolve(import.meta.dir, "..");
const CASES = join(DAEMON_DIR, "eval", "tool-selection-cases.json");

const HELP = `cache-probe — does the endpoint reuse its prompt cache across one conversation's steps?

Required:
  --base-url <url>      OpenAI-compatible base URL (…/v1)
  --model <name>        model to probe; repeat for several

Optional:
  --api-key-env <NAME>  env var holding the key (default REAL_BOT_EVAL_API_KEY)
  --repeat <n>          requests per group (default 3)
  --case <id>           tool-selection case whose System section and tools are sent (default: the first)
  --thinking <level>    reasoning_effort to send (default low, so a -high model is not cut off thinking)
  --only <group>        plain or session: run one group only
`;

function parseArgs(argv: string[]): Options | null {
  const opts: Options = { baseUrl: "", models: [], apiKeyEnv: "REAL_BOT_EVAL_API_KEY", repeat: 3, caseId: "", thinking: "low", groups: [...GROUPS] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--base-url": opts.baseUrl = value(); break;
      case "--model": opts.models.push(value()); break;
      case "--api-key-env": opts.apiKeyEnv = value(); break;
      case "--repeat": opts.repeat = Math.max(2, Number.parseInt(value(), 10) || 3); break;
      case "--case": opts.caseId = value(); break;
      case "--thinking": {
        const level = value();
        if (!isThinkingLevel(level)) throw new Error("--thinking must be a reasoning_effort name");
        opts.thinking = level;
        break;
      }
      case "--only": {
        const group = value() as Group;
        if (!GROUPS.includes(group)) throw new Error(`--only is one of ${GROUPS.join(", ")}`);
        opts.groups = [group];
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!opts.baseUrl || opts.models.length === 0) throw new Error("--base-url and at least one --model are required");
  return opts;
}

/** One streamed request; every usage the endpoint reported, as it came (the last one is what the app keeps). */
async function send(opts: Options, key: string, model: string, body: Record<string, unknown>, session: string | null): Promise<{ usage: unknown; usages: number; ms: number; status: number }> {
  const started = Date.now();
  const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(session ? { "X-Session-ID": session } : {}),
    },
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) return { usage: { error: (await response.text()).slice(0, 300) }, usages: 0, ms: Date.now() - started, status: response.status };
  let usage: unknown = null;
  let usages = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { usage?: unknown };
        if (parsed.usage) {
          usage = parsed.usage;
          usages += 1;
        }
      } catch {
        // a partial or non-JSON line: the next read completes it or it carries no usage
      }
    }
  }
  return { usage, usages, ms: Date.now() - started, status: response.status };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.log(HELP);
    return;
  }
  const key = process.env[opts.apiKeyEnv];
  if (!key) throw new Error(`set ${opts.apiKeyEnv} to the endpoint's key`);
  const cases = validateCases(JSON.parse(readFileSync(CASES, "utf8")), CASES);
  const chosen = opts.caseId ? cases.find((c) => c.id === opts.caseId) : cases[0];
  if (!chosen) throw new Error(`no case ${opts.caseId}`);
  const turn = buildEvalTurn(chosen);
  const body: Record<string, unknown> = {
    messages: turn.messages.map((message) => ({ role: message.role, content: message.content })),
    tools: turn.tools,
    max_tokens: 512,
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.thinking ? { reasoning_effort: opts.thinking } : {}),
  };
  console.log(`case ${chosen.id}: ${JSON.stringify(body).length} characters per request\n`);
  for (const model of opts.models) {
    for (const group of opts.groups) {
      const session = group === "plain" ? null : `cache-probe-${crypto.randomUUID()}`;
      const seen: Array<{ input: number | null; cached: number | null }> = [];
      for (let attempt = 1; attempt <= opts.repeat; attempt += 1) {
        const { usage, usages, ms, status } = await send(opts, key, model, body, session);
        const mapped = mapUsage(usage);
        seen.push({ input: mapped?.input_tokens ?? null, cached: mapped?.cached_tokens ?? null });
        const cached = mapped?.cached_tokens === null || mapped?.cached_tokens === undefined ? "absent" : String(mapped.cached_tokens);
        console.log(`${model} ${group} #${attempt} ${status} ${ms} ms input=${mapped?.input_tokens ?? "?"} cached=${cached} usage-chunks=${usages} usage=${JSON.stringify(usage)}`);
      }
      const later = seen.slice(1);
      const input = later.reduce((sum, row) => sum + (row.input ?? 0), 0);
      const cached = later.reduce((sum, row) => sum + (row.cached ?? 0), 0);
      console.log(`${model} ${group}: requests 2..${opts.repeat} read ${input ? Math.round((cached / input) * 100) : 0}% from the cache\n`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
