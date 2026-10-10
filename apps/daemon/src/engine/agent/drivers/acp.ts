/**
 * Agents that speak the Agent Client Protocol (ADR 0079): Grok (`grok agent --no-leader stdio`),
 * OpenCode (`opencode acp`), DSH (`dsh --profile acp`), ZCode through its ACP bridge, and any ACP
 * command of your own. The app is the ACP client: it offers to read and write files and run
 * commands for the agent (`fs/*`, `terminal/*`), which puts those calls through the app's rules
 * before they run; it answers the agent's permission requests by the same rules; it mounts the
 * app's own tools as the agent's `deskfolk` MCP server. A call the agent ran on its own is reported
 * by its `tool_call` updates and checked then.
 *
 * Measured on 2026-10-10 (this Mac): Grok 1.0.46 has the app read, write and run everything and asks
 * nothing else; OpenCode 2.0.22 never uses the app's fs/terminal and, told to ask for everything
 * (`OPENCODE_CONFIG_CONTENT`, never written to disk), asks before every command and edit; both take
 * the tools over HTTP MCP and hold a call 150 s without cutting it.
 */
import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import type { AgentInputPart } from "../../../context";
import type { FailKind } from "../../../prompts";
import daemonPackage from "../../../../package.json";
import type { AgentDriver, AgentEvent, AgentHost, AgentSession, AppTerminal, DriverCaps } from "../driver";
import { agentTrace } from "../trace";
import { RpcError, rpcPeer, type RpcPeer } from "../jsonrpc";
import { absoluteFrom, unwrapShell, type AppAction, type AppActionName } from "../policy";
import { noteAgentModels } from "../../../agents/status";

/** How one ACP agent is started and set up, beside what every ACP agent shares. */
export type AcpProfile = {
  /** How this agent reaches the app's tools, for the preface. */
  toolHint?: { zh: string; en: string };
  /** Arguments around the launch's own (`grok agent --no-leader stdio`): the model and effort when the agent takes them as flags. */
  args?(host: AgentHost, base: string[]): string[];
  /** Environment the agent needs for this turn (OpenCode's ask-for-everything permissions). */
  env?(host: AgentHost): Record<string, string>;
  /** The model and effort set as flags: not set again over the protocol. */
  modelByFlag?: boolean;
};

type ToolRecord = {
  id: string;
  kind: string | null;
  title: string;
  rawInput: Record<string, unknown> | null;
  locations: string[];
  status: string | null;
  /** The app decided on it: a permission it asked for. */
  gated: boolean;
  /** The app carried it out itself (`fs/*`, `terminal/*`) and keeps its records: nothing more is done for it here. */
  covered: boolean;
  /** Its start was reported (checked, if it was never gated). */
  started: boolean;
  finished: boolean;
  output: string;
};

const INIT_TIMEOUT_MS = 60_000;
const NEW_SESSION_TIMEOUT_MS = 120_000;

export function acpDriver(profile: AcpProfile = {}): AgentDriver {
  const caps: DriverCaps = { midTurn: "hold", sendNow: true, appTools: true, appRunsFiles: true };
  return {
    caps,
    ...(profile.toolHint ? { toolHint: profile.toolHint } : {}),
    async start(host, first) {
      const args = profile.args ? profile.args(host, host.launchArgs) : host.launchArgs;
      const env = { ...host.env, ...(profile.env?.(host) ?? {}) };
      const child = host.spawn(host.executable, args, { cwd: host.cwd, env });
      return acpSession(host, child, first, profile);
    },
  };
}

async function acpSession(host: AgentHost, child: ChildProcess, first: AgentInputPart[], profile: AcpProfile): Promise<AgentSession> {
  const done = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      host.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve();
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => host.stderr(chunk));
  const rpc = rpcPeer(child.stdout!, child.stdin!, { jsonrpc: true, trace: agentTrace(host.turnId) });
  void done.then(() => rpc.close(new Error("the agent exited")));

  const tools = new Map<string, ToolRecord>();
  const terminals = new Map<string, { term: AppTerminal; callId: string; action: AppAction; finished: boolean }>();
  let sessionId: string | null = null;
  let inFlight = false;
  let cancelled = false;
  let closed = false;
  /** Words since the last tool call: the reply, if the prompt ends here. */
  let said = "";
  let messageSeq = 0;
  let localSeq = 0;
  let canSeeImages = false;
  const queue: AgentInputPart[][] = [];

  const emit = (event: AgentEvent) => host.emit(event);

  // --- what the agent asks of the app ----------------------------------------------------------
  rpc.onRequest(async (method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "session/request_permission":
        return permission(p);
      case "fs/read_text_file":
        return readText(p);
      case "fs/write_text_file":
        return writeText(p);
      case "terminal/create":
        return createTerminal(p);
      case "terminal/output": {
        const entry = terminals.get(String(p.terminalId));
        if (!entry) throw new RpcError(-32602, "no such terminal");
        const out = entry.term.output();
        return { output: out.output, truncated: out.truncated, exitStatus: out.done ? { exitCode: out.exitCode, signal: out.signal } : null };
      }
      case "terminal/wait_for_exit": {
        const entry = terminals.get(String(p.terminalId));
        if (!entry) throw new RpcError(-32602, "no such terminal");
        const exit = await entry.term.waitForExit();
        await finishTerminal(String(p.terminalId));
        return { exitCode: exit.exitCode, signal: exit.signal };
      }
      case "terminal/kill": {
        terminals.get(String(p.terminalId))?.term.kill();
        return {};
      }
      case "terminal/release": {
        const entry = terminals.get(String(p.terminalId));
        if (entry) {
          entry.term.kill();
          await finishTerminal(String(p.terminalId));
          terminals.delete(String(p.terminalId));
        }
        return {};
      }
      default:
        throw new RpcError(-32601, `${method} is not supported by Deskfolk`);
    }
  });

  async function permission(p: Record<string, unknown>) {
    const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
    const record = noteTool(toolCall);
    record.gated = true;
    const options = Array.isArray(p.options) ? (p.options as Array<{ optionId: string; kind: string }>) : [];
    if (cancelled || closed) return { outcome: { outcome: "cancelled" } };
    const answer = await host.gate(record.id, actionOf(record));
    // Only ever once: an "always" answer could be kept in the agent's own config.
    const pick = answer.kind === "allow"
      ? options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind.startsWith("allow"))
      : options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind.startsWith("reject"));
    if (!pick) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: pick.optionId } };
  }

  /**
   * The open tool call an fs/terminal request belongs to: the one naming the same file or command,
   * else the latest of the kind asked for, else of a fitting kind. Agents run calls side by side
   * (Grok read `/etc/hosts` beside another call, 2026-10-10), so the latest alone can be the wrong one.
   */
  function attribute(kinds: string[], match: { path?: string; command?: string } = {}): ToolRecord | null {
    const open = [...tools.values()].filter((record) => !record.finished && !record.covered).reverse();
    if (match.path) {
      const real = realOf(match.path);
      const named = open.find((record) => record.locations.some((location) => realOf(absoluteFrom(host.cwd, location)) === real)
        || pathsOf(record.rawInput ?? {}).some((path) => realOf(absoluteFrom(host.cwd, path)) === real));
      if (named) return named;
    }
    if (match.command) {
      const named = open.find((record) => typeof record.rawInput?.command === "string" && record.rawInput.command.trim() === match.command!.trim());
      if (named) return named;
    }
    return open.find((record) => record.kind === kinds[0]) ?? open.find((record) => record.kind !== null && kinds.includes(record.kind)) ?? null;
  }
  /** What the app already decided on and carried out in this session: a call reported later naming only these needs no check. */
  const handled = { paths: new Set<string>(), commands: new Set<string>() };
  const alreadyHandled = (action: AppAction) => action.appName === "shell"
    ? Boolean(action.command && handled.commands.has(action.command.trim()))
    : action.paths.length > 0 && action.paths.every((path) => handled.paths.has(realOf(path)));

  async function readText(p: Record<string, unknown>) {
    const path = String(p.path ?? "");
    const owner = attribute(["read", "search", "edit", "other"], { path });
    if (owner) owner.covered = true;
    const callId = `acp_fs_${++localSeq}`;
    const action: AppAction = { appName: "read_file", vendorTool: owner?.title || "read", paths: [path], cwd: host.cwd };
    const answer = await host.gate(callId, action);
    if (answer.kind === "deny") {
      await emit({ type: "tool_finished", callId, action, gated: true, ok: false, output: answer.reason });
      throw new RpcError(-32000, answer.reason);
    }
    handled.paths.add(realOf(path));
    try {
      const content = await host.readFile(path, typeof p.line === "number" ? p.line : null, typeof p.limit === "number" ? p.limit : null);
      await emit({ type: "tool_finished", callId, action, gated: true, ok: true, output: `${content.length} characters` });
      return { content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emit({ type: "tool_finished", callId, action, gated: true, ok: false, output: message });
      throw new RpcError(-32000, message);
    }
  }

  async function writeText(p: Record<string, unknown>) {
    const path = String(p.path ?? "");
    const owner = attribute(["edit", "delete", "move", "other"], { path });
    if (owner) owner.covered = true;
    const callId = `acp_fs_${++localSeq}`;
    const action: AppAction = { appName: "write_file", vendorTool: owner?.title || "write", paths: [path], cwd: host.cwd };
    const answer = await host.gate(callId, action);
    if (answer.kind === "deny") {
      await emit({ type: "tool_finished", callId, action, gated: true, ok: false, output: answer.reason });
      throw new RpcError(-32000, answer.reason);
    }
    handled.paths.add(realOf(path));
    try {
      await host.writeFile(path, typeof p.content === "string" ? p.content : "");
      await emit({ type: "tool_finished", callId, action, gated: true, ok: true, output: "written" });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emit({ type: "tool_finished", callId, action, gated: true, ok: false, output: message });
      throw new RpcError(-32000, message);
    }
  }

  async function createTerminal(p: Record<string, unknown>) {
    const command = String(p.command ?? "");
    const args = Array.isArray(p.args) ? p.args.map(String) : [];
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : host.cwd;
    const unwrapped = unwrapShell(command, args);
    const owner = attribute(["execute", "other"], { command: unwrapped });
    if (owner) owner.covered = true;
    const callId = `acp_term_${++localSeq}`;
    // The command the rules read is what the agent asked for, not the shell around it.
    const inner = owner && typeof owner.rawInput?.command === "string" ? owner.rawInput.command : unwrapped;
    const action: AppAction = { appName: "shell", vendorTool: owner?.title || "terminal", paths: [], command: inner, cwd };
    const answer = await host.gate(callId, action);
    if (answer.kind === "deny") {
      await emit({ type: "tool_finished", callId, action, gated: true, ok: false, output: answer.reason });
      throw new RpcError(-32000, answer.reason);
    }
    const env: Record<string, string> = { ...host.env };
    if (Array.isArray(p.env)) for (const entry of p.env as Array<{ name?: unknown; value?: unknown }>) {
      if (typeof entry.name === "string" && typeof entry.value === "string") env[entry.name] = entry.value;
    }
    handled.commands.add(inner.trim());
    const term = host.runCommand(command, args, { cwd, env, outputByteLimit: typeof p.outputByteLimit === "number" ? p.outputByteLimit : null });
    const terminalId = `term_${localSeq}`;
    terminals.set(terminalId, { term, callId, action, finished: false });
    return { terminalId };
  }

  async function finishTerminal(terminalId: string) {
    const entry = terminals.get(terminalId);
    if (!entry || entry.finished) return;
    entry.finished = true;
    const out = entry.term.output();
    await emit({ type: "tool_finished", callId: entry.callId, action: entry.action, gated: true, ok: out.done && out.exitCode === 0, output: out.output, exitCode: out.exitCode });
  }

  // --- what the agent reports ----------------------------------------------------------------
  function noteTool(update: Record<string, unknown>): ToolRecord {
    const id = String(update.toolCallId ?? `acp_tool_${++localSeq}`);
    let record = tools.get(id);
    if (!record) {
      record = { id, kind: null, title: "", rawInput: null, locations: [], status: null, gated: false, covered: false, started: false, finished: false, output: "" };
      tools.set(id, record);
    }
    if (typeof update.kind === "string") record.kind = update.kind;
    if (typeof update.title === "string" && update.title) record.title = update.title;
    if (update.rawInput && typeof update.rawInput === "object") record.rawInput = { ...(record.rawInput ?? {}), ...(update.rawInput as Record<string, unknown>) };
    if (Array.isArray(update.locations) && update.locations.length > 0) {
      record.locations = (update.locations as Array<{ path?: unknown }>).flatMap((location) => (typeof location.path === "string" ? [location.path] : []));
    }
    if (typeof update.status === "string") record.status = update.status;
    const text = textOfContent(update.content) ?? textOfRaw(update.rawOutput);
    if (text) record.output = text;
    return record;
  }

  /** What a tool call does, as the app counts it, from its kind, the files it names and its input. */
  function actionOf(record: ToolRecord): AppAction {
    const raw = record.rawInput ?? {};
    const command = typeof raw.command === "string" ? raw.command : typeof raw.cmd === "string" ? raw.cmd : null;
    const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : host.cwd;
    const paths = record.locations.length > 0 ? record.locations : pathsOf(raw);
    const name: AppActionName = record.kind === "execute" || (command && record.kind !== "read")
      ? "shell"
      : record.kind === "edit" || record.kind === "delete" || record.kind === "move" ? "write_file"
      : record.kind === "read" ? "read_file"
      : record.kind === "search" ? "list_dir"
      : record.kind === "fetch" ? "web"
      : paths.length > 0 ? "read_file" : "other";
    return {
      appName: name,
      vendorTool: record.title || record.kind || "tool",
      paths: name === "shell" ? [] : paths.map((path) => absoluteFrom(cwd, path)),
      ...(name === "shell" ? { command: command ?? record.title } : {}),
      cwd,
      background: raw.is_background === true || raw.run_in_background === true,
    };
  }

  rpc.onNotification((method, params) => {
    if (method !== "session/update") return;
    const update = ((params ?? {}) as { update?: Record<string, unknown> }).update;
    if (!update) return;
    // A tool call is noted at once, before any request that follows it is answered: an fs or
    // terminal request then finds the call it belongs to.
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") noteTool(update);
    void onUpdate(update);
  });

  let updates = Promise.resolve();
  function onUpdate(update: Record<string, unknown>): Promise<void> {
    // In the order they came: a tool's start is checked before its end is recorded.
    updates = updates.then(() => handleUpdate(update)).catch((error) => console.error("[acp] update failed", error));
    return updates;
  }

  async function handleUpdate(update: Record<string, unknown>): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          said += content.text;
          await emit({ type: "partial", text: said });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const record = tools.get(String(update.toolCallId)) ?? noteTool(update);
        if (update.sessionUpdate === "tool_call") {
          // The words before a call are this step's, never the reply.
          await emit({ type: "hop", id: `acp_hop_${++messageSeq}`, text: said, calls: [{ id: record.id, name: record.title || record.kind || "tool", arguments: JSON.stringify(record.rawInput ?? {}) }] });
          said = "";
        }
        // Checked once it is over, not when it says it is under way: OpenCode reports a call in progress
        // before it asks permission for it (measured 2026-10-10).
        const over = record.status === "completed" || record.status === "failed";
        // A call reported after the app already read, wrote or ran just what it names was the app's doing.
        if (over && !record.covered && !record.gated && alreadyHandled(actionOf(record))) record.covered = true;
        if (over && !record.started && !record.covered && !record.gated) {
          record.started = true;
          await emit({ type: "tool_started", callId: record.id, action: actionOf(record), gated: false });
        }
        if ((record.status === "completed" || record.status === "failed") && !record.finished) {
          record.finished = true;
          if (!record.covered) {
            await emit({ type: "tool_finished", callId: record.id, action: actionOf(record), gated: record.gated || record.started, ok: record.status === "completed", output: record.output });
          }
        }
        return;
      }
      case "usage_update": {
        const cost = update.cost as { amount?: unknown } | null | undefined;
        if (cost && typeof cost.amount === "number" && cost.amount > 0) {
          await emit({ type: "usage", model: host.model ?? "", input: 0, output: 0, cached: 0, costUsd: cost.amount, cumulative: true });
        }
        return;
      }
      default:
        return;
    }
  }

  // --- the session ---------------------------------------------------------------------------
  const init = await rpc.request<{ agentCapabilities?: Record<string, unknown> }>("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" },
  }, INIT_TIMEOUT_MS);
  const agentCaps = (init?.agentCapabilities ?? {}) as { mcpCapabilities?: { http?: boolean }; promptCapabilities?: { image?: boolean } };
  canSeeImages = agentCaps.promptCapabilities?.image === true;
  const mcpServers: unknown[] = [];
  if (host.tools.length > 0) {
    if (agentCaps.mcpCapabilities?.http) {
      const mount = host.mountMcp("http") as { url: string; headers: Record<string, string> };
      mcpServers.push({ type: "http", name: "deskfolk", url: mount.url, headers: Object.entries(mount.headers).map(([name, value]) => ({ name, value })) });
    } else {
      const mount = host.mountMcp("stdio") as { command: string; args: string[]; env: Record<string, string> };
      mcpServers.push({ name: "deskfolk", command: mount.command, args: mount.args, env: Object.entries(mount.env).map(([name, value]) => ({ name, value })) });
    }
  }
  let created: { sessionId?: string; configOptions?: Array<Record<string, unknown>>; models?: { availableModels?: Array<{ modelId?: string }> } };
  try {
    created = await rpc.request("session/new", {
      cwd: host.cwd,
      mcpServers,
      ...(host.cwd !== host.workspace ? { additionalDirectories: [host.workspace] } : {}),
    }, NEW_SESSION_TIMEOUT_MS);
  } catch (error) {
    rpc.close();
    child.kill("SIGTERM");
    throw failureError(error);
  }
  sessionId = typeof created?.sessionId === "string" ? created.sessionId : null;
  // The models it offers, kept for Settings: an ACP agent lists them nowhere else (DSH, ZCode, your own).
  try {
    const offered = modelsOffered(created);
    if (offered.models.length > 0) noteAgentModels(host.runner as Exclude<typeof host.runner, "claude_code">, host.custom?.id ?? null, offered.models, offered.current);
  } catch {
    // a convenience
  }
  if (!sessionId) {
    child.kill("SIGTERM");
    throw new Error("the agent opened no session");
  }
  if (!profile.modelByFlag) await configure(created);

  async function configure(result: typeof created): Promise<void> {
    const options = Array.isArray(result.configOptions) ? result.configOptions : [];
    const byCategory = (category: string) => options.find((option) => option.category === category || option.id === category);
    const set = async (option: Record<string, unknown> | undefined, value: string | null) => {
      if (!option || !value || typeof option.id !== "string") return;
      try {
        await rpc.request("session/set_config_option", { sessionId, configId: option.id, value }, 30_000);
      } catch (error) {
        host.stderr(`could not set ${option.id} to ${value}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    };
    if (host.model) {
      const option = byCategory("model");
      if (option) await set(option, host.model);
      else if (result.models?.availableModels?.some((model) => model.modelId === host.model)) {
        try {
          await rpc.request("session/set_model", { sessionId, modelId: host.model }, 30_000);
        } catch {
          // the agent's own model stays
        }
      }
    }
    if (host.effort) await set(byCategory("thought_level") ?? byCategory("reasoning_effort"), host.effort);
  }

  const toBlocks = (input: AgentInputPart[], lead: string | null) => {
    const blocks: unknown[] = [];
    if (lead) blocks.push({ type: "text", text: lead });
    let unseen = 0;
    for (const part of input) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else if (canSeeImages) blocks.push({ type: "image", mimeType: part.mediaType, data: part.data });
      else unseen += 1;
    }
    if (unseen > 0) blocks.push({ type: "text", text: host.locale === "en" ? `(${unseen} picture(s) were attached here; this agent cannot see pictures.)` : `（这里附了 ${unseen} 张图片，这个 Agent 看不了图片。）` });
    return blocks;
  };

  // ACP has no system prompt of its own: the app's instructions open the first prompt.
  let lead: string | null = host.instructions;
  async function pump(): Promise<void> {
    if (inFlight || closed || !sessionId) return;
    const next = queue.shift();
    if (!next) return;
    inFlight = true;
    cancelled = false;
    said = "";
    const blocks = toBlocks(next, lead);
    lead = null;
    let result: AgentEvent & { type: "result" };
    try {
      const answer = await rpc.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt: blocks });
      await updates;
      const stop = answer?.stopReason;
      if (stop === "cancelled" || cancelled) result = { type: "result", result: { kind: "cancelled" } };
      else if (stop === "max_turn_requests") result = { type: "result", result: { kind: "error", failKind: "stuck", detail: null } };
      else result = { type: "result", result: { kind: "reply", text: said } };
    } catch (error) {
      await updates;
      if (cancelled && !rpc.closed) result = { type: "result", result: { kind: "cancelled" } };
      else {
        const classified = classifyAcpError(error);
        result = { type: "result", result: { kind: "error", failKind: classified.failKind, detail: classified.detail } };
      }
    }
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
      if (!inFlight || !sessionId || rpc.closed) return false;
      cancelled = true;
      rpc.notify("session/cancel", { sessionId });
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of terminals.values()) entry.term.kill();
      // A session left on record in the agent's own history serves nobody: closed where the agent can.
      if (sessionId && !rpc.closed) {
        void rpc.request("session/close", { sessionId }, 2_000).catch(() => {});
      }
      setTimeout(() => {
        rpc.close();
        child.kill("SIGTERM");
      }, 200).unref?.();
    },
    done,
  };
  session.prompt(first);
  return session;
}

/** A failure the agent answered with, as the app files it. */
export function classifyAcpError(error: unknown): { failKind: FailKind; detail: string | null } {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.trim() ? message.trim().split(/\r?\n/)[0]!.slice(0, 200) : null;
  if (/insufficient balance|quota|rate.?limit|usage limit|credits? (?:exhausted|used up)|billing|exceeded your|too many requests/i.test(message)) return { failKind: "agent_limit", detail };
  if ((error instanceof RpcError && error.code === -32000) || /auth|log ?in|sign ?in|credential|unauthori[sz]ed|forbidden/i.test(message)) return { failKind: "agent_signed_out", detail };
  return { failKind: "agent_exited", detail };
}

/** An error thrown at start, carrying how it should fail the turn. */
export class AgentStartError extends Error {
  constructor(readonly failKind: FailKind, readonly detail: string | null) {
    super(detail ?? failKind);
  }
}

function failureError(error: unknown): AgentStartError {
  const classified = classifyAcpError(error);
  return new AgentStartError(classified.failKind, classified.detail);
}

function textOfContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((entry) => {
    const inner = (entry as { content?: { type?: string; text?: string } }).content;
    if (inner?.type === "text" && typeof inner.text === "string") return [inner.text];
    const diff = entry as { type?: string; path?: string };
    if (diff.type === "diff" && typeof diff.path === "string") return [`edited ${diff.path}`];
    return [];
  });
  return texts.length > 0 ? texts.join("\n") : null;
}

function textOfRaw(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const out = raw as { output?: unknown; stdout?: unknown };
    if (typeof out.output === "string") return out.output;
    if (typeof out.stdout === "string") return out.stdout;
  }
  return null;
}

function pathsOf(raw: Record<string, unknown>): string[] {
  const keys = ["path", "file_path", "filePath", "target_file", "AbsolutePath", "TargetFile", "file"];
  const out: string[] = [];
  for (const key of keys) if (typeof raw[key] === "string" && raw[key]) out.push(raw[key] as string);
  if (Array.isArray(raw.files)) {
    for (const file of raw.files as Array<{ file?: unknown; path?: unknown }>) {
      if (typeof file.file === "string") out.push(file.file);
      else if (typeof file.path === "string") out.push(file.path);
    }
  }
  return out;
}

/** A path as the disk resolves it (`/etc/hosts` is `/private/etc/hosts` on macOS); as given when it does not exist. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The models a new session offers: its model select (options, or groups of them), or its `models` list. */
export function modelsOffered(created: { configOptions?: Array<Record<string, unknown>>; models?: { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string; _meta?: { reasoningEfforts?: Array<{ id?: string }> } }> } }): { models: Array<{ id: string; name: string; efforts: string[] }>; current: string | null } {
  const select = (created.configOptions ?? []).find((option) => option.category === "model" || option.id === "model");
  if (select && Array.isArray(select.options)) {
    const flat = (select.options as Array<Record<string, unknown>>).flatMap((option) => (Array.isArray(option.options) ? option.options as Array<Record<string, unknown>> : [option]));
    return {
      models: flat.flatMap((option) => (typeof option.value === "string" ? [{ id: option.value, name: typeof option.name === "string" ? option.name : option.value, efforts: [] }] : [])),
      current: typeof select.currentValue === "string" ? select.currentValue : null,
    };
  }
  const listed = created.models?.availableModels ?? [];
  return {
    models: listed.flatMap((model) => (model.modelId ? [{ id: model.modelId, name: model.name ?? model.modelId, efforts: (model._meta?.reasoningEfforts ?? []).flatMap((effort) => (effort.id ? [effort.id] : [])) }] : [])),
    current: created.models?.currentModelId ?? null,
  };
}
