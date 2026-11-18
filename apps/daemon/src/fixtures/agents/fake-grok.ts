/**
 * A stand-in `grok agent --no-leader stdio` for project sessions' tests (ADR 0115): ACP over stdin
 * and stdout, shaped as Grok Build 1.0.89 answers (measured 2026-11-18). It plays `FAKE_GROK_SCRIPT`
 * (JSON), one list of steps per `session/prompt`, and writes every request, notification and
 * answer it got to `FAKE_GROK_LOG`.
 *
 * Script: `{ hooks?, sessions?, children?, commands?, gone?, billing?, noCost?, prompts }`.
 * `hooks: false` leaves the client hooks out of `initialize`; `sessions` are the ones it keeps
 * from before (a terminal's), each with its `history`; `children` the records of subagent
 * sessions `_x.ai/session/updates` answers; `gone` sessions it no longer has.
 *
 * Every call goes through the client's `pre_tool_use` hook first, when one was registered
 * (`_x.ai/hooks/run`), logged with its answer: a deny fails the call with "Hook denied: …".
 * Steps: `{ say }`; `{ tool: { name, input } }` a call; `{ background: { command, id, after, output,
 * wake } }` a command sent to the background, ended `after` ms later and followed by a turn of its
 * own saying `wake`; `{ subagent: { child, description, calls, after, output, wake } }`; `{ plan }`
 * its `exit_plan_mode`: the plan sent to the client, the answer logged; `{ question }` its
 * `ask_user_question`; `{ hang: true }` until `session/cancel`; `{ fail: { code, message, data } }`
 * the prompt turned away. Each prompt ends with `turn_completed` (its price unless `noCost`).
 */
import { appendFileSync } from "node:fs";
import { rpcPeer, RpcError } from "../../engine/agent/jsonrpc";

type Call = { name: string; input?: Record<string, unknown> };
type Step =
  | { say: string }
  | { tool: Call }
  | { background: { command: string; id: string; after: number; output?: string; wake?: string; monitor?: boolean } }
  | { subagent: { child: string; description: string; calls?: Call[]; after: number; output?: string; wake?: string } }
  | { plan: string }
  | { question: Array<{ question: string; options: string[]; multi?: boolean }> }
  | { hang: true }
  | { perm: Call }
  | { fail: { code: number; message: string; data?: unknown } };
type Kept = { sessionId: string; cwd: string; title?: string; updatedAt: string; history: Array<{ user?: string; agent?: string; tool?: Call; at: number }> };
type Script = {
  hooks?: boolean;
  sessions?: Kept[];
  children?: Record<string, Array<Record<string, unknown>>>;
  commands?: Array<{ name: string; description: string }>;
  gone?: string[];
  billing?: { creditUsagePercent: number; end: string };
  noCost?: boolean;
  prompts: Step[][];
};

const script = JSON.parse(process.env.FAKE_GROK_SCRIPT ?? '{"prompts":[]}') as Script;
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_GROK_LOG) appendFileSync(process.env.FAKE_GROK_LOG, `${JSON.stringify(entry)}\n`);
};
const rpc = rpcPeer(process.stdin, process.stdout, { jsonrpc: true });
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: { GROK_HOME: process.env.GROK_HOME ?? null } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let promptIndex = 0;
let cancelled = false;
let seq = 0;
let opened: string | null = null;
let hooked = false;
let mode: "default" | "plan" = "default";
let currentModel = "grok-4.7-build-fast";
const commands = [{ name: "compact", description: "Compress conversation history", input: null }, { name: "always-approve", description: "Toggle", input: { hint: "on|off" } }, { name: "loop", description: "Loop", input: null }, ...(script.commands ?? [])];
// As 1.0.89 lists them: grok-4.5 has no xhigh.
const configOptions = () => [
  { id: "model", category: "model", type: "select", currentValue: currentModel, options: [{ value: "grok-4.7", name: "Grok 4.7" }, { value: "grok-4.7-build-fast", name: "Grok 4.7 Fast" }, { value: "grok-4.5", name: "Grok 4.5" }] },
  { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "high", options: [...(currentModel === "grok-4.5" ? [] : [{ value: "xhigh" }]), { value: "high" }, { value: "medium" }, { value: "low" }] },
];
const sessionAnswer = (sessionId: string) => ({ sessionId, configOptions: configOptions(), models: { currentModelId: "grok-4.7-build-fast", availableModels: [] } });
const update = (u: Record<string, unknown>, sessionId = opened) => rpc.notify("session/update", { sessionId, update: u });
const note = (method: string, u: Record<string, unknown>, sessionId = opened) => rpc.notify(method, { sessionId, update: u });
const transcript = (sessionId: string | null) => `/tmp/fake-grok-home/sessions/x/${sessionId}/updates.jsonl`;
const turnDone = (promptId: string, sessionId = opened) => note("_x.ai/session_notification", {
  sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn",
  usage: { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 400, reasoningTokens: 5, ...(script.noCost ? { usageIsIncomplete: true } : { costUsdTicks: 12_345_000 }), modelUsage: { "grok-4.7-build": {} } },
}, sessionId);

/** The client's hook on a call, when one was registered: true when it may run. */
async function hook(call: Call, id: string, sessionId: string | null): Promise<boolean> {
  if (!hooked) return true;
  const answer = await rpc.request<{ decision?: string; reason?: string }>("_x.ai/hooks/run", {
    hookCallbackId: "deskfolk", hookEventName: "pre_tool_use", sessionId, cwd: process.cwd(), workspaceRoot: process.cwd(), transcriptPath: transcript(sessionId),
    permissionMode: mode === "plan" && sessionId === opened ? "plan" : "bypassPermissions", toolName: call.name, toolUseId: id, toolInput: call.input ?? {}, toolInputTruncated: false,
  });
  log({ hook: call.name, sessionId, input: call.input ?? {}, answer });
  if (answer?.decision === "deny") {
    update({ sessionUpdate: "tool_call", toolCallId: id, title: call.name, rawInput: call.input ?? {} }, sessionId);
    update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", content: [{ type: "content", content: { type: "text", text: `Hook denied: ${answer.reason ?? ""}` } }] }, sessionId);
    return false;
  }
  return true;
}

async function call(c: Call, sessionId: string | null = opened): Promise<void> {
  const id = `call-${++seq}`;
  if (!(await hook(c, id, sessionId))) return;
  update({ sessionUpdate: "tool_call", toolCallId: id, title: c.name, rawInput: c.input ?? {}, _meta: { "x.ai/tool": { name: c.name } } }, sessionId);
  await sleep(3);
  update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { ok: true } }, sessionId);
}

async function prompt(steps: Step[], promptId: string): Promise<string> {
  cancelled = false;
  for (const step of steps) {
    if (cancelled) return "cancelled";
    if ("say" in step) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
    else if ("tool" in step) await call(step.tool);
    else if ("background" in step) {
      const b = step.background;
      const id = `call-${++seq}`;
      const name = b.monitor ? "monitor" : "run_terminal_command";
      if (!(await hook({ name, input: { command: b.command, block_until_ms: 0 } }, id, opened))) continue;
      update({ sessionUpdate: "tool_call", toolCallId: id, title: name, rawInput: { command: b.command, block_until_ms: 0 } });
      note("_x.ai/task_backgrounded", { sessionUpdate: "task_backgrounded", tool_call_id: id, task_id: b.id, command: b.command, cwd: process.cwd(), output_file: `/tmp/fake-grok-home/${b.id}.out` });
      note("_x.ai/session_notification", { sessionUpdate: "background_tasks", tasks: [{ task_id: b.id, command: b.command, description: b.command, kind: b.monitor ? "monitor" : "bash", status: "running", started_at: new Date().toISOString() }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", title: `[bg] ${b.command} (${b.id.slice(0, 8)})` });
      const ended = setTimeout(() => {
        if (finished.has(b.id)) return;
        finished.add(b.id);
        note("_x.ai/task_completed", { sessionUpdate: "task_completed", task_snapshot: { task_id: b.id, command: b.command, output: b.output ?? "done\n", exit_code: 0, signal: null, explicitly_killed: false, completed: true, end_time: { secs_since_epoch: Math.floor(Date.now() / 1000) } }, will_wake: Boolean(b.wake) });
        if (b.wake) setTimeout(() => {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: b.wake } });
          turnDone(`task-completed-${b.id}`);
        }, 10);
      }, b.after);
      timers.set(b.id, ended);
    } else if ("subagent" in step) {
      const s = step.subagent;
      const id = `call-${++seq}`;
      if (!(await hook({ name: "spawn_subagent", input: { description: s.description, prompt: "do it", background: true } }, id, opened))) continue;
      update({ sessionUpdate: "tool_call", toolCallId: id, title: "spawn_subagent", rawInput: { description: s.description, prompt: "do it", background: true } });
      note("_x.ai/session_notification", { sessionUpdate: "subagent_spawned", subagent_id: s.child, child_session_id: s.child, parent_session_id: opened, subagent_type: "general-purpose", description: s.description });
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
      void (async () => {
        for (const c of s.calls ?? []) await call(c, s.child);
        turnDone(`child-${s.child}`, s.child);
        await sleep(s.after);
        if (finished.has(s.child)) return;
        finished.add(s.child);
        note("_x.ai/session_notification", { sessionUpdate: "subagent_finished", subagent_id: s.child, child_session_id: s.child, status: "completed", tool_calls: (s.calls ?? []).length, turns: 1, duration_ms: s.after, tokens_used: 1234, output: s.output ?? "found it", will_wake: Boolean(s.wake) });
        if (s.wake) {
          await sleep(10);
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: s.wake } });
          turnDone(`subagent-completed-${s.child}`);
        }
      })();
    } else if ("plan" in step) {
      const id = `call-${++seq}`;
      if (!(await hook({ name: "exit_plan_mode", input: {} }, id, opened))) continue;
      const answer = await rpc.request<{ outcome?: string; feedback?: string }>("_x.ai/exit_plan_mode", { sessionId: opened, toolCallId: id, planContent: step.plan });
      log({ plan: step.plan, answer });
      if (answer?.outcome === "approved" || answer?.outcome === "abandoned") {
        mode = "default";
        update({ sessionUpdate: "current_mode_update", currentModeId: "default" });
      }
    } else if ("question" in step) {
      const id = `call-${++seq}`;
      if (!(await hook({ name: "ask_user_question", input: {} }, id, opened))) continue;
      const answer = await rpc.request("_x.ai/ask_user_question", {
        sessionId: opened, toolCallId: id, mode,
        questions: step.question.map((q) => ({ question: q.question, options: q.options.map((label) => ({ label, description: `${label}!` })), multiSelect: q.multi ? true : null })),
      });
      log({ question: step.question.map((q) => q.question), answer });
    } else if ("perm" in step) {
      // Asked as Grok asks where its settings say to, the "always" options first.
      const id = `call-${++seq}`;
      if (!(await hook(step.perm, id, opened))) continue;
      const answer = await rpc.request("session/request_permission", {
        sessionId: opened, toolCall: { toolCallId: id, title: step.perm.name, rawInput: step.perm.input ?? {} },
        options: [{ optionId: "always-allow", name: "Always", kind: "allow_always" }, { optionId: "allow-once", name: "Allow", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }, { optionId: "reject-always", name: "Never", kind: "reject_always" }],
      });
      log({ perm: step.perm.name, answer });
    } else if ("hang" in step) while (!cancelled) await sleep(10);
    else if ("fail" in step) throw new RpcError(step.fail.code, step.fail.message, step.fail.data);
    await sleep(3);
  }
  if (!cancelled) turnDone(promptId);
  return cancelled ? "cancelled" : "end_turn";
}
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const finished = new Set<string>();

const records = (sessionId: string): Array<Record<string, unknown>> => {
  const kept = (script.sessions ?? []).find((one) => one.sessionId === sessionId);
  if (kept) {
    return kept.history.flatMap((entry, index): Array<Record<string, unknown>> => {
      const at = { timestamp: Math.floor(entry.at / 1000), timestamp_us: entry.at * 1000 };
      if (entry.user) return [{ ...at, method: "session/update", params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.user }, _meta: { promptIndex: index } } } }];
      if (entry.agent) return [{ ...at, method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.agent } } } }];
      if (entry.tool) {
        return [
          { ...at, method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: `old-${index}`, title: entry.tool.name, rawInput: entry.tool.input ?? {}, _meta: { modelId: "grok-4.7" } } } },
          { timestamp: Math.floor(entry.at / 1000) + 1, timestamp_us: (entry.at + 1500) * 1000, method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: `old-${index}`, status: "completed" } } },
        ];
      }
      return [];
    });
  }
  return script.children?.[sessionId] ?? [];
};

rpc.onRequest(async (method, params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  log({ method, params: p });
  const register = () => {
    const hooks = (p._meta as { "x.ai/hooks"?: { pre_tool_use?: unknown[] } } | undefined)?.["x.ai/hooks"];
    hooked = Array.isArray(hooks?.pre_tool_use) && hooks!.pre_tool_use!.length > 0;
  };
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {}, close: {} },
          _meta: script.hooks === false ? {} : { "x.ai/hooks": { blockingEvents: ["pre_tool_use", "stop", "subagent_stop"], decisions: ["deny", "block"] } },
        },
        authMethods: [{ id: "cached_token" }],
        _meta: { availableCommands: commands },
      };
    case "session/new": {
      if (process.env.GROK_HOME?.includes("signed-out")) throw new RpcError(-32000, "Authentication required", "no auth method id provided");
      register();
      opened = `grok-session-${++seq}`;
      setTimeout(() => update({ sessionUpdate: "available_commands_update", availableCommands: commands }), 5);
      return sessionAnswer(opened);
    }
    case "session/resume": {
      if (typeof p.sessionId !== "string" || (script.gone ?? []).includes(p.sessionId)) throw new RpcError(-32603, "Path not found.", { detail: "No such file or directory (os error 2)", code: "FS_NOT_FOUND" });
      register();
      opened = p.sessionId;
      return sessionAnswer(opened);
    }
    case "session/list": {
      const rows = (script.sessions ?? []).map(({ history: _history, ...one }) => one).filter((one) => !p.cwd || one.cwd === p.cwd);
      return { sessions: rows, nextCursor: null };
    }
    case "_x.ai/session/fork": {
      const kept = (script.sessions ?? []).find((one) => one.sessionId === p.sourceSessionId);
      if (!kept || kept.cwd !== p.sourceCwd) throw new RpcError(-32603, "source session not found");
      return { newSessionId: `grok-fork-${++seq}`, parentSessionId: kept.sessionId, newCwd: p.newCwd, chatMessagesCopied: kept.history.length };
    }
    case "_x.ai/session/updates":
      return { updates: records(String(p.sessionId)) };
    case "_x.ai/billing":
      if (!script.billing) throw new RpcError(-32601, "no billing");
      return { config: { creditUsagePercent: script.billing.creditUsagePercent, currentPeriod: { end: script.billing.end } } };
    case "_x.ai/task/kill": {
      const id = String(p.taskId);
      clearTimeout(timers.get(id));
      finished.add(id);
      // As 1.0.89 reports a kill: no exit code, a signal, and a turn Grok then takes by itself.
      note("_x.ai/task_completed", { sessionUpdate: "task_completed", task_snapshot: { task_id: id, output: "", exit_code: null, signal: "killed", explicitly_killed: true, completed: true }, will_wake: true });
      setTimeout(() => {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Task ${id} was stopped.` } });
        turnDone(`task-completed-${id}`);
      }, 10);
      return { result: { taskId: id, outcome: "killed" } };
    }
    case "_x.ai/subagent/cancel": {
      const id = String(p.subagentId);
      finished.add(id);
      note("_x.ai/session_notification", { sessionUpdate: "subagent_finished", subagent_id: id, child_session_id: id, status: "cancelled", error: "Subagent was cancelled", will_wake: false });
      return { result: { subagentId: id, cancelled: true } };
    }
    case "session/set_config_option":
      if (p.configId === "model" && typeof p.value === "string") currentModel = p.value;
      return { configOptions: configOptions().map((option) => (option.id === p.configId ? { ...option, currentValue: p.value } : option)) };
    case "session/prompt": {
      const meta = (p._meta ?? {}) as { mode?: string };
      const wanted = meta.mode === "plan" ? "plan" : "default";
      if (wanted !== mode) {
        mode = wanted;
        update({ sessionUpdate: "current_mode_update", currentModeId: mode });
      }
      const steps = script.prompts[promptIndex++] ?? [{ say: "(no more script)" }];
      const stopReason = await prompt(steps, `prompt-${promptIndex}`);
      return { stopReason, _meta: { promptId: `prompt-${promptIndex}` } };
    }
    default:
      throw new RpcError(-32601, `no ${method}`);
  }
});
rpc.onNotification((method, params) => {
  log({ notification: method, params });
  if (method === "session/cancel") cancelled = true;
  if (method === "_x.ai/toggle_plan_mode") {
    mode = mode === "plan" ? "default" : "plan";
    update({ sessionUpdate: "current_mode_update", currentModeId: mode });
  }
});
process.stdin.on("end", () => process.exit(0));
