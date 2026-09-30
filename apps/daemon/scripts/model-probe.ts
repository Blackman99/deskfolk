#!/usr/bin/env bun
/**
 * Two of P5's model-selection inputs, measured once per model so P5 does not have to guess them:
 * streaming throughput's 10th percentile (`stream_tps_p10`, already read by `hop-limits.ts` to size
 * a hop's wall-clock cap) and whether raising the thinking level actually buys more reasoning past
 * a tool loop's first two hops (`reasoning_effective`, P5's escalation ladder). Runs a fixed ≥5-hop
 * synthetic tool loop at thinking levels `none` and `high`, forcing exactly `--hops` turns
 * regardless of what the model would rather do — this is a probe, not a real task, so nothing here
 * reads the model's own judgement about when to stop.
 *
 *   REAL_BOT_EVAL_API_KEY=sk-… bun scripts/model-probe.ts \
 *     --base-url https://api.example.com/v1 --model grk-4.7-build-fast --model gemini-3.8-flash-high
 *
 * `--dry-run` runs the same pipeline against a small scripted client instead of the network, so the
 * scoring and the catalog merge can be checked with no key and no spend (and cannot be combined
 * with `--write`: that would write fake numbers for a real model). `--write` merges the result into
 * a provider's `models` catalog through the `Store` directly, the same `patchProviderSync` the
 * local API's `PATCH /v1/providers/:id` calls, so it keeps everything else about the model
 * (pricing, thinking levels…) exactly as it was — but unlike `check-db.ts`, it does not copy the
 * database first: opening the app's real one with `new Store` runs this build's migrations, marks
 * `last_shutdown` as `crash`, and discards any `file_stages` row this process does not own, which
 * can corrupt a daemon that is running against it right now. `--data-dir` is required with
 * `--write` for exactly this reason — there is no default, and no way for this script to tell
 * whether a daemon already has that directory open, so point it at a copy or a directory nothing
 * is running against.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DB_NAME, THINKING_LEVELS } from "@real-bot/protocol";
import type { ChatMessage, CompletionResult, CompletionsClient } from "../src/completions";
import { createCompletionsClient } from "../src/completions";
import { catalogPatch, formatReport, scoreModel, type HopSample, type ModelProbeResult } from "../src/model-probe";
import { Store } from "../src/store";

type Options = {
  baseUrl: string;
  models: string[];
  apiKeyEnv: string;
  hops: number;
  timeoutMs: number;
  out: string | null;
  dryRun: boolean;
  write: boolean;
  dataDir: string | null;
  providerId: string | null;
  help: boolean;
};

const REPO_DIR = resolve(import.meta.dir, "..", "..", "..");
const MIN_HOPS = 5;

const HELP = `model-probe — streaming speed (p10) and whether raising thinking level buys more reasoning

Required (unless --dry-run):
  --base-url <url>        OpenAI-compatible base URL (…/v1)
  --model <name>          model to probe; repeat the flag for several

Optional:
  --api-key-env <NAME>    env var holding the key (default REAL_BOT_EVAL_API_KEY)
  --hops <n>              hops per thinking level, minimum ${MIN_HOPS} (default ${MIN_HOPS})
  --timeout-ms <n>        per-completion timeout (default 60000)
  --out <path>            JSON output (default .scratch/model-probe/<timestamp>.json)
  --dry-run               score against a small scripted client; no network, no key
  --write                 merge the result into a provider's models catalog; needs --data-dir,
                          and cannot be combined with --dry-run
  --data-dir <path>       data directory to write into with --write — no default; point it at a
                          copy of the app's database, or a directory no running daemon has open
  --provider-id <id>      provider to patch (default: the store's first provider)
  --help
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: "",
    models: [],
    apiKeyEnv: "REAL_BOT_EVAL_API_KEY",
    hops: MIN_HOPS,
    timeoutMs: 60_000,
    out: null,
    dryRun: false,
    write: false,
    dataDir: null,
    providerId: null,
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
      case "--hops": {
        const n = Number.parseInt(next(flag, i++), 10);
        if (!Number.isInteger(n) || n < MIN_HOPS || n > 50) throw new Error(`--hops must be an integer from ${MIN_HOPS} to 50`);
        opts.hops = n;
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
      case "--write":
        opts.write = true;
        break;
      case "--data-dir":
        opts.dataDir = resolve(next(flag, i++));
        break;
      case "--provider-id":
        opts.providerId = next(flag, i++);
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return opts;
}

const TOOL = {
  type: "function" as const,
  function: {
    name: "step",
    description: "Do the next step of this multi-step task.",
    parameters: { type: "object" as const, properties: { note: { type: "string", description: "One line: what you just did." } }, required: ["note"] },
  },
};
const SYSTEM = "You are partway through a multi-step task. Each turn, call the `step` tool with one short note about what you just did, then wait to be told to continue.";

/**
 * A scripted client for `--dry-run`: reasoning tokens on hops 1 and 2 at both thinking levels, none
 * from hop 3 on at either — close to the shape a real grk-4.7-build-fast run was once found to have
 * (both levels reasoned through hop 2, but `high` dropped to 6.7% from hop 3 on, below the floor
 * `reasoningEffectiveVerdict` reads), so a dry run exercises the same false verdict a real probe of
 * that model would reach. This forced loop only ever calls the `step` tool, never answers in plain
 * text, so it fires `onEvent` a few times per hop and never `onToken` — the same shape a real
 * tool-calling model's stream has, and exactly why `stream_tps_p10` must be timed off `onEvent`, not
 * `onToken` (see `runThinkingLevel`).
 */
function scriptedClient(): CompletionsClient {
  return {
    async complete(request): Promise<CompletionResult> {
      const hop = request.messages.filter((m) => m.role === "assistant").length + 1;
      for (let i = 0; i < 5; i += 1) {
        request.onEvent?.({});
        await Bun.sleep(1);
      }
      const reasons = hop <= 2;
      return {
        ok: true,
        content: "",
        toolCalls: [{ id: `c${hop}`, name: "step", arguments: JSON.stringify({ note: `step ${hop}` }) }],
        finishReason: "tool_calls",
        hadChoices: true,
        usage: { input_tokens: 200, output_tokens: 25, total_tokens: 225, cached_tokens: null, reasoning_tokens: reasons ? 40 : 0, cost_usd_ticks: null },
        missingReason: null,
      };
    },
    async judge(): Promise<never> {
      throw new Error("model-probe never asks the client to judge");
    },
  };
}

async function runThinkingLevel(
  client: CompletionsClient,
  opts: Options,
  model: string,
  thinkingLevel: "none" | "high",
  tpsSamples: number[],
): Promise<HopSample[]> {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }, { role: "user", content: "Begin." }];
  const samples: HopSample[] = [];
  for (let hop = 1; hop <= opts.hops; hop += 1) {
    // Timed off `onEvent`, not `onToken`: this loop's hops only ever call the `step` tool, and
    // `onToken` fires only for a text `delta.content` (completions.ts) — a tool-call-only reply
    // never triggers it, so timing off it always yielded zero samples on a compliant model.
    // `onEvent` sees every parsed chunk, tool-call deltas and usage packets included.
    let firstChunkAt: number | null = null;
    let lastChunkAt: number | null = null;
    const result = await client.complete({
      baseUrl: opts.baseUrl,
      apiKey: opts.dryRun ? "" : (process.env[opts.apiKeyEnv] ?? ""),
      model,
      thinkingLevel,
      messages,
      tools: [TOOL],
      signal: AbortSignal.timeout(opts.timeoutMs),
      onEvent: () => {
        const now = Date.now();
        firstChunkAt ??= now;
        lastChunkAt = now;
      },
    });
    if (result.ok && firstChunkAt !== null && lastChunkAt !== null && lastChunkAt > firstChunkAt && result.usage?.output_tokens) {
      tpsSamples.push(result.usage.output_tokens / ((lastChunkAt - firstChunkAt) / 1000));
    }
    if (!result.ok || result.toolCalls.length === 0) {
      // A failed or tool-less hop still counts toward the loop's length (a real hop can misbehave
      // too), but there is nothing to reply with, so the synthetic loop stops here — short of the
      // hops asked for, which `hopsReliable` (src/model-probe.ts) reads as "not a trustworthy
      // reading", not "not effective".
      samples.push({ hop, reasoningTokens: result.ok ? (result.usage?.reasoning_tokens ?? null) : null, failed: true });
      break;
    }
    samples.push({ hop, reasoningTokens: result.usage?.reasoning_tokens ?? null });
    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
    messages.push({ role: "tool", content: "ok", tool_call_id: result.toolCalls[0]!.id });
    messages.push({ role: "user", content: "Continue to the next step." });
  }
  return samples;
}

/**
 * `patchProviderSync`'s `models` REPLACES the whole catalog — it is built for the settings form,
 * which always round-trips every entry. A probe only knows two fields of one model, so this reads
 * the provider's current catalog first and sends it back whole, with only the probed model's entry
 * touched (its other fields — pricing, thinking levels, strengths — spread through first, the patch
 * spread on top): every other model, and everything else about this one, is untouched.
 */
async function writeResult(dataDir: string, providerId: string | null, result: ModelProbeResult): Promise<string> {
  const store = new Store({ filename: join(dataDir, STATE_DB_NAME) });
  try {
    const providers = await store.listProviders();
    const target = providerId ? providers.find((p) => p.id === providerId) : providers[0];
    if (!target) throw new Error(providerId ? `no provider ${providerId} in ${dataDir}` : `no provider in ${dataDir}`);
    const patch = catalogPatch(result);
    const merged = target.model_catalog.map((entry) => (entry.name === result.model ? { ...entry, ...patch } : entry));
    // The probed model was not already in this provider's catalog (an odd but possible ask): add it
    // with the schema's own defaults for the fields a probe says nothing about.
    if (!merged.some((entry) => entry.name === result.model)) {
      merged.push({ price: null, thinking_levels: [...THINKING_LEVELS], strengths: [], ...patch });
    }
    await store.patchProviderSync(target.id, { models: merged });
    return target.id;
  } finally {
    store.close();
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const models = opts.dryRun ? (opts.models.length > 0 ? opts.models : ["dry-run-model"]) : opts.models;
  if (models.length === 0) throw new Error("at least one --model is required (see --help)");
  if (!opts.dryRun && !opts.baseUrl) throw new Error("--base-url is required unless --dry-run (see --help)");
  if (!opts.dryRun && !process.env[opts.apiKeyEnv]) throw new Error(`env ${opts.apiKeyEnv} is empty; export the endpoint key there`);
  if (opts.write && opts.dryRun) throw new Error("--write cannot be combined with --dry-run: that would write fake numbers for a real model");
  if (opts.write && !opts.dataDir) {
    throw new Error(
      "--write needs an explicit --data-dir. This opens the database directly with new Store, not a copy the way check-db.ts does: it runs this build's migrations, marks last_shutdown as crash, and can discard a running daemon's in-flight file writes. Point it at a copy, or a directory nothing is running against.",
    );
  }
  const dataDir = opts.dataDir;

  const client = opts.dryRun ? scriptedClient() : createCompletionsClient();
  const results: ModelProbeResult[] = [];
  for (const model of models) {
    const tpsSamples: number[] = [];
    const none = await runThinkingLevel(client, opts, model, "none", tpsSamples);
    const high = await runThinkingLevel(client, opts, model, "high", tpsSamples);
    results.push(scoreModel(model, none, high, tpsSamples, opts.hops));
  }
  console.log(formatReport(results));

  if (opts.write && dataDir) {
    for (const result of results) {
      const providerId = await writeResult(dataDir, opts.providerId, result);
      console.log(`wrote ${result.model} into provider ${providerId} at ${dataDir}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = opts.out ?? join(REPO_DIR, ".scratch", "model-probe", `${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ ran_at: new Date().toISOString(), base_url: opts.dryRun ? null : opts.baseUrl, dry_run: opts.dryRun, hops: opts.hops, written: opts.write, results }, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
