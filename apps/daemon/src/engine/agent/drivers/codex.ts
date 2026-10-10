/**
 * Your Codex, through its app-server (ADR 0079): `codex app-server` on stdin and stdout, a private
 * one per turn — never the shared daemon `codex agents` browses, never a remote one. Its app-server
 * is what OpenAI offers for building Codex into a product; the app names itself to it as
 * `deskfolk`, as it asks.
 *
 * Every command and file change waits for the app: the thread runs with a read-only sandbox and
 * approval `untrusted` (measured 2026-10-10 with 0.153.4: every command, reads included, and every
 * file change asked first, and ran as approved), and the app answers by its rules — a card where a
 * call crosses out of the workspace. The app's own tools are Codex dynamic tools, called back over
 * the same connection. What is yours in `~/.codex` that would otherwise join a Bot's turn — your MCP
 * servers, hooks, memories, plugins, apps, notifications, AGENTS.md — is switched off for the thread
 * only, in its `config`; nothing is written there.
 */
import type { ChildProcess } from "node:child_process";
import type { AgentInputPart } from "../../../context";
import type { FailKind } from "../../../prompts";
import daemonPackage from "../../../../package.json";
import type { AgentDriver, AgentEvent, AgentHost, AgentSession, DriverCaps } from "../driver";
import { agentTrace } from "../trace";
import { rpcPeer } from "../jsonrpc";
import { absoluteFrom, unwrapShell, type AppAction } from "../policy";
import { AgentStartError } from "./acp";

const INIT_TIMEOUT_MS = 60_000;

/** What would otherwise come along from your own Codex setup: off for a Bot's thread. */
const ISOLATION = {
  features: { hooks: false, memories: false, multi_agent: false, js_repl: false, apps: false, plugins: false },
  notify: [],
  project_doc_max_bytes: 0,
};

export function codexDriver(): AgentDriver {
  const caps: DriverCaps = { midTurn: "steer", sendNow: true, appTools: true, appRunsFiles: false };
  return {
    caps,
    // Codex lists the app's tools as its own, by their plain names.
    toolHint: {
      zh: "在 Codex 里，这些工具就是你自己的工具，直接按 send_message、end_turn、ask_user 这些名字调用。",
      en: "In Codex these are tools of your own: call them by their plain names, send_message, end_turn, ask_user and so on.",
    },
    async start(host, first) {
      const child = host.spawn(host.executable, host.launchArgs, { cwd: host.cwd, env: host.env });
      return codexSession(host, child, first);
    },
  };
}

type Item = Record<string, unknown> & { id: string; type: string };

async function codexSession(host: AgentHost, child: ChildProcess, first: AgentInputPart[]): Promise<AgentSession> {
  const done = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      host.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve();
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => host.stderr(chunk));
  const rpc = rpcPeer(child.stdout!, child.stdin!, { jsonrpc: false, trace: agentTrace(host.turnId) });
  void done.then(() => rpc.close(new Error("Codex exited")));

  const emit = (event: AgentEvent) => host.emit(event);
  const items = new Map<string, Item>();
  const gated = new Set<string>();
  const audited = new Set<string>();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let model = host.model ?? "";
  let closed = false;
  let inFlight = false;
  let interrupted = false;
  let finalText = "";
  let lastText = "";
  let failure: { failKind: FailKind; detail: string | null } | null = null;
  let turnDone: ((turn: { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null }) => void) | null = null;
  const queue: AgentInputPart[][] = [];

  /** A command or file change as the app counts it. */
  const actionOf = (item: Item): AppAction | null => {
    const cwd = typeof item.cwd === "string" && item.cwd ? item.cwd : host.cwd;
    if (item.type === "commandExecution" && typeof item.command === "string") {
      return { appName: "shell", vendorTool: "shell", paths: [], command: unwrapShell(item.command), cwd };
    }
    if (item.type === "fileChange" && Array.isArray(item.changes)) {
      const paths = (item.changes as Array<{ path?: unknown }>).flatMap((change) => (typeof change.path === "string" ? [absoluteFrom(cwd, change.path)] : []));
      return { appName: "write_file", vendorTool: "apply_patch", paths, cwd };
    }
    return null;
  };

  rpc.onRequest(async (method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const itemId = String(p.itemId ?? p.approvalId ?? "");
        const known = items.get(itemId);
        const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : host.cwd;
        const command = typeof p.command === "string" ? p.command : typeof known?.command === "string" ? known.command : "";
        gated.add(itemId);
        const answer = await host.gate(itemId, { appName: "shell", vendorTool: "shell", paths: [], command: unwrapShell(command), cwd });
        return { decision: answer.kind === "allow" ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const itemId = String(p.itemId ?? "");
        const known = items.get(itemId);
        const action = known ? actionOf(known) : null;
        gated.add(itemId);
        // A change the app cannot see the files of is no change it can approve.
        if (!action || action.paths.length === 0) return { decision: "decline" };
        const answer = await host.gate(itemId, action);
        return { decision: answer.kind === "allow" ? "accept" : "decline" };
      }
      case "item/tool/call": {
        const name = String(p.tool ?? "");
        const args = (p.arguments && typeof p.arguments === "object" ? p.arguments : {}) as Record<string, unknown>;
        const out = await host.callTool(name, args);
        return { contentItems: [{ type: "inputText", text: out.text }], success: !out.isError };
      }
      // Anything else that would hand Codex more than the app's rules give: no (shapes from
      // `codex app-server generate-ts`, 0.153.4). More sandbox access is granted none.
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: { denied: { rejection: host.locale === "en" ? "Deskfolk answers approvals through its own rules" : "Deskfolk 按自己的规则批准" } } };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      case "item/tool/requestUserInput":
        throw new Error("ask the user with the deskfolk tool ask_user");
      default:
        throw new Error(`${method} is not supported by Deskfolk`);
    }
  });

  rpc.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    // An item is noted at once, before an approval request that follows it in the same read is
    // answered: a file change's request names only the item, and its paths are in the item.
    if (method === "item/started" || method === "item/completed") {
      const item = p.item as Item | undefined;
      if (item?.id) items.set(item.id, { ...(items.get(item.id) ?? {}), ...item });
    }
    void onNotification(method, p);
  });
  let notes = Promise.resolve();
  function onNotification(method: string, p: Record<string, unknown>): Promise<void> {
    notes = notes.then(() => handle(method, p)).catch((error) => console.error("[codex] notification failed", error));
    return notes;
  }
  async function handle(method: string, p: Record<string, unknown>): Promise<void> {
    switch (method) {
      case "item/started": {
        const item = p.item as Item | undefined;
        if (item?.id) items.set(item.id, item);
        return;
      }
      case "item/agentMessage/delta": {
        const delta = typeof p.delta === "string" ? p.delta : "";
        if (delta) {
          lastText += delta;
          await emit({ type: "partial", text: lastText });
        }
        return;
      }
      case "item/completed": {
        const item = p.item as Item | undefined;
        if (!item?.id) return;
        items.set(item.id, item);
        if (item.type === "agentMessage") {
          const text = typeof item.text === "string" ? item.text : "";
          lastText = "";
          // The final answer is the reply; words beside its work are the step's own.
          if (item.phase === "final_answer") finalText = text;
          else await emit({ type: "hop", id: item.id, text, calls: [] });
          return;
        }
        const action = actionOf(item);
        if (!action) return;
        await emit({ type: "hop", id: `${item.id}:hop`, text: "", calls: [{ id: item.id, name: action.appName, arguments: JSON.stringify(action.command ? { command: action.command } : { paths: action.paths }) }] });
        const wasGated = gated.has(item.id);
        if (!wasGated && !audited.has(item.id) && item.status !== "declined") {
          audited.add(item.id);
          await emit({ type: "tool_started", callId: item.id, action, gated: false });
        }
        const ok = item.status === "completed" && (typeof item.exitCode !== "number" || item.exitCode === 0);
        const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : item.status === "declined" ? "declined" : "";
        await emit({ type: "tool_finished", callId: item.id, action, gated: wasGated || audited.has(item.id), ok, output, exitCode: typeof item.exitCode === "number" ? item.exitCode : null });
        return;
      }
      case "thread/tokenUsage/updated": {
        const total = ((p.tokenUsage ?? {}) as { total?: Record<string, number> }).total;
        if (total) {
          await emit({ type: "usage", model, input: total.inputTokens ?? 0, output: (total.outputTokens ?? 0), cached: total.cachedInputTokens ?? 0, costUsd: null, cumulative: true });
        }
        return;
      }
      case "account/rateLimits/updated": {
        const limits = (p.rateLimits ?? {}) as { rateLimitReachedType?: unknown; primary?: { resetsAt?: number } };
        if (limits.rateLimitReachedType) await emit({ type: "limit", reset: resetText(limits.primary?.resetsAt, host.locale) });
        return;
      }
      case "error": {
        const error = (p.error ?? {}) as { message?: string; codexErrorInfo?: unknown };
        if (p.willRetry !== true) failure = classifyCodexError(error);
        return;
      }
      case "turn/completed": {
        const turn = (p.turn ?? {}) as { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null };
        turnDone?.(turn);
        return;
      }
      default:
        return;
    }
  }

  // --- start ---------------------------------------------------------------------------------
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, INIT_TIMEOUT_MS);
    rpc.notify("initialized");
    const account = await rpc.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken: false }, INIT_TIMEOUT_MS);
    if (!account?.account && account?.requiresOpenaiAuth !== false) {
      throw new AgentStartError("agent_signed_out", host.locale === "en" ? "run codex login in a terminal" : "在终端里运行 codex login");
    }
    // Your own MCP servers, each switched off for this thread by name. Those a plugin brings go off
    // with the plugins; an entry the config cannot take an override for is left out and asked again.
    const servers = await rpc.request<{ data?: Array<{ name?: string; pluginId?: string | null }> }>("mcpServerStatus/list", {}, INIT_TIMEOUT_MS).catch(() => ({ data: [] }));
    const mcpOff: Record<string, { enabled: false }> = Object.fromEntries((servers.data ?? [])
      .flatMap((server) => (typeof server.name === "string" && !server.pluginId ? [[server.name, { enabled: false }]] : [])));
    const startParams = () => ({
      cwd: host.cwd,
      ...(host.model ? { model: host.model } : {}),
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      ephemeral: true,
      serviceName: "deskfolk",
      developerInstructions: host.instructions,
      config: { ...ISOLATION, ...(Object.keys(mcpOff).length > 0 ? { mcp_servers: mcpOff } : {}) },
      ...(host.tools.length > 0 ? { dynamicTools: host.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: { type: "object", ...tool.inputSchema } })) } : {}),
    });
    let started: { thread?: { id?: string }; model?: string } | undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        started = await rpc.request<{ thread?: { id?: string }; model?: string }>("thread/start", startParams(), INIT_TIMEOUT_MS);
        break;
      } catch (error) {
        const named = /in `mcp_servers\.([^`]+)`/.exec(error instanceof Error ? error.message : "")?.[1];
        if (!named || !(named in mcpOff) || attempt >= 8) throw error;
        delete mcpOff[named];
      }
    }
    threadId = started?.thread?.id ?? null;
    if (started?.model) {
      model = started.model;
      await emit({ type: "model", model });
    }
    if (!threadId) throw new Error("Codex opened no thread");
  } catch (error) {
    rpc.close();
    child.kill("SIGTERM");
    if (error instanceof AgentStartError) throw error;
    const classified = classifyCodexError({ message: error instanceof Error ? error.message : String(error) });
    throw new AgentStartError(classified.failKind, classified.detail);
  }

  const toInput = (input: AgentInputPart[]) => input.map((part) => (part.type === "text"
    ? { type: "text", text: part.text, text_elements: [] }
    : { type: "image", url: `data:${part.mediaType};base64,${part.data}` }));

  async function pump(): Promise<void> {
    if (inFlight || closed || !threadId) return;
    const next = queue.shift();
    if (!next) return;
    inFlight = true;
    interrupted = false;
    finalText = "";
    lastText = "";
    failure = null;
    const finished = new Promise<{ status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null }>((resolve) => { turnDone = resolve; });
    let result: Extract<AgentEvent, { type: "result" }>;
    try {
      const started = await rpc.request<{ turn?: { id?: string } }>("turn/start", {
        threadId, input: toInput(next), ...(host.effort ? { effort: host.effort } : {}),
      });
      turnId = started?.turn?.id ?? null;
      const turn = await Promise.race([finished, done.then(() => ({ status: "exited" as const, error: null }))]);
      await notes;
      if (turn.status === "completed") result = { type: "result", result: { kind: "reply", text: finalText || lastText } };
      else if (turn.status === "interrupted" || interrupted) result = { type: "result", result: { kind: "cancelled" } };
      else if (turn.status === "exited") result = { type: "result", result: { kind: "error", failKind: "agent_exited", detail: null } };
      else {
        const classified = failure ?? classifyCodexError(turn.error ?? {});
        result = { type: "result", result: { kind: "error", ...classified } };
      }
    } catch (error) {
      const classified = classifyCodexError({ message: error instanceof Error ? error.message : String(error) });
      result = { type: "result", result: { kind: "error", ...classified } };
    }
    turnDone = null;
    turnId = null;
    inFlight = false;
    await emit(result);
    void pump();
  }

  const session: AgentSession = {
    prompt(input) {
      queue.push(input);
      void pump();
    },
    async cancel() {
      if (!inFlight || !threadId || !turnId || rpc.closed) return false;
      interrupted = true;
      try {
        await rpc.request("turn/interrupt", { threadId, turnId }, 10_000);
        return true;
      } catch {
        return false;
      }
    },
    async steer(input) {
      if (!inFlight || !threadId || !turnId || rpc.closed) return false;
      try {
        await rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: toInput(input) }, 10_000);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      rpc.close();
      child.kill("SIGTERM");
    },
    done,
  };
  session.prompt(first);
  return session;
}

/** Codex's error, as the app files it: signed out, out of usage, or something else that ended it. */
export function classifyCodexError(error: { message?: string; codexErrorInfo?: unknown }): { failKind: FailKind; detail: string | null } {
  const info = typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : error.codexErrorInfo && typeof error.codexErrorInfo === "object" ? Object.keys(error.codexErrorInfo)[0] ?? "" : "";
  const message = error.message ?? "";
  const detail = message.trim() ? message.trim().split(/\r?\n/)[0]!.slice(0, 200) : info || null;
  if (info === "unauthorized" || /unauthori[sz]ed|not logged in|log ?in|sign ?in|401/i.test(message)) return { failKind: "agent_signed_out", detail };
  if (["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"].includes(info) || /usage limit|rate limit|quota|credits/i.test(message)) return { failKind: "agent_limit", detail };
  return { failKind: "agent_exited", detail };
}

function resetText(resetsAt: number | undefined, locale: "zh" | "en"): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt * (resetsAt < 1e12 ? 1000 : 1));
  const time = at.toLocaleString(locale === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return locale === "en" ? `resets ${time}` : `${time} 重置`;
}
