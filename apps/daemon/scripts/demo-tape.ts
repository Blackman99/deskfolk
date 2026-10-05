/**
 * Record once, replay forever: stands in for the model endpoint and one MCP server of an
 * isolated demo daemon (scripts/demo-studio.ts), so the promo film can show the real app doing
 * real work without paying for it, or getting a different run, every time it is recorded.
 *
 *   bun apps/daemon/scripts/demo-tape.ts record --tape <dir> [--mcp westlake-cpa]
 *   bun apps/daemon/scripts/demo-tape.ts replay --tape <dir> [--pace 1]
 *
 * record: forwards to your own endpoint and MCP server, as configured in the live daemon
 *   (~/Library/Application Support/real-bot). Their keys are read from the macOS Keychain here
 *   and added to upstream requests only; the demo daemon is given dummy keys and never sees the
 *   real ones, and nothing secret is written to the tape. Media URLs the MCP server returns are
 *   downloaded into the tape as they appear (they are temporary upstream).
 * replay: answers from the tape. Model calls are matched by kind and Bot (the system prompt says
 *   which) and their order within that pair; MCP calls by tool name and order, a render's checks
 *   by the job they ask about. Every Bot's turns and each check that ended a render go out in the
 *   order the shoot recorded them (demo-tape-order.ts); when a render's end is next, the demo
 *   daemon is asked to poll it now (`--control`, demo-studio's). Ids differ between the two runs,
 *   so ULIDs and work-dir names seen in requests are paired up and swapped in the answers. Answers
 *   stream at a readable pace (`--pace` scales it). Media is served over HTTPS on 127.0.0.1:8443
 *   for the demo's curl, which a .curlrc in the demo HOME points there.
 *
 * Ports: 127.0.0.1:8000 model (`/v1/...`, shown in the film as a local vLLM), 127.0.0.1:8100 MCP
 * (`/mcp`), 127.0.0.1:8443 media (replay). GET http://127.0.0.1:8000/__tape reports what was used.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultAppDataDir } from "@real-bot/protocol";
import { bunKeyStore } from "../src/secrets";
import { checkArgs, classify, normalize, rpcKey, type ChatBody, type CheckArgs } from "./demo-tape-keys";
import { checkState, stillGoing, Turnstile, type Slot } from "./demo-tape-order";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tape: { type: "string" },
    mcp: { type: "string", default: "westlake-cpa" },
    pace: { type: "string", default: "1" },
    models: { type: "string" },
    control: { type: "string", default: "127.0.0.1:17958" },
  },
});
const mode = positionals[0];
if ((mode !== "record" && mode !== "replay") || !opts.tape) {
  console.error("usage: demo-tape.ts record|replay --tape <dir>");
  process.exit(1);
}
const tapeDir = opts.tape;
const mediaDir = join(tapeDir, "media");
mkdirSync(mediaDir, { recursive: true });
const tapeFile = join(tapeDir, "tape.jsonl");
const mediaIndexFile = join(tapeDir, "media.json");
const pace = Number(opts.pace);

function log(msg: string) {
  process.stdout.write(`[tape] ${msg}\n`);
}

/* ───────── Tape entries ───────── */

type ToolCall = { id: string; name: string; arguments: string };
type Assistant = {
  model: string;
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finish: string | null;
  usage: unknown;
};
type ModelEntry = {
  channel: "model";
  key: string;
  seq: number;
  stream: boolean;
  request: string;
  /** Streamed turns: the assembled answer. Side calls: the raw JSON body. */
  assistant?: Assistant;
  body?: string;
};
type McpEntry = { channel: "mcp"; key: string; seq: number; request: string; body: string };
type ModelsEntry = { channel: "models"; body: string };
type Entry = ModelEntry | McpEntry | ModelsEntry;
type Media = { url: string; file: string; type: string };

/* ───────── Classifying model calls: demo-tape-keys.ts ───────── */

/** `--models a,b` narrows the endpoint's model list, so the wizard offers just those. */
function narrowModels(body: string): string {
  if (!opts.models) return body;
  const keep = new Set(opts.models.split(","));
  const parsed = JSON.parse(body);
  parsed.data = (parsed.data ?? []).filter((m: any) => keep.has(m.id));
  return JSON.stringify(parsed);
}

/* ───────── Recording ───────── */

type Live = { base: string; key: string; mcpUrl: string | null; mcpAuth: string | null };

async function liveConfig(): Promise<Live> {
  const dir = defaultAppDataDir({ platform: process.platform, env: process.env, home: homedir() });
  const desc = JSON.parse(readFileSync(join(dir, "local-api.json"), "utf-8")) as { port: number; token: string };
  const api = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${desc.port}${path}`, { headers: { Authorization: `Bearer ${desc.token}` } });
    if (!res.ok) throw new Error(`live daemon ${path}: ${res.status}`);
    return res.json() as Promise<any>;
  };
  const settings = await api("/v1/settings");
  // The endpoint whose models the story uses (`--models`), whichever of yours is the default today.
  const providers = (await api("/v1/providers")) as { items?: any[] } | any[];
  const wanted = opts.models?.split(",")[0];
  const provider =
    (Array.isArray(providers) ? providers : (providers.items ?? [])).find((p: any) =>
      (p.models ?? []).some((m: any) => (typeof m === "string" ? m : m.name) === wanted),
    ) ?? null;
  const providerId = provider?.id ?? settings.default_provider_id;
  const base = provider?.base_url ?? settings.endpoint_base_url;
  const key =
    (providerId ? await bunKeyStore.get(`endpoint-api-key:${providerId}`) : null) ??
    (await bunKeyStore.get("endpoint-api-key"));
  if (!key) throw new Error("no endpoint key in the Keychain for the endpoint with the story's models");
  const servers = (await api("/v1/mcp-servers")) as { items?: any[] } | any[];
  const list = Array.isArray(servers) ? servers : (servers.items ?? []);
  const server = list.find((s: any) => s.name === opts.mcp);
  let mcpAuth: string | null = null;
  if (server?.auth_set) {
    const raw = await bunKeyStore.get(`mcp-auth:${server.id}`);
    if (raw) mcpAuth = /^bearer\s/i.test(raw) ? raw : `Bearer ${raw}`;
  }
  if (!server) log(`no MCP server named ${opts.mcp} in the live daemon; MCP calls will fail`);
  return { base: String(base).replace(/\/+$/, ""), key, mcpUrl: server?.url ?? null, mcpAuth };
}

const seqs = new Map<string, number>();
function nextSeq(key: string): number {
  const n = seqs.get(key) ?? 0;
  seqs.set(key, n + 1);
  return n;
}

function record(entry: Entry) {
  appendFileSync(tapeFile, `${JSON.stringify(entry)}\n`);
}

/** Folds an OpenAI SSE stream into one assistant message. */
class StreamFold {
  buf = "";
  a: Assistant = { model: "", content: "", reasoning: "", toolCalls: [], finish: null, usage: null };
  push(text: string) {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.model) this.a.model = chunk.model;
      if (chunk.usage) this.a.usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const d = choice.delta ?? {};
        if (typeof d.content === "string") this.a.content += d.content;
        const r = d.reasoning_content ?? d.reasoning;
        if (typeof r === "string") this.a.reasoning += r;
        for (const tc of d.tool_calls ?? []) {
          const slot = (this.a.toolCalls[tc.index ?? 0] ??= { id: "", name: "", arguments: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) this.a.finish = choice.finish_reason;
      }
    }
  }
}

async function recordModel(req: Request, live: Live, path: string): Promise<Response> {
  const upstream = `${live.base}${path.replace(/^\/v1/, "")}`;
  if (req.method === "GET") {
    const res = await fetch(upstream, { headers: { Authorization: `Bearer ${live.key}` } });
    let body = await res.text();
    if (res.ok && path.endsWith("/models")) {
      body = narrowModels(body);
      record({ channel: "models", body });
    }
    return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  }
  const text = await req.text();
  const body = JSON.parse(text) as ChatBody;
  const key = classify(body);
  const res = await fetch(upstream, {
    method: "POST",
    headers: { Authorization: `Bearer ${live.key}`, "Content-Type": "application/json", Accept: req.headers.get("accept") ?? "*/*" },
    body: text,
  });
  if (!body.stream || !res.body) {
    const out = await res.text();
    if (res.ok) record({ channel: "model", key, seq: nextSeq(key), stream: false, request: text, body: out });
    log(`${res.status} ${key}`);
    return new Response(out, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  }
  if (!res.ok) {
    log(`${res.status} ${key} (not recorded)`);
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "text/plain" } });
  }
  const fold = new StreamFold();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        record({ channel: "model", key, seq: nextSeq(key), stream: true, request: text, assistant: fold.a });
        log(`200 ${key} (${fold.a.content.length} chars, ${fold.a.toolCalls.map((t) => t.name).join(",") || "no tools"})`);
        controller.close();
        return;
      }
      fold.push(decoder.decode(value, { stream: true }));
      controller.enqueue(value);
    },
    cancel() {
      void reader.cancel();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

const mediaIndex: Media[] = existsSync(mediaIndexFile) ? JSON.parse(readFileSync(mediaIndexFile, "utf-8")) : [];

async function keepMedia(text: string) {
  const urls = new Set(text.match(/https:\/\/[^\s"'\\)<>\]]+/g) ?? []);
  for (const url of urls) {
    if (mediaIndex.some((m) => m.url === url)) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "application/octet-stream";
      if (!/^(image|video|audio)\//.test(type)) continue;
      const ext = type.split("/")[1]?.split(";")[0] ?? "bin";
      const file = `media/${String(mediaIndex.length).padStart(3, "0")}.${ext}`;
      writeFileSync(join(tapeDir, file), Buffer.from(await res.arrayBuffer()));
      mediaIndex.push({ url, file, type });
      writeFileSync(mediaIndexFile, JSON.stringify(mediaIndex, null, 2));
      log(`kept ${type} ${url.slice(0, 80)}`);
    } catch (e) {
      log(`could not keep ${url.slice(0, 80)}: ${(e as Error).message}`);
    }
  }
}

async function recordMcp(req: Request, live: Live): Promise<Response> {
  if (!live.mcpUrl) return new Response("no upstream MCP server", { status: 502 });
  const headers = new Headers();
  for (const name of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (live.mcpAuth) headers.set("authorization", live.mcpAuth);
  const text = req.method === "POST" ? await req.text() : undefined;
  const res = await fetch(live.mcpUrl, { method: req.method, headers, body: text });
  const outHeaders = new Headers();
  for (const name of ["content-type", "mcp-session-id"]) {
    const v = res.headers.get(name);
    if (v) outHeaders.set(name, v);
  }
  if (req.method !== "POST" || !res.body) return new Response(res.body, { status: res.status, headers: outHeaders });
  let msg: any = null;
  try {
    msg = JSON.parse(text!);
  } catch {
    // batch or junk: pass through unrecorded
  }
  // Passed on as it streams, and recorded once it ends: a server that sends its headers at once and
  // pings while a long call runs (an image can take a minute) must reach the daemon the same way,
  // or the daemon's wait for the headers (30 s) cuts the call off.
  const [toDaemon, toTape] = res.body.tee();
  if (msg && !Array.isArray(msg) && msg.id !== undefined && res.ok) {
    void new Response(toTape)
      .text()
      .then((body) => {
        const key = rpcKey(msg);
        record({ channel: "mcp", key, seq: nextSeq(`mcp:${key}`), request: text!, body });
        log(`mcp ${key}`);
        if (key.startsWith("call:")) void keepMedia(body);
      })
      .catch((e) => log(`mcp stream lost: ${(e as Error).message}`));
  } else {
    void toTape.cancel();
  }
  return new Response(toDaemon, { status: res.status, headers: outHeaders });
}

/* ───────── Replaying ───────── */

const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const WORK_DIR = /work\/([^\s"'`\\/]+)-([0-9a-z]{4}|[0-9a-z]{26})(?=[\s"'`\\/]|$)/g;

/** Every id in `s`, grouped by the text just before it with digits, ids and work-dir suffixes blanked. */
function idsByContext(s: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of s.matchAll(ULID)) {
    const before = s.slice(Math.max(0, m.index! - 40), m.index);
    const ctx = normalize(before).replace(/[0-9A-HJKMNP-TV-Z]{8,}/g, "#").replace(/[0-9]/g, "0");
    (out.get(ctx) ?? out.set(ctx, []).get(ctx)!).push(m[0]);
  }
  return out;
}

class Remap {
  ids = new Map<string, string>();
  dirs = new Map<string, string>();
  missed = 0;

  /**
   * Pairs the ids of the recorded request with those of the live one. Both runs built the same
   * prompt, so an id is matched by what comes just before it (digits and ids blanked out): the
   * k-th id after `tool-results/` here is the k-th id after `tool-results/` there. Ids left over
   * are paired in creation (ULID) order when both sides have as many.
   */
  learn(recorded: string, live: string) {
    const a = idsByContext(recorded);
    const b = idsByContext(live);
    for (const [ctx, ids] of a) {
      const other = b.get(ctx);
      if (!other) continue;
      ids.forEach((id, i) => {
        if (!this.ids.has(id) && other[i]) this.ids.set(id, other[i]);
      });
    }
    const known = new Set(this.ids.values());
    const freshA = [...new Set(recorded.match(ULID) ?? [])].filter((id) => !this.ids.has(id)).sort();
    const freshB = [...new Set(live.match(ULID) ?? [])].filter((id) => !known.has(id)).sort();
    if (freshA.length === freshB.length) freshA.forEach((id, i) => this.ids.set(id, freshB[i]));
    else if (freshA.length) this.missed++;
    const dirsOf = (s: string) => {
      const out = new Map<string, Set<string>>();
      for (const m of s.matchAll(WORK_DIR)) (out.get(m[1]) ?? out.set(m[1], new Set()).get(m[1])!).add(m[0]);
      return out;
    };
    const da = dirsOf(recorded);
    const db = dirsOf(live);
    for (const [slug, set] of da) {
      const other = db.get(slug);
      if (set.size === 1 && other?.size === 1) this.dirs.set([...set][0], [...other][0]);
    }
  }

  apply(s: string): string {
    let out = s.replace(ULID, (id) => this.ids.get(id) ?? id);
    for (const [from, to] of this.dirs) out = out.split(from).join(to);
    return out;
  }
}

function loadTape(): Entry[] {
  if (!existsSync(tapeFile)) throw new Error(`no tape at ${tapeFile}`);
  return readFileSync(tapeFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms * pace)));

function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`);
}

/** Streams an assembled answer back as OpenAI chunks, at roughly a fast typist's speed. */
/** `onAbort` runs when the client hangs up before the answer is out (a redirected turn), `onDone` once it is all out. */
function replayStream(a: Assistant, onAbort: () => void, onDone: () => void = () => {}): Response {
  let done = false;
  const id = `chatcmpl-replay-${Math.random().toString(36).slice(2)}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: a.model };
  const chunk = (delta: unknown, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const stream = new ReadableStream({
    async start(controller) {
      await sleep(450);
      controller.enqueue(sse(chunk({ role: "assistant" })));
      if (a.reasoning) controller.enqueue(sse(chunk({ reasoning_content: a.reasoning })));
      const step = 8;
      for (let i = 0; i < a.content.length; i += step) {
        controller.enqueue(sse(chunk({ content: a.content.slice(i, i + step) })));
        await sleep(55);
      }
      a.toolCalls.forEach((tc, index) =>
        controller.enqueue(sse(chunk({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }] }))),
      );
      controller.enqueue(sse(chunk({}, a.finish ?? (a.toolCalls.length ? "tool_calls" : "stop"))));
      if (a.usage) controller.enqueue(sse({ ...base, choices: [], usage: a.usage }));
      controller.enqueue(sse("[DONE]"));
      done = true;
      controller.close();
      onDone();
    },
    cancel() {
      if (!done) onAbort();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Seconds a replayed MCP call takes, so a long job still reads as running for a moment. */
const MCP_DELAY: Record<string, number> = { "call:generate_image": 2200, "call:submit_video": 600, "call:check_video": 900 };

function rpcMessages(body: string): any[] {
  const out: any[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      out.push(JSON.parse(line.slice(5).trim()));
    } catch {
      // keep-alive or partial
    }
  }
  return out;
}

/** The answer in a recorded MCP body: the JSON-RPC message with an id. */
function answerOf(e: McpEntry): any {
  return rpcMessages(e.body).find((m) => m && m.id !== undefined) ?? { result: {} };
}

/** The key of a recorded MCP call, read again from its request; the recorded key when that does not parse. */
function keyOfRequest(e: McpEntry): string {
  try {
    return rpcKey(JSON.parse(e.request));
  } catch {
    return e.key;
  }
}

async function startReplay() {
  const tape = loadTape();
  const remap = new Remap();
  const queues = new Map<string, Entry[]>();
  const firsts = new Map<string, McpEntry>();
  // What goes out in the shoot's order: every Bot's turns, and each check that ended a render.
  const order: Slot[] = [];
  let models: ModelsEntry | undefined;
  for (const e of tape) {
    if (e.channel === "models") models = e;
    else {
      // A tape from before checks were keyed by their job: key each check by the one it asked about.
      const key = e.channel === "mcp" && /^call:check_[^:]+$/.test(e.key) ? keyOfRequest(e) : e.key;
      const k = `${e.channel}:${key}`;
      const queue = queues.get(k) ?? queues.set(k, []).get(k)!;
      queue.push(e);
      if (e.channel === "mcp" && !e.key.startsWith("call:") && !firsts.has(e.key)) firsts.set(e.key, e);
      const ends = e.channel === "mcp" && /^call:check_[^:]+:/.test(key) && checkState(answerOf(e)) === "ended";
      if ((e.channel === "model" && key.startsWith("turn:")) || ends) order.push({ queue: k, index: queue.length - 1 });
    }
  }
  const used = new Map<string, number>();
  const misses: string[] = [];
  const take = (k: string): Entry | undefined => {
    const n = used.get(k) ?? 0;
    const e = queues.get(k)?.[n];
    if (e) used.set(k, n + 1);
    else misses.push(k);
    return e;
  };
  /**
   * A request the daemon gave up on before its answer was out (a turn redirected by a new mention)
   * never ran its tools, and the shoot never recorded such a request. So its entry goes back for
   * the request that replaces it — unless another has been taken since.
   */
  const giveBack = (k: string, taken: number) => {
    if (used.get(k) !== taken) return;
    used.set(k, taken - 1);
    turnstile.unserved(k, taken - 1);
    log(`gave back ${k} #${taken - 1} (request abandoned)`);
  };
  const turnstile = new Turnstile(order, {
    log,
    // A Bot the next turn belongs to is woken within a scheduler tick (15 s); a render's end waits
    // for the poll it asks for below, which also comes at a tick.
    patience: (slot) => (slot.queue.startsWith("mcp:") ? 90_000 : 60_000),
    // Another Bot's answer starts a moment after one went out, so the tools that one called (a copy
    // into the ticket's folder) are done before the next Bot's run beside them: the shoot's model
    // took seconds to answer, and the daemon reads what a command wrote off the folder's mtimes.
    gap: (previous, next) => (previous.queue.startsWith("model:turn:") && next.queue.startsWith("model:turn:") && previous.queue !== next.queue ? 2000 : 0),
    onNext: (slot) => {
      const id = /^mcp:call:check_[^:]+:(.+)$/.exec(slot.queue)?.[1];
      if (!id) return;
      void fetch(`http://${opts.control}/poll-now`, { method: "POST", body: JSON.stringify({ request_id: id }) })
        .then((res) => res.json() as Promise<{ changed: number }>)
        .then((res) => log(`asked the demo daemon to poll ${id} now (${res.changed ? "pending there" : "not pending there"})`))
        .catch((error) => log(`could not ask the demo daemon to poll ${id}: ${(error as Error).message}`));
    },
  });
  setInterval(() => turnstile.tick(), 5000);
  const lanes = new Map<string, Promise<unknown>>();
  /** One Bot's requests wait their turn one after another, so two of them never pass on one entry. */
  const inLane = <T>(k: string, run: () => Promise<T>): Promise<T> => {
    const result = (lanes.get(k) ?? Promise.resolve()).then(run);
    lanes.set(k, result.catch(() => undefined));
    return result;
  };

  /**
   * A check on a render: the shoot's "still going" answers in order, as often as the app asks; the
   * answer that ended it only once that is due in the shoot's order (until then, "still going"
   * again); after that, the end again.
   */
  async function answerCheck(msg: any, key: string, check: CheckArgs): Promise<Response> {
    const k = `mcp:${key}`;
    const queue = (queues.get(k) ?? []) as McpEntry[];
    const n = used.get(k) ?? 0;
    const end = queue.findIndex((e, i) => i >= n && checkState(answerOf(e)) === "ended");
    let answer: any;
    let ends = false;
    if (end >= 0 && turnstile.due(k, end)) {
      if (end > n) log(`${key}: skipped ${end - n} "still going" answer(s), the app asked less often than in the shoot`);
      used.set(k, end + 1);
      answer = answerOf(queue[end]!);
      ends = true;
    } else if (n < queue.length && (end < 0 || n < end)) {
      used.set(k, n + 1);
      answer = answerOf(queue[n]!);
    } else if (end >= 0) {
      const recorded = queue.slice(0, end).map(answerOf).reverse().find((a) => checkState(a) === "pending");
      answer = stillGoing(answerOf(queue[end]!), recorded, check);
      log(`${key}: still going (its end is not due yet)`);
    } else if (queue.length) {
      answer = answerOf(queue[queue.length - 1]!);
    } else {
      misses.push(k);
      log(`MISS mcp ${key}`);
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no tape entry for ${key}` } });
    }
    await sleep(MCP_DELAY[`call:${check.tool}`] ?? 150);
    if (ends) turnstile.served(k, end);
    return new Response(JSON.stringify({ ...answer, id: msg.id }), {
      headers: { "content-type": "application/json", "mcp-session-id": "replay-session" },
    });
  }
  log(`replaying ${tape.length} entries (${[...queues.keys()].length} keys, ${order.length} in the shoot's order)`);

  Bun.serve({
    hostname: "127.0.0.1",
    port: 8000,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/__tape") {
        return Response.json({
          used: Object.fromEntries(used),
          left: Object.fromEntries([...queues].map(([k, v]) => [k, v.length - (used.get(k) ?? 0)]).filter(([, n]) => (n as number) > 0)),
          misses,
          skipped: turnstile.skipped,
          neverAsked: turnstile.remaining(),
          remapped: remap.ids.size,
          remapMisses: remap.missed,
        });
      }
      if (req.method === "GET" && path.endsWith("/models")) {
        if (!models) return Response.json({ object: "list", data: [] });
        return new Response(narrowModels(models.body), { headers: { "content-type": "application/json" } });
      }
      const text = await req.text();
      const body = JSON.parse(text) as ChatBody;
      const key = classify(body);
      const k = `model:${key}`;
      // A Bot's turns go out in the shoot's order among every other Bot's and the renders' ends.
      const sequenced = key.startsWith("turn:");
      const got = await inLane(k, async () => {
        if (sequenced && !(await turnstile.wait(k, used.get(k) ?? 0, req.signal))) return null;
        const entry = take(k) as ModelEntry | undefined;
        return { entry, taken: used.get(k) ?? 0 };
      });
      if (!got) return new Response(null, { status: 499 });
      const { entry: e, taken } = got;
      const abandon = () => giveBack(k, taken);
      // Out once the whole answer is: the shoot recorded each answer as it ended, and the next one
      // starts only then, so one Bot's tools never run beside another's that the shoot ran apart (a
      // Producer's copy into the ticket's folder, taken for the Reviewer's own write).
      const finished = () => {
        if (sequenced) turnstile.served(k, taken - 1);
      };
      if (!e) {
        log(`MISS ${key}`);
        return new Response(JSON.stringify({ error: { message: `no tape entry for ${key}` } }), { status: 503 });
      }
      remap.learn(e.request, text);
      if (e.stream && e.assistant) {
        const a = e.assistant;
        return replayStream(
          {
            ...a,
            content: remap.apply(a.content),
            toolCalls: a.toolCalls.map((t) => ({ ...t, arguments: remap.apply(t.arguments) })),
          },
          abandon,
          finished,
        );
      }
      await sleep(key.startsWith("organizer") ? 500 : 280);
      if (req.signal.aborted) {
        abandon();
        return new Response(null, { status: 499 });
      }
      finished();
      return new Response(remap.apply(e.body ?? "{}"), { headers: { "content-type": "application/json" } });
    },
  });

  Bun.serve({
    hostname: "127.0.0.1",
    port: 8100,
    idleTimeout: 0,
    async fetch(req) {
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      const msg = JSON.parse(await req.text());
      if (Array.isArray(msg) || msg.id === undefined) return new Response(null, { status: 202 });
      const key = rpcKey(msg);
      const check = checkArgs(msg);
      if (check) return answerCheck(msg, key, check);
      const e = key.startsWith("call:") ? (take(`mcp:${key}`) as McpEntry | undefined) : firsts.get(key);
      if (!e) {
        log(`MISS mcp ${key}`);
        return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no tape entry for ${key}` } });
      }
      await sleep(MCP_DELAY[key] ?? 150);
      return new Response(JSON.stringify({ ...answerOf(e), id: msg.id }), {
        headers: { "content-type": "application/json", "mcp-session-id": "replay-session" },
      });
    },
  });

  const cert = join(tapeDir, "cert.pem");
  const keyPem = join(tapeDir, "key.pem");
  if (!existsSync(cert)) {
    spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPem, "-out", cert, "-days", "3650", "-subj", "/CN=localhost"], {
      stdio: "ignore",
    });
  }
  Bun.serve({
    hostname: "127.0.0.1",
    port: 8443,
    tls: { cert: Bun.file(cert), key: Bun.file(keyPem) },
    fetch(req) {
      const u = new URL(req.url);
      const hit = mediaIndex.find((m) => {
        const mu = new URL(m.url);
        return mu.pathname === u.pathname && mu.search === u.search;
      });
      if (!hit) {
        log(`MISS media ${u.pathname}`);
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(join(tapeDir, hit.file)), { headers: { "content-type": hit.type } });
    },
  });
  log("model 127.0.0.1:8000 · mcp 127.0.0.1:8100 · media https://127.0.0.1:8443");
}

async function startRecord() {
  const live = await liveConfig();
  log(`recording to ${tapeFile}: model ${live.base}, mcp ${live.mcpUrl ?? "none"}`);
  Bun.serve({
    hostname: "127.0.0.1",
    port: 8000,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/__tape") return Response.json({ recorded: Object.fromEntries(seqs), media: mediaIndex.length });
      return recordModel(req, live, path);
    },
  });
  Bun.serve({ hostname: "127.0.0.1", port: 8100, idleTimeout: 0, fetch: (req) => recordMcp(req, live) });
  log("model 127.0.0.1:8000 · mcp 127.0.0.1:8100");
}

if (mode === "record") await startRecord();
else await startReplay();
