/**
 * A stand-in ACP agent for the local-agent runner's tests (ADR 0079): it plays a script from
 * `FAKE_ACP_SCRIPT` (JSON), one list of steps per prompt it is sent, against the real client on
 * the other end — the app's `fs/*`, `terminal/*`, permission answers and its tools' MCP route —
 * and writes what it saw to `FAKE_ACP_LOG` (one JSON object per line) for the test to read.
 *
 * Steps: `{ say }` a chunk of the reply; `{ read: path }`, `{ write: { path, content } }`,
 * `{ run: command }` through the app; `{ ask: { kind, title, rawInput, locations } }` a permission
 * request for a call it then runs (or not) itself; `{ unasked: { kind, title, rawInput, locations } }`
 * a call it runs without asking; `{ tool: { name, args } }` one of the app's tools over MCP;
 * `{ wait: ms }`; `{ fail: { code, message } }` the prompt fails; `{ hang: true }` until cancelled.
 */
import { appendFileSync } from "node:fs";
import { rpcPeer, RpcError } from "../../engine/agent/jsonrpc";

type Step =
  | { say: string }
  | { read: string }
  | { write: { path: string; content: string } }
  | { run: string }
  | { ask: { kind: string; title: string; rawInput?: Record<string, unknown>; locations?: Array<{ path: string }> } }
  | { unasked: { kind: string; title: string; rawInput?: Record<string, unknown>; locations?: Array<{ path: string }> } }
  | { tool: { name: string; args?: Record<string, unknown> } }
  | { wait: number }
  | { fail: { code: number; message: string } }
  | { hang: true }
  /** Grok's shape (2026-10-10): the read reported with no kind, another call beside it, then the app's read. */
  | { sideRead: string };

type Script = { newSession?: { fail?: { code: number; message: string } }; http?: boolean; prompts: Step[][] };

const script = JSON.parse(process.env.FAKE_ACP_SCRIPT ?? '{"prompts":[]}') as Script;
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
};
const rpc = rpcPeer(process.stdin, process.stdout, { jsonrpc: true });
let mcpUrl: string | null = null;
let promptIndex = 0;
let cancelled = false;
let toolSeq = 0;
let sessionId = "fake-session";

const update = (u: Record<string, unknown>) => rpc.notify("session/update", { sessionId, update: u });

/** A stdio MCP server it was given (the daemon's `--agent-mcp` shim), when it takes no HTTP. */
let stdioMcp: { send(message: unknown): Promise<unknown> } | null = null;
function startStdioMcp(server: { command: string; args?: string[]; env?: Array<{ name: string; value: string }> }) {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const entry of server.env ?? []) env[entry.name] = entry.value;
  const proc = Bun.spawn([server.command, ...(server.args ?? [])], { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const waiting = new Map<number, (value: unknown) => void>();
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) waiting.get(message.id)?.(message);
      }
    }
  })();
  stdioMcp = {
    send(message) {
      const id = (message as { id: number }).id;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        proc.stdin.flush();
      });
    },
  };
}

async function mcp(method: string, params: unknown): Promise<unknown> {
  if (stdioMcp) {
    const body = await stdioMcp.send({ jsonrpc: "2.0", id: ++toolSeq, method, params }) as { result?: unknown; error?: unknown };
    return body.result ?? body.error;
  }
  if (!mcpUrl) throw new Error("no MCP server was mounted");
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++toolSeq, method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: unknown };
  return body.result ?? body.error;
}

rpc.onRequest(async (method, params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  log({ method, params: p });
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: { loadSession: false, mcpCapabilities: { http: script.http !== false }, promptCapabilities: { image: true } }, authMethods: [] };
    case "session/new": {
      if (script.newSession?.fail) throw new RpcError(script.newSession.fail.code, script.newSession.fail.message);
      // `@CWD` in the script is the directory the session was opened in.
      const cwd = String(p.cwd ?? process.cwd());
      script.prompts = JSON.parse(JSON.stringify(script.prompts).replaceAll("@CWD", cwd)) as Step[][];
      const servers = (p.mcpServers ?? []) as Array<{ type?: string; url?: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
      mcpUrl = servers.find((server) => server.type === "http")?.url ?? null;
      const stdio = servers.find((server) => !server.type && server.command);
      if (stdio) startStdioMcp(stdio as { command: string; args?: string[]; env?: Array<{ name: string; value: string }> });
      sessionId = "fake-session-1";
      return { sessionId, configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fake-default", options: [] }] };
    }
    case "session/set_config_option":
      return { configOptions: [] };
    case "session/close":
      return {};
    case "session/prompt": {
      const steps = script.prompts[promptIndex++] ?? [{ say: "(no more script)" }];
      cancelled = false;
      for (const step of steps) {
        if (cancelled) return { stopReason: "cancelled" };
        if ("say" in step) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
        else if ("read" in step) {
          const id = `call_${++toolSeq}`;
          update({ sessionUpdate: "tool_call", toolCallId: id, title: `Read ${step.read}`, kind: "read", status: "pending", locations: [{ path: step.read }] });
          try {
            const out = await rpc.request<{ content: string }>("fs/read_text_file", { sessionId, path: step.read });
            log({ read: step.read, content: out.content });
            update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
          } catch (error) {
            log({ read: step.read, error: String(error) });
            update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
          }
        } else if ("write" in step) {
          const id = `call_${++toolSeq}`;
          update({ sessionUpdate: "tool_call", toolCallId: id, title: `Write ${step.write.path}`, kind: "edit", status: "pending", locations: [{ path: step.write.path }] });
          try {
            await rpc.request("fs/write_text_file", { sessionId, path: step.write.path, content: step.write.content });
            log({ wrote: step.write.path });
            update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
          } catch (error) {
            log({ wrote: step.write.path, error: String(error) });
            update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
          }
        } else if ("run" in step) {
          const id = `call_${++toolSeq}`;
          update({ sessionUpdate: "tool_call", toolCallId: id, title: `Run ${step.run}`, kind: "execute", status: "pending", rawInput: { command: step.run } });
          try {
            const created = await rpc.request<{ terminalId: string }>("terminal/create", { sessionId, command: "/bin/sh", args: ["-c", step.run] });
            const exit = await rpc.request<{ exitCode: number | null }>("terminal/wait_for_exit", { sessionId, terminalId: created.terminalId });
            const out = await rpc.request<{ output: string }>("terminal/output", { sessionId, terminalId: created.terminalId });
            await rpc.request("terminal/release", { sessionId, terminalId: created.terminalId });
            log({ ran: step.run, exitCode: exit.exitCode, output: out.output });
            update({ sessionUpdate: "tool_call_update", toolCallId: id, status: exit.exitCode === 0 ? "completed" : "failed" });
          } catch (error) {
            log({ ran: step.run, error: String(error) });
            update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
          }
        } else if ("ask" in step) {
          const id = `call_${++toolSeq}`;
          const call = { toolCallId: id, title: step.ask.title, kind: step.ask.kind, status: "pending", rawInput: step.ask.rawInput ?? {}, locations: step.ask.locations ?? [] };
          update({ sessionUpdate: "tool_call", ...call });
          const answer = await rpc.request<{ outcome: { outcome: string; optionId?: string } }>("session/request_permission", {
            sessionId, toolCall: call,
            options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always" }, { optionId: "reject", kind: "reject_once", name: "Reject" }],
          });
          log({ asked: step.ask.title, outcome: answer.outcome });
          const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "reject";
          update({ sessionUpdate: "tool_call_update", toolCallId: id, status: allowed ? "in_progress" : "failed" });
          if (allowed) update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { output: "done" } });
        } else if ("unasked" in step) {
          const id = `call_${++toolSeq}`;
          update({ sessionUpdate: "tool_call", toolCallId: id, title: step.unasked.title, kind: step.unasked.kind, status: "pending", rawInput: step.unasked.rawInput ?? {}, locations: step.unasked.locations ?? [] });
          update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
          await new Promise((resolve) => setTimeout(resolve, 20));
          update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
          log({ unasked: step.unasked.title });
        } else if ("tool" in step) {
          const listed = await mcp("tools/list", {}) as { tools?: Array<{ name: string }> };
          log({ listed: (listed.tools ?? []).map((tool) => tool.name) });
          const out = await mcp("tools/call", { name: step.tool.name, arguments: step.tool.args ?? {} });
          log({ tool: step.tool.name, out });
        } else if ("sideRead" in step) {
          const read = `call_${++toolSeq}`;
          const other = `call_${++toolSeq}`;
          update({ sessionUpdate: "tool_call", toolCallId: read, title: "read_file", rawInput: { target_file: step.sideRead } });
          update({ sessionUpdate: "tool_call_update", toolCallId: read, kind: "read", title: `Read ${step.sideRead}`, locations: [{ path: step.sideRead }] });
          update({ sessionUpdate: "tool_call", toolCallId: other, title: "list_dir" });
          update({ sessionUpdate: "tool_call_update", toolCallId: other, kind: "other" });
          try {
            const out = await rpc.request<{ content: string }>("fs/read_text_file", { sessionId, path: step.sideRead });
            log({ read: step.sideRead, content: out.content });
          } catch (error) {
            log({ read: step.sideRead, error: String(error) });
          }
          update({ sessionUpdate: "tool_call_update", toolCallId: other, status: "completed" });
          update({ sessionUpdate: "tool_call_update", toolCallId: read, status: "completed" });
        } else if ("wait" in step) await new Promise((resolve) => setTimeout(resolve, step.wait));
        else if ("fail" in step) throw new RpcError(step.fail.code, step.fail.message);
        else if ("hang" in step) {
          while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 20));
          return { stopReason: "cancelled" };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    }
    default:
      throw new RpcError(-32601, `no ${method}`);
  }
});
rpc.onNotification((method, params) => {
  log({ notification: method, params });
  if (method === "session/cancel") cancelled = true;
});
process.stdin.on("end", () => process.exit(0));
