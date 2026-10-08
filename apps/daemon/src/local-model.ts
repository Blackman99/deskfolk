/**
 * What a model server on this computer or network needs from the client (ADR 0067). Ollama,
 * LM Studio and llama.cpp's `llama-server` answer the same Chat Completions requests as a cloud
 * endpoint, but past their context window they do not refuse a prompt: Ollama cut a 49,837-token
 * prompt to its last 16,386 tokens and answered 200 (2026-10-08, qwen3:8b, window 32,768), so the
 * persona, the instructions and the tool list were gone and nothing said so. The pure parts live
 * here: how big a request is, whether the usage it came back with says it was cut, the
 * `<think>` text some servers leave in the reply, and what those servers say about their models.
 */
import type { ChatMessage } from "./completions";

// ── How big a request is ───────────────────────────────────────────────────────────────────────

/**
 * UTF-8 bytes of what a request asks the model to read: every message's text, the tool calls it
 * carries, and the tool definitions. Pictures are left out — a data URL is megabytes the server
 * reads as a few hundred tokens, so counting it would make every hop with a picture look cut.
 */
export function promptBytes(messages: readonly ChatMessage[], tools: readonly unknown[] | undefined): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") bytes += encoder.encode(content).length;
    else if (Array.isArray(content)) {
      for (const part of content) if (part.type === "text") bytes += encoder.encode(part.text).length;
    }
    for (const call of message.tool_calls ?? []) bytes += encoder.encode(call.name + call.arguments).length;
  }
  if (tools && tools.length > 0) bytes += encoder.encode(JSON.stringify(tools)).length;
  return bytes;
}

/**
 * Bytes per token a request is read at before the endpoint has told us: about what English prose,
 * code and tool definitions come to (3–4.5); Chinese runs near 4 on Qwen's tokenizer.
 */
export const DEFAULT_BYTES_PER_TOKEN = 4;
/**
 * Above this many bytes per reported token, uncalibrated, a prompt was cut. No tokenizer packs text
 * that densely: the measured requests read at 3.4 (English filler) and the cut ones at 6.9 and 10.1.
 */
export const CUT_BYTES_PER_TOKEN = 6.5;
/** Calibrated, the reported tokens falling this far under what the model read last time is a cut. */
export const CUT_FACTOR = 1.6;
/** A request smaller than this fits any window a server would run with; it is never judged cut. */
export const MIN_CHECKED_BYTES = 16_000;

/** Tokens a request comes to: by what this model read the last requests at, else by the default. */
export function estimateTokens(bytes: number, bytesPerToken: number | undefined): number {
  return Math.ceil(bytes / (bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN));
}

/**
 * Whether the tokens an endpoint reports reading show the prompt was cut: far fewer than the bytes
 * sent come to. `bytesPerToken` is what this model read earlier requests at, when known.
 */
export function promptWasCut(bytes: number, promptTokens: number | null | undefined, bytesPerToken: number | undefined): boolean {
  if (bytes < MIN_CHECKED_BYTES || !promptTokens || promptTokens <= 0) return false;
  const observed = bytes / promptTokens;
  if (bytesPerToken === undefined) return observed > CUT_BYTES_PER_TOKEN;
  return observed > Math.max(bytesPerToken * CUT_FACTOR, 4);
}

/** A request of one conversation as the server read it, for {@link readLessThanBefore}. */
export type ThreadReading = { bytes: number; read: number; pictures: number };

/**
 * Whether a request reads fewer tokens than the one before it in the same conversation although it
 * sent more: the mark of a server that drops the oldest messages to fit its window. Ollama 0.40 did
 * so on 2026-10-08 (ADR 0068): 32,680 tokens read, then 32,581 for a prompt 4 KB longer, the
 * request that started the turn gone. It cuts only what is over, so the bytes per token barely move
 * and {@link promptWasCut} misses it. Judged only between requests carrying as many pictures: a
 * picture let go of takes its tokens with it and no bytes.
 */
export function readLessThanBefore(before: ThreadReading | undefined, bytes: number, read: number | null | undefined, pictures: number): boolean {
  if (!before || !read || read <= 0 || bytes < MIN_CHECKED_BYTES || pictures !== before.pictures) return false;
  return bytes > before.bytes && read < before.read;
}

/** Pictures a request carries. */
export function pictureCount(messages: readonly ChatMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (Array.isArray(message.content)) count += message.content.filter((part) => part.type === "image_url").length;
  }
  return count;
}

/**
 * The bytes-per-token reading a request that was not cut leaves for the next one: the new reading
 * folded into the old, so one request heavy on code or Chinese does not swing it. A reading no
 * tokenizer gives is ignored, and so is a small request: the app's short calls are mostly Chinese
 * and JSON, a Bot's step mostly English instructions and tool definitions, and a reading taken from
 * the one would misjudge the other.
 */
export function nextBytesPerToken(previous: number | undefined, bytes: number, promptTokens: number | null | undefined): number | undefined {
  if (bytes < MIN_CHECKED_BYTES || !promptTokens || promptTokens <= 0) return previous;
  const observed = bytes / promptTokens;
  if (observed < 1 || observed > CUT_BYTES_PER_TOKEN) return previous;
  return previous === undefined ? observed : previous * 0.7 + observed * 0.3;
}

/** Room left over a known window's estimate before a request is refused unsent. */
export const PREFLIGHT_SLACK = 1.1;

/** Whether a request is clearly too big for a known window, so it is refused before it is sent. */
export function overWindow(bytes: number, bytesPerToken: number | undefined, window: number | undefined): boolean {
  if (!window || window <= 0) return false;
  return estimateTokens(bytes, bytesPerToken) > window * PREFLIGHT_SLACK;
}

// ── `<think>` in the reply ─────────────────────────────────────────────────────────────────────

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Takes a reasoning model's `<think>…</think>` out of the reply text as it streams. llama.cpp
 * without a reasoning parser, LM Studio on some models and vLLM without `--reasoning-parser` leave
 * the model's thinking in `content`; Ollama and the cloud endpoints send it apart. Only a block at
 * the very start counts — that is where every such model writes it — so a reply that talks about
 * the tag later keeps it. `finish` also drops a lone `</think>` and everything before it: some
 * templates put the opening tag in the prompt, so the reply starts mid-thought.
 */
export class ThinkStrip {
  /** `after`: the block just closed, and the blank lines that follow it are not the reply either. */
  private state: "start" | "inside" | "after" | "outside" = "start";
  private pending = "";
  private sawOpen = false;

  /** The next piece of `content`; returns the part of it that is the reply. */
  feed(text: string): string {
    if (this.state === "outside") return text;
    if (this.state === "after") {
      const rest = text.replace(/^\s+/, "");
      if (rest.length > 0) this.state = "outside";
      return rest;
    }
    this.pending += text;
    if (this.state === "start") {
      const lead = this.pending.trimStart();
      if (lead.length === 0) return "";
      if (OPEN.startsWith(lead)) return "";
      if (!lead.startsWith(OPEN)) {
        this.state = "outside";
        const out = this.pending;
        this.pending = "";
        return out;
      }
      this.sawOpen = true;
      this.state = "inside";
      this.pending = lead.slice(OPEN.length);
    }
    const end = this.pending.indexOf(CLOSE);
    if (end < 0) return "";
    const rest = this.pending.slice(end + CLOSE.length).replace(/^\s+/, "");
    this.pending = "";
    this.state = rest.length > 0 ? "outside" : "after";
    return rest;
  }

  /** The whole reply once the stream ended: a block never closed was all thinking; a lone close tag ends one. */
  finish(content: string): string {
    if (this.state === "start") return content + this.pending;
    if (this.state === "inside" || this.state === "after") return content;
    if (!this.sawOpen) return stripLeadingThink(content);
    return content;
  }
}

/** The reply text with a leading `<think>…</think>` (or everything up to a lone `</think>`) taken out. */
export function stripLeadingThink(text: string): string {
  const lead = text.trimStart();
  if (lead.startsWith(OPEN)) {
    const end = lead.indexOf(CLOSE);
    return end < 0 ? "" : lead.slice(end + CLOSE.length).replace(/^\s+/, "");
  }
  const lone = text.indexOf(CLOSE);
  if (lone >= 0 && !text.slice(0, lone).includes(OPEN)) return text.slice(lone + CLOSE.length).replace(/^\s+/, "");
  return text;
}

// ── What the server says about its models ──────────────────────────────────────────────────────

/** What a local server told us about one model. Every field is absent when it did not say. */
export type LocalModelFacts = {
  /** Tokens it reads per request: the loaded window when the model is loaded, else the model's own limit. */
  context_window?: number;
  /** Whether it takes pictures. */
  input_image?: boolean;
  /** Whether it calls tools. A Bot cannot work on one that does not. */
  tools?: boolean;
};

/** The server's own address: a Chat Completions base like `http://localhost:11434/v1` without its `/v1`. */
export function serverRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Ollama's `GET /api/tags`: each model's own context limit and what it can do. */
export function readOllamaTags(data: unknown): Map<string, LocalModelFacts> {
  const out = new Map<string, LocalModelFacts>();
  for (const item of listOf(data, "models")) {
    const name = str(item.name) ?? str(item.model);
    if (!name) continue;
    const details = obj(item.details);
    const facts: LocalModelFacts = {};
    const window = positive(details?.context_length);
    if (window) facts.context_window = window;
    if (Array.isArray(item.capabilities)) {
      const caps = item.capabilities.filter((cap): cap is string => typeof cap === "string");
      facts.input_image = caps.includes("vision");
      facts.tools = caps.includes("tools");
    }
    out.set(name, facts);
  }
  return out;
}

/** Ollama's `GET /api/ps`: the window each loaded model actually runs with (its server's `num_ctx`). */
export function readOllamaLoaded(data: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of listOf(data, "models")) {
    const name = str(item.name) ?? str(item.model);
    const window = positive(item.context_length);
    if (name && window) out.set(name, window);
  }
  return out;
}

/** The `num_ctx` a model's Modelfile sets, from Ollama's `POST /api/show` (its `parameters` text). */
export function readOllamaNumCtx(data: unknown): number | undefined {
  const parameters = obj(data)?.parameters;
  if (typeof parameters !== "string") return undefined;
  const match = /^num_ctx\s+(\d+)\s*$/m.exec(parameters);
  return match ? positive(Number(match[1])) : undefined;
}

/** LM Studio's `GET /api/v0/models`: the loaded window, else the model's limit; `vlm` takes pictures. */
export function readLmStudioModels(data: unknown): Map<string, LocalModelFacts> {
  const out = new Map<string, LocalModelFacts>();
  for (const item of listOf(data, "data")) {
    const name = str(item.id);
    if (!name || item.type === "embeddings") continue;
    const facts: LocalModelFacts = {};
    const window = positive(item.loaded_context_length) ?? positive(item.max_context_length);
    if (window) facts.context_window = window;
    if (item.type === "vlm") facts.input_image = true;
    else if (item.type === "llm") facts.input_image = false;
    if (Array.isArray(item.capabilities)) facts.tools = item.capabilities.includes("tool_use");
    out.set(name, facts);
  }
  return out;
}

/** llama.cpp's `GET /props`: the one model it serves, its per-slot window, and whether it sees. */
export function readLlamaCppProps(data: unknown): LocalModelFacts | null {
  const props = obj(data);
  const settings = obj(props?.default_generation_settings);
  if (!props || !settings) return null;
  const facts: LocalModelFacts = {};
  const window = positive(settings.n_ctx);
  if (window) facts.context_window = window;
  const modalities = obj(props.modalities);
  if (typeof modalities?.vision === "boolean") facts.input_image = modalities.vision;
  return facts;
}

/**
 * Asks the server behind a local Chat Completions base what it knows about its models, trying
 * Ollama, then LM Studio, then llama.cpp; each answer that does not parse is skipped. `models` names
 * the ones wanted (llama.cpp serves one, whatever it is called). Never throws.
 */
export async function readLocalModels(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  baseUrl: string,
  models: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Map<string, LocalModelFacts>> {
  const root = serverRoot(baseUrl);
  const timeoutMs = options.timeoutMs ?? 3_000;
  const get = async (path: string, body?: unknown): Promise<unknown> => {
    try {
      const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
      const response = await fetchImpl(`${root}${path}`, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        signal: AbortSignal.any(signals),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  };
  const tags = await get("/api/tags");
  if (tags) {
    const facts = readOllamaTags(tags);
    if (facts.size > 0) {
      // The window a model runs with: the loaded one when it is loaded, else its Modelfile's
      // `num_ctx` when it sets one, else (unknown to us) the server's default, at most its limit.
      const loaded = readOllamaLoaded(await get("/api/ps"));
      await Promise.all(models.filter((name) => facts.has(name) && !loaded.has(name)).map(async (name) => {
        const numCtx = readOllamaNumCtx(await get("/api/show", { model: name }));
        const limit = facts.get(name)!.context_window;
        if (numCtx) facts.set(name, { ...facts.get(name), context_window: limit ? Math.min(limit, numCtx) : numCtx });
      }));
      for (const [name, window] of loaded) facts.set(name, { ...facts.get(name), context_window: window });
      return facts;
    }
  }
  const lmstudio = readLmStudioModels(await get("/api/v0/models"));
  if (lmstudio.size > 0) return lmstudio;
  const props = readLlamaCppProps(await get("/props"));
  if (props) return new Map(models.map((name) => [name, { ...props }]));
  return new Map();
}

function listOf(data: unknown, key: string): Record<string, unknown>[] {
  const list = obj(data)?.[key];
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => Boolean(obj(item))) : [];
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
