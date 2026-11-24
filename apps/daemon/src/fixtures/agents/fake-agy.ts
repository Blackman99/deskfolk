/**
 * A stand-in `agy acp` for project sessions' tests (ADR 0111): ACP over stdin and stdout, shaped as
 * `agy` 1.5.10 answers (measured 2026-11-17). It plays `FAKE_AGY_SCRIPT` (JSON), one list of steps
 * per `session/prompt`, and writes every request, notification and answer it got to `FAKE_AGY_LOG`.
 *
 * Script: `{ caps?, sessions?, commands?, models?, afterSay?, gone?, prompts }`. `caps` turns `resume`,
 * `load` or `list` off; `sessions` are the ones it keeps from before (a terminal's), each with its
 * `history` that `session/load` replays; `commands` what `available_commands_update` offers after
 * a session opens; `models` its model list; `afterSay` what it says by itself once a background
 * command ended.
 *
 * Steps: `{ say }` a chunk of the reply; `{ tool }` a call it makes without asking — reported under
 * way at once, then done after `holdMs` (or, with `background: ms`, left under way past the reply
 * and ended that long after it); `{ ask }` a call it asks permission for first (`allow_once`,
 * `reject_once`), then runs when allowed; `{ wait: ms }`; `{ hang: true }` until `session/cancel`;
 * `{ question }` its `ask_question`: the call under way, then the form `agy` sends for it
 * (`elicitation/create`, as 1.5.10 builds it) when the client offered forms, logged with the answer.
 * Each prompt answers `end_turn` (or `cancelled`) with `usage`.
 */
import { appendFileSync } from "node:fs";
import { rpcPeer, RpcError } from "../../engine/agent/jsonrpc";

type Call = { id?: string; name?: string; kind: string; title?: string; rawInput?: Record<string, unknown>; locations?: Array<{ path: string }>; holdMs?: number; failed?: boolean; output?: string; background?: number };
type Question = { question: string; options: string[]; multi?: boolean };
type Step = { say: string } | { tool: Call } | { ask: Call } | { wait: number } | { hang: true } | { question: Question[] };
type Kept = { sessionId: string; cwd: string; title: string; updatedAt: string; history: Array<{ user?: string; agent?: string; tool?: Call }> };
type Script = {
  caps?: { resume?: boolean; load?: boolean; list?: boolean; tier?: boolean };
  /** Subscription tier metadata returned in `_meta.antigravity.tier` on session open/resume/load. */
  tier?: { name: string; id?: string; upgradeUri?: string };
  sessions?: Kept[];
  commands?: Array<{ name: string; description: string }>;
  models?: string[];
  afterSay?: string;
  /** A call it makes by itself, without asking, once a background command ended. */
  afterTool?: Call;
  /** Sessions it no longer has: resuming one fails as `agy` says (any other id resumes, as agy keeps its sessions on disk). */
  gone?: string[];
  usage?: Record<string, number>;
  prompts: Step[][];
};

const script = JSON.parse(process.env.FAKE_AGY_SCRIPT ?? '{"prompts":[]}') as Script;
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`);
};
const rpc = rpcPeer(process.stdin, process.stdout, { jsonrpc: true });
log({ argv: process.argv.slice(2), cwd: process.cwd() });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let promptIndex = 0;
let cancelled = false;
let seq = 0;
let opened: string | null = null;
/** The client offered forms (`elicitation.form`): `ask_question` is sent as one. */
let forms = false;
const models = script.models ?? ["gemini-3.8-flash-high", "gemini-3.8-flash-low"];
const update = (u: Record<string, unknown>) => rpc.notify("session/update", { sessionId: opened, update: u });
const configOptions = () => [
  { id: "model", category: "model", type: "select", currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
  { id: "mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default" }, { value: "plan" }] },
];
const sessionAnswer = (sessionId: string) => ({
  sessionId, configOptions: configOptions(),
  models: { availableModels: models.map((modelId) => ({ modelId, name: modelId })), currentModelId: models[0] },
  modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] },
  ...(script.tier ? { _meta: { antigravity: { tier: script.tier } } } : {}),
});
const offerCommands = () => setTimeout(() => update({ sessionUpdate: "available_commands_update", availableCommands: script.commands ?? [] }), 5);

function toolUpdate(call: Call, id: string, status: string, extra: Record<string, unknown> = {}) {
  update({ sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update", toolCallId: id, name: call.name ?? call.kind, kind: call.kind, title: call.title ?? call.kind,
    status, rawInput: call.rawInput ?? {}, ...(call.locations ? { locations: call.locations } : {}), ...extra });
}

async function run(call: Call): Promise<void> {
  const id = call.id ?? `call_${++seq}`;
  toolUpdate(call, id, "in_progress");
  if (call.background !== undefined) {
    // Past the reply: it ends later, and agy may then say something by itself.
    setTimeout(() => {
      toolUpdate(call, id, "completed", { rawOutput: { output: call.output ?? "done", exit_code: 0 } });
      if (script.afterSay) setTimeout(() => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: script.afterSay } }), 10);
      if (script.afterTool) setTimeout(() => void run(script.afterTool!), 20);
    }, call.background);
    return;
  }
  await sleep(call.holdMs ?? 5);
  toolUpdate(call, id, call.failed ? "failed" : "completed", { rawOutput: { output: call.output ?? "ok" } });
}

async function prompt(steps: Step[]): Promise<string> {
  cancelled = false;
  for (const step of steps) {
    if (cancelled) return "cancelled";
    if ("say" in step) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
    else if ("tool" in step) await run(step.tool);
    else if ("ask" in step) {
      const id = step.ask.id ?? `call_${++seq}`;
      const answer = await rpc.request<{ outcome?: { outcome?: string; optionId?: string } }>("session/request_permission", {
        sessionId: opened,
        toolCall: { toolCallId: id, kind: step.ask.kind, title: step.ask.title ?? step.ask.kind, rawInput: step.ask.rawInput ?? {}, ...(step.ask.locations ? { locations: step.ask.locations } : {}) },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
      });
      log({ asked: step.ask.title ?? step.ask.kind, answer });
      if (answer?.outcome?.optionId === "yes" || answer?.outcome?.optionId === "always") await run({ ...step.ask, id });
    } else if ("question" in step) {
      const id = `call_${++seq}`;
      const args = { questions: step.question.map((q) => ({ is_multi_select: q.multi ?? false, options: q.options, question: q.question })) };
      update({ sessionUpdate: "tool_call", toolCallId: id, name: "ask_question", args, status: "in_progress", kind: "other", title: "Run ask_question", rawInput: args });
      const properties: Record<string, unknown> = {};
      step.question.forEach((q, index) => {
        const choices = q.options.map((label, at) => ({ const: String(at + 1), title: label }));
        properties[`q${index + 1}`] = q.multi ? { type: "array", title: q.question, items: { anyOf: choices } } : { type: "string", title: q.question, oneOf: choices };
        properties[`q${index + 1}_other`] = { type: "string", title: "Other", description: `Optional free-form answer to: ${q.question}` };
      });
      const answer = forms
        ? await rpc.request("elicitation/create", { sessionId: opened, toolCallId: id, mode: "form", message: `The agent has ${step.question.length} questions.`, requestedSchema: { type: "object", properties } }).catch((error: unknown) => ({ error: String(error) }))
        : { offered: false };
      log({ question: step.question.map((q) => q.question), answer });
      update({ sessionUpdate: "tool_call_update", toolCallId: id, name: "ask_question", status: "completed", kind: "other", title: "Run ask_question" });
    } else if ("wait" in step) await sleep(step.wait);
    else if ("hang" in step) while (!cancelled) await sleep(10);
    await sleep(3);
  }
  return cancelled ? "cancelled" : "end_turn";
}

rpc.onRequest(async (method, params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  log({ method, params: p });
  const caps = script.caps ?? {};
  switch (method) {
    case "initialize": {
      forms = Boolean((params as { clientCapabilities?: { elicitation?: { form?: unknown } } } | undefined)?.clientCapabilities?.elicitation?.form);
      const session: Record<string, unknown> = { close: {}, additionalDirectories: {} };
      if (caps.resume !== false) session.resume = {};
      if (caps.load !== false) session.load = {};
      if (caps.list !== false) session.list = {};
      const meta = caps.tier || script.tier ? { _meta: { antigravity: { tier: caps.tier ?? Boolean(script.tier) } } } : {};
      return { protocolVersion: 1, agentCapabilities: { loadSession: caps.load !== false, promptCapabilities: { image: true }, sessionCapabilities: session, ...meta }, authMethods: [] };
    }
    case "session/new": {
      opened = `agy-session-${++seq}`;
      offerCommands();
      return sessionAnswer(opened);
    }
    case "session/resume": {
      if (typeof p.sessionId !== "string" || (script.gone ?? []).includes(p.sessionId)) throw new RpcError(-32002, `session not found: ${String(p.sessionId)}`);
      opened = p.sessionId;
      offerCommands();
      return sessionAnswer(opened);
    }
    case "session/load": {
      const kept = (script.sessions ?? []).find((one) => one.sessionId === p.sessionId);
      if ((script.gone ?? []).includes(String(p.sessionId))) throw new RpcError(-32002, `session not found: ${String(p.sessionId)}`);
      opened = String(p.sessionId);
      for (const entry of kept?.history ?? []) {
        if (entry.user) update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.user } });
        if (entry.agent) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.agent } });
        if (entry.tool) toolUpdate(entry.tool, entry.tool.id ?? `old_${++seq}`, "completed", { rawOutput: { output: entry.tool.output ?? "" } });
      }
      if (kept) update({ sessionUpdate: "session_info_update", title: kept.title });
      await sleep(5);
      return sessionAnswer(opened);
    }
    case "session/list":
      return { sessions: (script.sessions ?? []).map(({ history: _history, ...one }) => one), nextCursor: null };
    case "session/close":
      return {};
    case "session/set_model":
    case "session/set_mode":
      return {};
    case "session/set_config_option":
      return { configOptions: configOptions().map((option) => (option.id === p.configId ? { ...option, currentValue: p.value } : option)) };
    case "session/prompt": {
      const steps = script.prompts[promptIndex++] ?? [{ say: "(no more script)" }];
      const stopReason = await prompt(steps);
      return { stopReason, usage: script.usage ?? { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 110 } };
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
