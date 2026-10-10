/**
 * Your Antigravity CLI (`agy`) in its print mode (ADR 0079): one process per segment, reading one
 * NDJSON message per prompt (`{"event":"user","message":{"role":"user","content":…}}`, measured
 * 2026-10-10 with 1.3.2) and reporting its steps as NDJSON events, a `result` per prompt.
 *
 * Print mode has no way for the app to come in before a call: no permission callback, no
 * per-session MCP. So it runs with `agy`'s own terminal sandbox (`--sandbox`, which keeps its
 * commands' reads out of `~/.ssh` and the like), every call it reports is checked as it starts,
 * and one outside the workspace or on credentials stops the turn. Nor can it reach the app's own
 * tools: an Antigravity Bot answers with its closing reply, nothing more. Its tool permission is
 * the one you set for `agy` (`toolPermission` in its settings), which the app does not change.
 */
import type { ChildProcess } from "node:child_process";
import type { AgentInputPart } from "../../../context";
import type { AgentDriver, AgentEvent, AgentHost, AgentSession, DriverCaps } from "../driver";
import { absoluteFrom, unwrapShell, type AppAction } from "../policy";
import { classifyAcpError } from "./acp";

export function agyDriver(): AgentDriver {
  const caps: DriverCaps = { midTurn: "hold", sendNow: false, appTools: false, appRunsFiles: false };
  return {
    caps,
    async start(host, first) {
      const args = [
        ...host.launchArgs,
        "--input-format", "stream-json", "--output-format", "stream-json", "--sandbox", "--disable-slash-commands",
        ...(host.model ? ["--model", host.model] : []),
        ...(host.effort ? ["--effort", host.effort] : []),
        ...(host.cwd !== host.workspace ? ["--add-dir", host.workspace] : []),
        // Print mode reads its prompts from stdin with an empty one here.
        "--print=",
      ];
      const child = host.spawn(host.executable, args, { cwd: host.cwd, env: host.env });
      return agySession(host, child, first);
    },
  };
}

type Step = { index: number; type: string; tool?: string; parameters?: Record<string, unknown>; started: boolean };

async function agySession(host: AgentHost, child: ChildProcess, first: AgentInputPart[]): Promise<AgentSession> {
  const done = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      host.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve();
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => host.stderr(chunk));
  const emit = (event: AgentEvent) => host.emit(event);
  const steps = new Map<string, Step>();
  let conversation = "";
  let said = "";
  let closed = false;
  let inFlight = false;
  let lead: string | null = host.instructions;
  const queue: AgentInputPart[][] = [];
  let settle: ((event: Extract<AgentEvent, { type: "result" }>) => void) | null = null;

  let buffer = "";
  let chain = Promise.resolve();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      chain = chain.then(() => onEvent(message)).catch((error) => console.error("[agy] event failed", error));
    }
  });

  const actionOf = (step: Step): AppAction => {
    const p = step.parameters ?? {};
    const cwd = typeof p.Cwd === "string" && p.Cwd ? p.Cwd : host.cwd;
    const paths = ["AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "Path", "File"].flatMap((key) => (typeof p[key] === "string" && p[key] ? [absoluteFrom(cwd, p[key] as string)] : []));
    const tool = step.tool ?? "tool";
    if (tool === "run_command" || typeof p.CommandLine === "string") {
      return { appName: "shell", vendorTool: tool, paths: [], command: unwrapShell(String(p.CommandLine ?? "")), cwd };
    }
    if (/write|replace|edit|sed_file|delete|move|notebook_edit/.test(tool)) return { appName: "write_file", vendorTool: tool, paths, cwd };
    if (/view_file|read/.test(tool)) return { appName: "read_file", vendorTool: tool, paths, cwd };
    if (/list_dir|find|grep|search_file/.test(tool)) return { appName: "list_dir", vendorTool: tool, paths, cwd };
    if (/search_web|read_url|browser/.test(tool)) return { appName: "web", vendorTool: tool, paths: [], cwd };
    return { appName: paths.length > 0 ? "read_file" : "other", vendorTool: tool, paths, cwd };
  };

  async function onEvent(message: Record<string, unknown>): Promise<void> {
    if (message.event === "init") {
      conversation = String(message.conversation_id ?? "");
      return;
    }
    if (message.event === "step_update") {
      const update = (message.step_update ?? {}) as Record<string, unknown>;
      const key = `${update.conversation_id ?? conversation}:${update.step_index}`;
      if (update.step_type === "agent_response") {
        if (typeof update.text_delta === "string") {
          said += update.text_delta;
          await emit({ type: "partial", text: said });
        }
        const usage = update.usage as Record<string, number> | undefined;
        if (update.state === "DONE" && usage) {
          await emit({ type: "usage", model: host.model ?? "", input: (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0), output: (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0), cached: usage.cache_read_tokens ?? 0, costUsd: null, cumulative: false });
        }
        return;
      }
      if (update.step_type !== "tool") return;
      const info = (update.tool_info ?? {}) as { name?: string; parameters?: Record<string, unknown>; output?: string };
      let step = steps.get(key);
      if (!step) {
        step = { index: Number(update.step_index ?? 0), type: "tool", tool: info.name ?? String(update.tool_name ?? "tool"), parameters: info.parameters, started: false };
        steps.set(key, step);
        // The words before a call are this step's, never the reply.
        await emit({ type: "hop", id: key, text: said, calls: [{ id: key, name: step.tool ?? "tool", arguments: JSON.stringify(step.parameters ?? {}) }] });
        said = "";
      }
      if (info.parameters) step.parameters = info.parameters;
      if (!step.started) {
        step.started = true;
        await emit({ type: "tool_started", callId: key, action: actionOf(step), gated: false });
      }
      if (update.state === "DONE" || update.state === "ERROR" || update.state === "CANCELED") {
        await emit({ type: "tool_finished", callId: key, action: actionOf(step), gated: true, ok: update.state === "DONE", output: typeof info.output === "string" ? info.output : "" });
      }
      return;
    }
    if (message.event === "result") {
      const result = (message.result ?? {}) as { status?: string; response?: string; error?: string };
      if (result.status === "SUCCESS") settle?.({ type: "result", result: { kind: "reply", text: (typeof result.response === "string" ? result.response : said).trim() } });
      else {
        const classified = classifyAcpError(new Error(result.error || result.status || "agy failed"));
        settle?.({ type: "result", result: { kind: "error", ...classified } });
      }
    }
  }

  async function pump(): Promise<void> {
    if (inFlight || closed) return;
    const next = queue.shift();
    if (!next) return;
    inFlight = true;
    said = "";
    const blocks: Array<{ type: "text"; text: string }> = [];
    if (lead) blocks.push({ type: "text", text: lead });
    lead = null;
    let unseen = 0;
    for (const part of next) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else unseen += 1;
    }
    if (unseen > 0) blocks.push({ type: "text", text: host.locale === "en" ? `(${unseen} picture(s) were attached here; they are not passed to this agent.)` : `（这里附了 ${unseen} 张图片，没有交给这个 Agent。）` });
    const result = new Promise<Extract<AgentEvent, { type: "result" }>>((resolve) => { settle = resolve; });
    try {
      child.stdin?.write(`${JSON.stringify({ event: "user", message: { role: "user", content: blocks } })}\n`);
    } catch {
      // the process is gone; its exit ends the turn
    }
    const ended = await Promise.race([result, done.then(() => ({ type: "result" as const, result: { kind: "error" as const, failKind: "agent_exited" as const, detail: null } }))]);
    await chain;
    settle = null;
    inFlight = false;
    await emit(ended);
    void pump();
  }

  const session: AgentSession = {
    prompt(input) {
      queue.push(input);
      void pump();
    },
    async cancel() {
      return false;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      child.kill("SIGTERM");
    },
    done,
  };
  session.prompt(first);
  return session;
}
