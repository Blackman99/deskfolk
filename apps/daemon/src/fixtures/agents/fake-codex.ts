/**
 * A stand-in Codex app-server for the Codex driver's tests (ADR 0079): `codex app-server` on stdin
 * and stdout, newline-delimited JSON-RPC without the `"jsonrpc"` field. It plays a script from
 * `FAKE_CODEX_SCRIPT` (JSON), one list of steps per `turn/start` it is sent, against the real
 * driver on the other end, and writes everything it received — requests, notifications, and the
 * answers the driver gave to its own requests — to `FAKE_CODEX_LOG` (one JSON object per line).
 *
 * Script: `{ signedOut?, model?, mcpServers?: [{ name, pluginId? }], rejectMcp?: string[], turns }`.
 * `signedOut` answers `account/read` with no account. `mcpServers` is what `mcpServerStatus/list`
 * lists; a `thread/start` whose `config.mcp_servers` names one of `rejectMcp` fails the way Codex
 * does for a server it cannot take an override for. `@CWD` in the script is the thread's cwd.
 *
 * Steps: `{ say }` a chunk of the final answer; `{ commentary }` words beside the work;
 * `{ command }` a command it asks approval for, then completes (declined when refused);
 * `{ fileChange, burst? }` an absolute path it asks approval to add, and writes ("x") when
 * accepted — the approval request follows `item/started` after a round trip, or with `burst` in the very
 * same write, as a pipe the app was too busy to read delivers them;
 * `{ unasked }` a command it completes without asking; `{ tool: { name, args } }` one of the app's
 * dynamic tools (`item/tool/call`; logged as `toolCalled` when asked, and with its answer as `tool`
 * if the app is still there to give one); `{ usage: { input, output, cached } }` token totals;
 * `{ fail: { message, codexErrorInfo, errorNotice? } }` the turn fails (with an `error`
 * notification first when `errorNotice`); `{ hang: true }` until `turn/interrupt`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { rpcPeer, RpcError } from "../../engine/agent/jsonrpc";

type Step =
  | { say: string }
  | { commentary: string }
  | { command: string }
  | { fileChange: string; burst?: boolean }
  | { unasked: string }
  | { tool: { name: string; args?: Record<string, unknown> } }
  | { usage: { input: number; output: number; cached: number } }
  | { fail: { message: string; codexErrorInfo?: unknown; errorNotice?: boolean } }
  | { hang: true };

type Script = {
  signedOut?: boolean;
  model?: string;
  mcpServers?: Array<{ name: string; pluginId?: string | null }>;
  rejectMcp?: string[];
  turns: Step[][];
};

const script = JSON.parse(process.env.FAKE_CODEX_SCRIPT ?? '{"turns":[]}') as Script;
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(entry)}\n`);
};
const rpc = rpcPeer(process.stdin, process.stdout, { jsonrpc: false });

const THREAD_ID = "thread-1";
let cwd = process.cwd();
let turnIndex = 0;
let seq = 0;
let interrupted = false;

const nextId = (prefix: string) => `${prefix}_${++seq}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (method: string, params: Record<string, unknown>) => rpc.notify(method, params);

/** Asks the driver (the client) for a decision on one item; logs what it answered. */
async function ask(method: string, params: Record<string, unknown>, what: string): Promise<boolean> {
  const answer = await rpc.request<{ decision?: string }>(method, params);
  log({ asked: what, method, answer });
  return answer?.decision === "accept";
}

/** Runs `send`, which writes, and puts everything it wrote on the pipe in one write. */
function held<T>(send: () => T): T {
  const write = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    return send();
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
    write(chunks.join(""));
  }
}

async function play(steps: Step[], turnId: string): Promise<void> {
  // The turn/start answer goes out first.
  await sleep(10);
  interrupted = false;
  const said: string[] = [];
  const message = (text: string, phase: "commentary" | "final_answer") => {
    const item = { type: "agentMessage", id: nextId("msg"), text, phase };
    notify("item/started", { threadId: THREAD_ID, turnId, item: { ...item, text: "" } });
    notify("item/completed", { threadId: THREAD_ID, turnId, item });
  };
  const complete = (status: "completed" | "interrupted" | "failed", error: { message: string; codexErrorInfo?: unknown } | null = null) =>
    notify("turn/completed", { threadId: THREAD_ID, turn: { id: turnId, status, error: error ? { message: error.message, codexErrorInfo: error.codexErrorInfo ?? null } : null } });

  for (const step of steps) {
    if ("say" in step) {
      said.push(step.say);
      notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId, itemId: "final", delta: step.say });
    } else if ("commentary" in step) {
      message(step.commentary, "commentary");
    } else if ("command" in step || "unasked" in step) {
      const asked = "command" in step;
      const text = "command" in step ? step.command : step.unasked;
      const id = nextId("cmd");
      const item = { type: "commandExecution", id, command: `/bin/zsh -lc '${text}'`, cwd, status: "inProgress", aggregatedOutput: null, exitCode: null };
      notify("item/started", { threadId: THREAD_ID, turnId, item });
      const accepted = asked
        ? await ask("item/commandExecution/requestApproval", { itemId: id, threadId: THREAD_ID, turnId, command: item.command, cwd }, text)
        : true;
      if (!asked) log({ unasked: text });
      notify("item/completed", { threadId: THREAD_ID, turnId, item: { ...item, status: accepted ? "completed" : "declined", aggregatedOutput: accepted ? "ran" : null, exitCode: accepted ? 0 : null } });
    } else if ("fileChange" in step) {
      const id = nextId("patch");
      const item = { type: "fileChange", id, changes: [{ path: step.fileChange, kind: { type: "add" }, diff: "x" }], status: "inProgress" };
      const started = () => notify("item/started", { threadId: THREAD_ID, turnId, item });
      const request = () => ask("item/fileChange/requestApproval", { itemId: id, threadId: THREAD_ID, turnId }, step.fileChange);
      let asked: Promise<boolean>;
      if (step.burst) {
        asked = held(() => {
          started();
          return request();
        });
      } else {
        started();
        // A round trip to the app, so it has taken `item/started` in before the request that names only its id.
        await rpc.request("deskfolk/sync", {}, 2_000).catch(() => undefined);
        asked = request();
      }
      const accepted = await asked;
      if (accepted) {
        mkdirSync(dirname(step.fileChange), { recursive: true });
        writeFileSync(step.fileChange, "x");
        log({ wrote: step.fileChange });
      }
      notify("item/completed", { threadId: THREAD_ID, turnId, item: { ...item, status: accepted ? "completed" : "declined" } });
    } else if ("tool" in step) {
      const callId = nextId("call");
      const item = { type: "dynamicToolCall", id: callId, tool: step.tool.name, arguments: step.tool.args ?? {}, status: "inProgress" };
      notify("item/started", { threadId: THREAD_ID, turnId, item });
      // Logged before the answer: a tool that ends the segment ends this process before it comes.
      log({ toolCalled: step.tool.name, args: step.tool.args ?? {} });
      const out = await rpc.request<{ contentItems?: Array<{ text?: string }>; success?: boolean }>("item/tool/call", { threadId: THREAD_ID, turnId, callId, tool: step.tool.name, arguments: step.tool.args ?? {} });
      log({ tool: step.tool.name, out });
      notify("item/completed", { threadId: THREAD_ID, turnId, item: { ...item, status: out?.success === false ? "failed" : "completed" } });
    } else if ("usage" in step) {
      const total = { inputTokens: step.usage.input, cachedInputTokens: step.usage.cached, outputTokens: step.usage.output, reasoningOutputTokens: 0, totalTokens: step.usage.input + step.usage.output };
      notify("thread/tokenUsage/updated", { threadId: THREAD_ID, turnId, tokenUsage: { total, last: { ...total } } });
    } else if ("fail" in step) {
      const error = { message: step.fail.message, codexErrorInfo: step.fail.codexErrorInfo };
      if (step.fail.errorNotice) notify("error", { threadId: THREAD_ID, turnId, error: { message: error.message, codexErrorInfo: error.codexErrorInfo ?? null }, willRetry: false });
      complete("failed", error);
      return;
    } else if ("hang" in step) {
      while (!interrupted) await sleep(20);
      complete("interrupted");
      return;
    }
    await sleep(5);
  }
  message(said.join(""), "final_answer");
  complete("completed");
}

rpc.onRequest(async (method, params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  log({ method, params: p });
  switch (method) {
    case "initialize":
      return { userAgent: "fake-codex/0.0.0", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" };
    case "account/read":
      return script.signedOut
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: "chatgpt", email: null, planType: "free" }, requiresOpenaiAuth: true };
    case "mcpServerStatus/list":
      return { data: (script.mcpServers ?? []).map((server) => ({ name: server.name, pluginId: server.pluginId ?? null })), nextCursor: null };
    case "thread/start": {
      const config = (p.config ?? {}) as { mcp_servers?: Record<string, unknown> };
      for (const name of script.rejectMcp ?? []) {
        if (config.mcp_servers && name in config.mcp_servers) {
          throw new RpcError(-32600, `failed to load configuration: invalid transport\nin \`mcp_servers.${name}\`\n`);
        }
      }
      // `@CWD` in the script is the directory the thread was opened in.
      cwd = String(p.cwd ?? process.cwd());
      script.turns = JSON.parse(JSON.stringify(script.turns).replaceAll("@CWD", cwd)) as Step[][];
      return { thread: { id: THREAD_ID, cwd }, model: script.model ?? "fake-codex-model", modelProvider: "openai", cwd, approvalPolicy: p.approvalPolicy ?? "untrusted", sandbox: { type: "readOnly" } };
    }
    case "turn/start": {
      const steps = script.turns[turnIndex++] ?? [{ say: "(no more script)" }];
      const turnId = `turn-${turnIndex}`;
      void play(steps, turnId);
      return { turn: { id: turnId, status: "inProgress", items: [], error: null } };
    }
    case "turn/interrupt":
      interrupted = true;
      return {};
    case "turn/steer":
      return { turnId: String(p.expectedTurnId ?? "") };
    default:
      throw new RpcError(-32601, `no ${method}`);
  }
});
rpc.onNotification((method, params) => {
  log({ notification: method, params });
});
process.stdin.on("end", () => process.exit(0));
