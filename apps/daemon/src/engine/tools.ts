/**
 * Running a hop's tool calls: workspace tools, collab tools (memories, skills, mentions, ...) and
 * whatever an MCP server offers, plus the ask/approval waits a call can put a turn into. What a
 * tool actually wrote to the workspace is tracked here too, since that is what a closing check and
 * a delivered message both cite.
 */
import type { AskAnswer, ClientEvent, McpServer, Message, Turn } from "@real-bot/protocol";
import { askAnswerText } from "../ask";
import { runCollabTool, type ToolCtx, type ToolResult } from "../collab-tools";
import { toolFail } from "../tool-result";
import { readBotLineByWords, readsAsNoWork, type BotLineContext, type BotLineReading } from "../line-reading";
import type { ToolCall } from "../completions";
import { isoNow } from "../ids";
import { HttpError } from "../errors";
import { attachPictures, fitsHop, pictureResultNote, type LoopPicture } from "../loop-pictures";
import type { McpHost } from "../mcp-host";
import { inlineWorkspaceRefs } from "../mcp-workspace-refs";
import { COLLAB_TOOL_NAMES, type ChatTool, type McpPromptGuide } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { sessionUpsertFields } from "../session-events";
import { checkLines, isReservedTaskPath, jobArgsDigest, promptPartNumber, type Store } from "../store";
import { checkedJobId, jobIdOf, jobPair, jobReply, jobStatusOf } from "./job-adapter";
import { TOOL_FAILURES_KEPT } from "../store/routing";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { mergeCitedPaths, writtenPathFromToolData } from "../artifact-paths";
import { takeCodePoints } from "../text";
import { toolTargetOf } from "../tool-activity";
import { serializeToolResult } from "../tool-results";
import type { WakeWatch } from "../wake";
import { classifyPath } from "../workspace-paths";
import { isWorkspaceTool, runWorkspaceTool, type ShellStream } from "../workspace-tools";
import type { Closing } from "./closing";
import { HELD_CALL, mayAct } from "./control";
import type { Participation } from "./participation";
import type { Submissions } from "./submissions";
import type { TurnTrouble } from "../store/escalation";
import { noteArguments, noteOutcome } from "./trouble";
import type { Live } from "./types";

/** Tools that are the work itself, not looking around: a turn using one is working on its ticket. */
const WORKING_TOOLS = new Set(["write_file", "delete_file", "shell"]);

/**
 * Calls that change nothing, which a turn a hold covers still makes (ADR 0040 I3): reading the
 * workspace, the roster and the catalogs, and ending the turn. An MCP tool is one when its server
 * marks it read-only in the tool list the hop was given, read afresh every hop rather than kept,
 * so a server that stops saying so is believed at once. Every other call has an effect and is
 * refused under a hold.
 */
const NO_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "list_bots",
  "list_sessions",
  "list_routines",
  "list_skills",
  "read_skill",
  "list_endpoints",
  "list_mcp_servers",
  "list_annotations",
  "list_prompts",
  "read_prompt",
  "describe_data",
  "query_data",
  "read_data_log",
  "end_turn",
]);

/**
 * The tools a read-only turn is given: those that change nothing, and the MCP tools their server
 * marks read-only in this hop's list.
 */

/** What a shell call printed, stdout then stderr, for its record. */
function shellOutput(data: Record<string, unknown> | undefined): string | null {
  const parts = [data?.stdout, data?.stderr].filter((part): part is string => typeof part === "string" && part.length > 0);
  if (!parts.length) return null;
  return parts.reduce((all, part) => (all && !all.endsWith("\n") ? `${all}\n${part}` : all + part), "");
}

export function readOnlyTools(tools: readonly ChatTool[], guides: readonly McpPromptGuide[]): ChatTool[] {
  const readOnlyMcp = new Set(guides.flatMap((guide) => guide.tools.filter((tool) => tool.readOnly === true).map((tool) => tool.modelName)));
  return tools.filter((tool) => NO_EFFECT_TOOLS.has(tool.function.name) || readOnlyMcp.has(tool.function.name));
}

/** How much of a failed call's target and error the learning hop reads: enough to name it. */
const FAILURE_TARGET_MAX = 160;
const FAILURE_ERROR_MAX = 240;

export type ToolsDeps = {
  store: Store;
  /** Overrides the shell's 10-minute timeout; tests use a short one. */
  shellTimeoutMs?: number;
  publish: (event: ClientEvent) => void;
  publishMessage: (message: Message) => void;
  publishTurn: (turn: Turn, partial?: string | null) => void;
  occurred: () => string;
  wake: WakeWatch;
  mcp: McpHost | undefined;
  admission: TurnAdmission | undefined;
  streams: ShellStream | undefined;
  lives: Map<string, Live>;
  active: (turnId: string, live: Live) => boolean;
  track: <T>(promise: Promise<T>) => Promise<T>;
  closingCheckForSend: Closing["closingCheckForSend"];
  handleParticipation: Participation["handleParticipation"];
  /** Late-bound: fire.ts is built after this module. */
  fireRoutine: (routineId: string, now?: Date) => Turn | null;
  /** Late-bound: plan-watch.ts is built after this module. */
  observeTicket: (turnId: string, botId: string, seen: "working" | "delivered") => void;
  /** A test waits here, between one call returning and the next being looked at. */
  betweenCalls?: (turnId: string) => Promise<void> | void;
  /** Late-bound: a line of yours a call filed under a job after it arrived goes to the scribe then (ADR 0040 P3). */
  noteFiled: (messageId: string) => void;
  /** Late-bound: `submit`, `review` and the implicit submission before end_turn(done) (ADR 0046, engine level 5). */
  submissions?: () => Submissions;
  /** A Bot's line, read for what the app acts on (ADR 0055, `reader.ts`); absent, the word lists read it. */
  readBotLine?: (body: string, sessionId: string | null, context?: BotLineContext) => Promise<BotLineReading>;
};

export type Tools = {
  noteWrittenPaths: (live: Live, toolName: string, result: ToolResult) => void;
  /** What a call wrote, noted, and the segment put on its own ticket when it wrote in that ticket's folder. */
  noteWrites: (turnId: string, live: Live, toolName: string, result: ToolResult) => void;
  executeTools: (turnId: string, calls: ToolCall[]) => Promise<"wait" | "noop" | "more" | "spoke">;
  recordRun: (turnId: string, live: Live, name: string, args: Record<string, unknown>, result: ToolResult) => void;
  admitPicture: (live: Live, pictures: LoopPicture[], result: ToolResult) => Record<string, unknown> | undefined;
  withLatestMcp: (name: string, result: ToolResult) => ToolResult;
  dispatchTool: (
    turn: Turn,
    live: Live,
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ) => Promise<ToolResult>;
  inspectForTurn: (turnId: string, live: Live, server: McpServer) => Promise<McpServer | null>;
  publishEmitted: (turnId: string, live: Live, emitted: ToolResult["emitted"]) => Promise<void>;
  waitForApproval: (
    turnId: string,
    approvalId: string,
    toolCallId: string,
    run: (opts?: { api_key?: string; approval_id?: string; message_id?: string | null }) => Promise<ToolResult> | ToolResult,
    requiresApiKey?: boolean,
  ) => Promise<ToolResult | null>;
  waitForAsk: (turnId: string, askId: string, toolCallId: string) => Promise<AskAnswer | null>;
  openApprovalCard: (
    turn: Turn,
    live: Live,
    waitApproval: NonNullable<ToolResult["waitApproval"]>,
    toolCallId: string,
  ) => Promise<ToolResult | null>;
  openAskCard: (
    turn: Turn,
    live: Live,
    waitAsk: NonNullable<ToolResult["waitAsk"]>,
    toolCallId: string,
  ) => Promise<{ ask: Message; answer: AskAnswer | null }>;
  beforeEffect: (
    turn: Turn,
    live: Live,
    name: string,
    callId?: string,
  ) => Promise<{ ok: true; turn: Turn } | { ok: false; result: ToolResult }>;
};

/** The endings a promise of more to come is weighed for (the end contract's `promised_later`). */
const PROMISE_WEIGHED = ["done", "answered", "nothing_new"];

export function createTools(deps: ToolsDeps): Tools {
  const { store, publish, publishMessage, publishTurn, occurred, wake, mcp, admission, streams, lives, active, track, closingCheckForSend, handleParticipation, fireRoutine, observeTicket, betweenCalls, noteFiled, submissions } = deps;

  /**
   * What a collaboration call's words say, read before it runs (ADR 0055): whether a message is only
   * a no-work closer, for an ending the segment's last word and the sentence in which it says the
   * work is still going, and whether a question to the user — a blocked ending's or `ask_user`'s —
   * only asks their OK to go on (ADR 0058). Undefined for any other call.
   */
  async function readForCall(turn: Turn, name: string, args: Record<string, unknown>): Promise<ToolCtx["read"]> {
    const read = (text: string, context?: BotLineContext) => (deps.readBotLine ?? readBotLineByWords)(text, turn.session_id, context);
    // Read with what the segment answers, as every reading of its lines is: one reading per line.
    const answering = () => ({ answering: store.segmentAnswering(turn.id) });
    if (name === "send_message" && typeof args.body === "string") return { noWork: await readsAsNoWork(args.body, (text) => read(text, answering())) };
    if (store.capabilities().engine_level < ENGINE_LEVELS.delegation || turn.mode === "readonly") return undefined;
    // A question to the user, read unless one was already sent back this segment: then the next is theirs.
    const question = name === "ask_user" ? args.question : name === "end_turn" && args.reason === "blocked" ? args.needs_from_user : null;
    if (typeof question === "string" && question.trim()) {
      return store.goAheadRefused(turn.id) ? undefined : { goAhead: (await read(question)).goAhead };
    }
    if (name !== "end_turn" || !PROMISE_WEIGHED.includes(args.reason as string)) return undefined;
    const said = store.segmentLastWord(turn.id);
    return said?.trim() ? { lastWord: { said, later: (await read(said, answering())).later } } : undefined;
  }

  /**
   * How a call with an effect came out, on its ledger row (ADR 0045), before its result is heard.
   * A refusal sent nothing. An MCP call that failed after it was sent, a call cut off by an abort,
   * or one that timed out may or may not have taken effect: unknown, which keeps the supervisor
   * from picking the work up on its own. A local tool's ordinary failure is just a failure.
   */
  function finishEffectEvidence(turnId: string, live: Live, name: string, callId: string, result: ToolResult): void {
    if (store.capabilities().engine_level < ENGINE_LEVELS.supervision || result.waitApproval || result.waitAsk) return;
    const execution = store.getToolExecution({ turnId, toolCallId: callId });
    if (!execution || execution.finished_at || result.error?.code === "repeated_effect") return;
    const code = result.error?.code;
    const refused = Boolean(code && ["denied", "invalid_args", "held", "refused", "not_a_member", "draining", "no_work_authority"].includes(code));
    const uncertain = live.abort.signal.aborted || (!result.ok && !refused && live.mcpTools.has(name))
      || Boolean(code && ["timeout", "unreachable", "interrupted", "crashed"].includes(code));
    store.finishToolExecution({ turnId, toolCallId: callId,
      outcome: result.ok ? "succeeded" : refused ? "refused" : uncertain ? "unknown" : "failed", errorCode: code });
  }

  function noteWrittenPaths(live: Live, toolName: string, result: ToolResult): void {
    if (!result.ok) return;
    // What the turn deleted is no artifact of it, written first or not, nor is anything under a
    // folder it deleted. On 2026-10-04's real-model run a Bot wrote slogans.md at the workspace root,
    // wrote it again in its ticket's folder and deleted the first: both still came with its last
    // line, two bubbles of the same file, one of them gone.
    if (toolName === "delete_file") {
      const root = store.workspacePath();
      if (!root) return;
      const gone = writtenPathFromToolData(result.data).map((raw) => classifyPath(root, raw)).filter((path) => path.zone === "inside").map((path) => path.rel);
      const kept = (paths: string[]) => paths.filter((path) => !gone.some((dead) => path === dead || path.startsWith(`${dead}/`)));
      live.writtenPaths = kept(live.writtenPaths);
      if (live.producedPaths) live.producedPaths = kept(live.producedPaths);
      return;
    }
    // `shell` now reports the files it left in the work dir; everything else among the workspace
    // tools only reads, and read paths are not artifacts.
    if (isWorkspaceTool(toolName) && toolName !== "write_file" && toolName !== "shell") return;
    // Reading or resolving an annotation names a file; it does not write one.
    if (toolName === "list_annotations" || toolName === "resolve_annotation") return;
    const root = store.workspacePath();
    if (!root) return;
    for (const raw of writtenPathFromToolData(result.data)) {
      const classified = classifyPath(root, raw);
      if (classified.zone !== "inside") continue;
      // The reserved subdirs are where the daemon spills and where the turn instructions tell the
      // Bot to put throwaway files, and the mirror files are the app's own. None of them is
      // something to hand the user as an artifact, at the plan's level or a ticket's.
      if (live.planDir && isReservedTaskPath(live.planDir, classified.rel)) continue;
      if (live.workDir && isReservedTaskPath(live.workDir, classified.rel)) continue;
      live.writtenPaths = mergeCitedPaths(live.writtenPaths, [classified.rel]);
      live.producedPaths = mergeCitedPaths(live.producedPaths ?? [], [classified.rel]);
    }
  }

  /**
   * What a call wrote, noted; writing in one of its own tickets' folders puts a segment on the whole
   * job onto that ticket. Both after a call that ran at once and after one you approved: on
   * 2026-10-04's real-model run the lead rendered its poster with a python3 command you approved,
   * the segment stayed on the whole job, and submit was refused until it gave up.
   */
  function noteWrites(turnId: string, live: Live, toolName: string, result: ToolResult): void {
    noteWrittenPaths(live, toolName, result);
    if (result.ok && (toolName === "write_file" || toolName === "shell") && live.writtenPaths.length > 0) store.bindToOwnTicket({ turnId, paths: live.writtenPaths });
  }

  async function executeTools(turnId: string, calls: ToolCall[]): Promise<"wait" | "noop" | "more" | "spoke"> {
    const live = lives.get(turnId);
    if (!live) return "wait";
    const turn = store.getTurn(turnId);
    const workDir = live.workDir;
    let posted = false;
    let spoke = false;
    let ended = false;
    // A line of yours that arrived as a change while this hop's calls run: the calls still waiting
    // do not run, and come back as deferred so the next hop can read the line and call again.
    // Only a line that arrived after a call in this hop has run counts. One already queued at the
    // start is read at the top of the next hop; deferring for it would defer every hop.
    const queuedAtStart = new Set(store.queuedForTurn(turnId).map((row) => row.seq));
    let deferRest = false;
    // What read_file found this hop; shown after all the hop's tool results (see loop-pictures.ts).
    const pictures: LoopPicture[] = [];
    for (const call of calls) {
      if (!active(turnId, live)) return "wait";
      const rejected = store.filingBudget(turnId);
      if (ended || rejected >= 2) {
        live.loop.push({ role: "tool", tool_call_id: call.id, content: serializeToolResult({ ok: false,
          error: { code: "segment_ended", message: "this segment ended before this call could run" } }, store.workspacePath(), live.workDir) });
        posted = true;
        continue;
      }
      if (betweenCalls && live.toolCalls > 0) await betweenCalls(turnId);
      if (!active(turnId, live)) return "wait";
      // Between calls: a line of yours that asks for a change postpones the calls still waiting.
      // A question is read at the next hop and postpones nothing (ADR 0040 P4a).
      if (store.queuedForTurn(turnId).some((row) => row.priority === 1 && row.kind === "change" && !queuedAtStart.has(row.seq))) deferRest = true;
      if (deferRest) {
        live.loop.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(
            { ok: false, error: { code: "deferred_for_inbox", message: "a line came in; this call waits for the next step" } },
            store.workspacePath(),
            workDir,
          ),
        });
        posted = true;
        continue;
      }
      live.toolCalls += 1;
      // I3: under a hold a call with an effect does not run, nor the closing check a message gets first.
      let held = hasEffect(live, call.name) && !mayAct(store, turnId);
      if (!held && !live.ticketWorking && (WORKING_TOOLS.has(call.name) || live.mcpTools.has(call.name))) {
        live.ticketWorking = true;
        observeTicket(turnId, turn.bot_id, "working");
      }
      const fingerprint = `${call.name}\n${call.arguments}`;
      if (live.failedCalls.has(fingerprint)) live.repeatedFailures += 1;
      troubled(turnId, live, noteArguments(live.trouble, call.arguments));
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
      // A tool is the one place a hop can legitimately sit still for minutes, so mark both ends of
      // it: the stale sweep reads `last_activity_at` and must not cut a long shell or MCP call off.
      store.touchTurn(turnId);
      // Bracket the execution so a watcher can tell "still running" from "finished": the
      // announce event only says the model asked for it.
      const startedAt = Date.now();
      // A delivery about to be posted gets the closing check first; a bounce comes back to the
      // Bot as this call's result, and the tool itself does not run.
      const bounce = !held && call.name === "send_message" ? await closingCheckForSend(turnId, live, turn, args) : null;
      if (!active(turnId, live)) return "wait";
      // Asked again right before it runs: a hold made while the closing check was out stops it too.
      if (!held && call.name === "send_message") held = !mayAct(store, turnId);
      let result: ToolResult;
      if (held) {
        result = toolFail("held", HELD_CALL);
      } else if (bounce) {
        result = toolFail("closing_check", bounce);
      } else {
        const target = toolTargetOf(call.name, args);
        const mcpTool = live.mcpTools.get(call.name);
        // A command is what a shell call is about; the start frame carries it in its arguments.
        const about = target ?? (call.name === "shell" && typeof args.command === "string" ? args.command : null);
        live.runningTool = { id: call.id, name: call.name, ...(about ? { target: about } : {}),
          ...(mcpTool ? { mcp_server: mcpTool.server, mcp_tool: mcpTool.tool } : {}), started_at: new Date(startedAt).toISOString() };
        publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id: call.id,
          name: call.name, arguments: call.arguments, phase: "started",
          ...(target ? { target } : {}),
          ...(mcpTool ? { mcp_server: mcpTool.server, mcp_tool: mcpTool.tool } : {}) });
        try {
          result = await dispatchTool(turn, live, call.name, args, call.id);
        } finally {
          if (live.runningTool?.id === call.id) live.runningTool = null;
        }
        for (const messageId of result.filed ?? []) noteFiled(messageId);
        finishEffectEvidence(turnId, live, call.name, call.id, result);
        publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id: call.id,
          name: call.name, phase: "exited", duration_ms: Date.now() - startedAt,
          exit_code: typeof result.data?.exit_code === "number" ? result.data.exit_code : null,
          // How it came back, unless it is still waiting on an approval or an answer: a refusal
          // (bad arguments, a draining runtime) is known here, whether or not another hop follows.
          ...(result.waitApproval || result.waitAsk
            ? {}
            : { ok: result.ok, ...(result.ok || !result.error ? {} : { error_code: result.error.code }) }) });
        if (!result.waitApproval) recordRun(turnId, live, call.name, args, result, call.id, Date.now() - startedAt);
        if (call.name === "read_file" && result.ok) noteFrameRead(turnId, args);
      }
      if (!active(turnId, live)) return "wait";
      store.touchTurn(turnId);
      if (result.error?.code === "draining") {
        if (live.drainRejection) {
          const note = store.insertMessage({ sessionId: turn.session_id, turnId, kind: "system", author: turn.bot_id,
            body: "draining: repeated child or handoff admission refused" });
          publishMessage(note);
          return "noop";
        }
        live.drainRejection = true;
      }
      await publishEmitted(turnId, live, result.emitted);
      if (!active(turnId, live)) return "wait";
      result = withLatestMcp(call.name, result);
      noteWrites(turnId, live, call.name, result);
      if (result.waitAsk) {
        const { ask, answer } = await openAskCard(turn, live, result.waitAsk, call.id);
        if (answer == null || !active(turnId, live)) return "wait";
        live.loop.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(
            {
              ok: true,
              data: {
                ask_id: ask.id,
                message_id: ask.id,
                answer: askAnswerText(answer),
                selected: answer.selected,
                custom: answer.custom,
              },
            },
            store.workspacePath(),
            workDir,
          ),
        });
        posted = true;
        continue;
      }
      if (result.waitApproval) {
        let resolved = await openApprovalCard(turn, live, result.waitApproval, call.id);
        if (resolved !== null) finishEffectEvidence(turnId, live, call.name, call.id, resolved);
        if (resolved == null || !active(turnId, live)) return "wait";
        // No time: it includes the wait for your approval.
        recordRun(turnId, live, call.name, args, resolved, call.id);
        await publishEmitted(turnId, live, resolved.emitted);
        if (!active(turnId, live)) return "wait";
        resolved = withLatestMcp(call.name, resolved);
        noteWrites(turnId, live, call.name, resolved);
        const payload = resolved.ok
          ? { ok: true, data: admitPicture(live, pictures, resolved) }
          : { ok: false, error: resolved.error };
        if (!resolved.ok && resolved.error?.code !== "held") noteFailure(live, call.name, args, fingerprint, resolved.error);
        troubled(turnId, live, noteOutcome(live.trouble, call.name, resolved.ok, resolved.error));
        live.loop.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(payload, store.workspacePath(), workDir),
        });
        posted = true;
        continue;
      }
      const skipped =
        result.ok && result.data?.skipped === true && result.data?.reason === "no_new_work";
      if (call.name === "send_message" && result.ok && !skipped) {
        spoke = true;
        live.spoke = true;
      }
      if ((result.ok && call.name === "end_turn" && store.capabilities().engine_level < ENGINE_LEVELS.delegation) || result.data?.ended === true) ended = true;
      if (!skipped) posted = true;
      const payload = result.ok
        ? { ok: true, data: admitPicture(live, pictures, result) }
        : { ok: false, error: result.error };
      // A closing-check bounce is a nudge and a call a hold refused never ran: neither is a tool that
      // failed, and the review must not read them as one.
      if (!result.ok && result.error?.code !== "closing_check" && result.error?.code !== "held") {
        noteFailure(live, call.name, args, fingerprint, result.error);
      }
      troubled(turnId, live, noteOutcome(live.trouble, call.name, result.ok, result.error));
      live.loop.push({
        role: "tool",
        tool_call_id: call.id,
        content: serializeToolResult(payload, store.workspacePath(), workDir),
      });
    }
    if (store.filingBudget(turnId) >= 2) {
      publishMessage(store.markNeedsAttention(turnId, live.locale));
      return "noop";
    }
    if (spoke && store.capabilities().engine_level < ENGINE_LEVELS.delegation) return "spoke";
    // end_turn: the Bot has nothing to say, so the turn ends here with no message.
    if (ended) return "noop";
    attachPictures(live.loop, pictures, live.locale);
    return posted ? "more" : "noop";
  }

  /**
   * A picture read with read_file, from engine level 5: the evidence a reviewer looked at frames
   * (ADR 0046), kept in the work log rather than among the commands a turn ran.
   */
  function noteFrameRead(turnId: string, args: Record<string, unknown>): void {
    if (typeof args.path !== "string") return;
    try {
      const root = store.workspacePath();
      const classified = root ? classifyPath(root, args.path) : null;
      store.recordFrameRead({ turnId, path: classified?.zone === "inside" && classified.rel ? classified.rel : args.path });
    } catch {
      // evidence, not the work: the read already happened
    }
  }

  /** Trouble inside the turn steps its job up once (ADR 0054); the rest of this turn goes on at the new level. */
  function troubled(turnId: string, live: Live, trouble: TurnTrouble | null): void {
    // A Claude Agent turn has no model ladder to climb (ADR 0061): its trouble is Claude Code's to handle.
    if (live.agent) return;
    if (trouble && store.stepUpForTrouble(turnId, trouble)) live.restep?.();
  }

  function hasEffect(live: Live, name: string): boolean {
    if (NO_EFFECT_TOOLS.has(name)) return false;
    return live.mcpTools.get(name)?.readOnly !== true;
  }

  /**
   * Counts a failed call, and keeps the first few distinct ones for the learning hop once the
   * chain closes: which tool, on what, and what it said. The same call failing again is counted,
   * not kept twice.
   */
  function noteFailure(
    live: Live,
    name: string,
    args: Record<string, unknown>,
    fingerprint: string,
    error: ToolResult["error"],
  ): void {
    live.toolErrors += 1;
    const repeat = live.failedCalls.has(fingerprint);
    live.failedCalls.add(fingerprint);
    if (repeat || live.failures.length >= TOOL_FAILURES_KEPT) return;
    let shown: string | null = toolTargetOf(name, args) ?? (typeof args.command === "string" ? args.command : null);
    if (shown === null && live.mcpTools.has(name)) {
      try {
        shown = JSON.stringify(args);
      } catch {
        shown = null;
      }
    }
    const line = (text: string, max: number): string => takeCodePoints(text.replace(/\s+/g, " ").trim(), max).text;
    live.failures.push({
      tool: name,
      target: shown ? line(shown, FAILURE_TARGET_MAX) : null,
      error: line(`${error?.code ?? "failed"}: ${error?.message ?? ""}`, FAILURE_ERROR_MAX),
    });
  }

  /**
   * What the turn ran, for the closing check and the organizer to hold claims against: a shell
   * command with how it exited, or an MCP call with its arguments. Best-effort; a turn whose row
   * went away records nothing.
   */
  function recordRun(turnId: string, live: Live, name: string, args: Record<string, unknown>, result: ToolResult, callId?: string, durationMs?: number): void {
    const mcpTool = live.mcpTools.get(name);
    if (name !== "shell" && !mcpTool) return;
    let command: string;
    if (name === "shell") {
      command = typeof args.command === "string" ? args.command : "";
    } else {
      let shown = "";
      try {
        shown = JSON.stringify(args);
      } catch {
        shown = "";
      }
      command = `${mcpTool!.server}.${mcpTool!.tool} ${shown}`;
    }
    if (!command.trim()) return;
    try {
      store.recordTurnRun({
        turnId,
        tool: name,
        command,
        exitCode: typeof result.data?.exit_code === "number" ? result.data.exit_code : null,
        ok: result.ok,
        error: result.ok ? null : (result.error?.message ?? result.error?.code ?? null),
        cwd: name === "shell" ? (typeof args.cwd === "string" ? args.cwd : (live.workDir ?? null)) : null,
        toolCallId: callId,
        durationMs,
        output: name === "shell" ? shellOutput(result.data) : null,
      });
    } catch {
      // the record is evidence, not the work; the call already happened
    }
  }

  /** A picture's tool result, which says whether this hop had room to show it. */
  function admitPicture(live: Live, pictures: LoopPicture[], result: ToolResult): Record<string, unknown> | undefined {
    if (!result.picture) return result.data;
    // From level 7 a model marked as taking no pictures is not sent one (ADR 0049): the Bot is told instead.
    if (live.target && store.routingOn()
      && store.catalogEntries().find((entry) => entry.providerId === live.target!.providerId && entry.name === live.target!.model)?.input_image === false) {
      return { ...result.data, shown: false, note: live.locale === "en"
        ? `The model this turn runs on (${live.target.model}) cannot see pictures, so ${result.picture.path} was not shown to you. If the work needs it seen, say so, or hand it to a Bot that can.`
        : `这一轮用的模型（${live.target.model}）看不了图，所以 ${result.picture.path} 没给你看。这件活需要看图就说出来，或者交给能看图的 Bot。` };
    }
    const shown = fitsHop(pictures, result.picture);
    if (shown) pictures.push(result.picture);
    return { ...result.data, shown, note: pictureResultNote(live.locale, shown) };
  }

  function withLatestMcp(name: string, result: ToolResult): ToolResult {
    if (
      !result.ok ||
      !result.data ||
      typeof result.data.id !== "string" ||
      (name !== "add_mcp_server" && name !== "update_mcp_server")
    ) {
      return result;
    }
    const latest = store.listMcpServers().find((row) => row.id === result.data!.id);
    return latest ? { ...result, data: { ...latest } } : result;
  }

  async function dispatchTool(
    turn: Turn,
    live: Live,
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<ToolResult> {
    const gate = await beforeEffect(turn, live, name, callId);
    if (!gate.ok) return gate.result;
    turn = gate.turn;
    // Level 5 (ADR 0046): a hand-over and a review are the engine's, which hashes, cites and runs checks.
    if ((name === "submit" || name === "review") && submissions) {
      return name === "submit" ? submissions().submit(turn.id, args) : submissions().review(turn.id, args);
    }
    return dispatchAfterGate(turn, live, name, args, callId);
  }

  /**
   * What stands between a call and its effect: a desk segment binds a job first (the one its line
   * was read as about, or a new one), then the hold covering the job is asked again right before
   * acting, the work dir is marked used and the effect entered in the plan's ledger. Returns the
   * turn as it stands after binding, or the refusal the call gets instead. The app's own tools and
   * a Claude Agent turn's (ADR 0061, by the app tool name its call stands for) both pass here.
   */
  async function beforeEffect(
    turn: Turn,
    live: Live,
    name: string,
    callId?: string,
  ): Promise<{ ok: true; turn: Turn } | { ok: false; result: ToolResult }> {
    // Desk segments may read and reply, but choosing a job precedes the first external effect.
    turn = store.getTurn(turn.id);
    const deskAllowed = NO_EFFECT_TOOLS.has(name) || name === "send_message" || name === "ask_user" || name === "work_on" || live.mcpTools.get(name)?.readOnly === true;
    if (turn.mode === "desk" && !deskAllowed) {
      const candidates = store.deskCandidateIds(turn.id);
      const trigger = store.originalUserRequest(turn.id) ?? store.getMessage(turn.trigger_message_id);
      // A line of yours read as about none of these jobs (ADR 0057) gets a job of its own at the
      // first effect, as a line with no candidates does — unless the Bot chose one with work_on first.
      const readNew = trigger.kind === "user" && store.lineReadAsNew(trigger.id);
      if (candidates.length > 1 && !readNew) {
        store.noteFilingBounce(turn.id);
        return { ok: false, result: toolFail("needs_filing", `Choose a job with work_on before this call: one of ${candidates.join(", ")}, or {new:{title, quote_message_id}} quoting the user's line when it is about none of them`) };
      }
      if (candidates.length === 0 && trigger.kind !== "user") {
        return { ok: false, result: toolFail("needs_filing", "Only a user request can open a new job; choose a candidate with work_on") };
      }
      const bound = await runCollabTool({ store, botId: turn.bot_id, sessionId: turn.session_id, turnId: turn.id,
        parentId: live.parentId, signal: live.abort.signal, admission }, "work_on", {
        plan: readNew || candidates.length === 0 ? { new: { title: trigger.body, quote_message_id: trigger.id } } : candidates[0],
      });
      for (const messageId of bound.filed ?? []) noteFiled(messageId);
      if (!bound.ok || bound.data?.merged) return { ok: false, result: bound };
      await publishEmitted(turn.id, live, bound.emitted);
      if (bound.data?.queued) return { ok: false, result: { ok: false, data: { ended: true, queued: true },
        error: { code: "queued", message: "this job is queued; the effect waits for a working slot" }, emitted: [] } };
      turn = store.getTurn(turn.id);
    }
    live.planDir = store.turnPlanDir(turn.id);
    live.workDir = store.turnWorkDir(turn.id);
    if (hasEffect(live, name) && name !== "work_on" && name !== "send_message" && name !== "ask_user") {
      // Binding may have changed which hold applies; check the target immediately before acting.
      if (!mayAct(store, turn.id)) return { ok: false, result: toolFail("held", HELD_CALL) };
      if (turn.task_id) store.markWorkDirectoryUsed(turn.id);
      if (name === "write_file" || name === "delete_file" || name === "shell" || live.mcpTools.has(name)) {
        store.recordNewPlanEffectStarted({ turnId: turn.id, tool: name, toolCallId: callId });
      }
    }
    return { ok: true, turn };
  }

  /** The rest of `dispatchTool`, once `beforeEffect` let the call through. */
  async function dispatchAfterGate(
    turn: Turn,
    live: Live,
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<ToolResult> {
    if (name === "end_turn" && args.reason === "done" && submissions && store.capabilities().engine_level >= ENGINE_LEVELS.submissions) {
      // §5.2: an ending that says done hands over its new files first. A hand-over whose checks
      // fail comes back instead of the ending; the same files again hand nothing over, so asking
      // to end once more is weighed as usual.
      let settled: Awaited<ReturnType<Submissions["implicit"]>> = null;
      try {
        settled = await submissions().implicit(turn.id, { cite: live.writtenPaths });
        live.writtenPaths = store.uncitedTurnPaths(turn.id, live.writtenPaths);
        if (!settled) {
          // Files of a ticket someone else owns are not handed over for this Bot: it hears so once.
          const hint = store.handOverHint({ turnId: turn.id, paths: live.producedPaths ?? [] });
          if (hint) return toolFail("not_handed_over", hint);
          // No new files: the answer it ends with is what it hands over, on a ticket whose work is
          // words — but only when the words themselves read as the deliverable (isAnswerText); a
          // Bot that is not the ticket's producer hears so once instead of a bare obligation.
          if (typeof args.answer === "string" && args.answer.trim()) {
            try {
              settled = await submissions().answer(turn.id, args.answer);
            } catch (error) {
              if (error instanceof HttpError) return toolFail(error.code, error.message);
              throw error;
            }
            if (!settled) {
              const wordsHint = store.answerHint({ turnId: turn.id });
              if (wordsHint) return toolFail("not_handed_over", wordsHint);
            }
          }
        }
      } catch (error) {
        console.error(`[turn ${turn.id}] could not hand its files over before ending`, error);
      }
      if (settled?.state === "checks_failed") {
        const lines = checkLines(settled.failures, live.locale === "en" ? "en" : "zh");
        return toolFail("checks_failed", `what you handed over (submission ${settled.submission.id}) failed its checks, so the ticket did not move: ${lines.join("; ")}. Fix it, or end_turn saying what blocks you.`);
      }
    }
    if (isWorkspaceTool(name) || COLLAB_TOOL_NAMES.includes(name)) {
      const streamId = callId ? `${turn.id}:${callId}` : undefined;
      return isWorkspaceTool(name)
        ? await runWorkspaceTool(
            { store, signal: live.abort.signal, workDir: live.workDir, stream: streams, streamId, wake,
              ...(deps.shellTimeoutMs !== undefined ? { shellTimeoutMs: deps.shellTimeoutMs } : {}),
              turnId: turn.id, toolCallId: callId,
               onEffectStart: callId && store.capabilities().engine_level >= ENGINE_LEVELS.supervision
                 ? (tool) => {
                   const started = store.beginToolExecution({ turnId: turn.id, toolCallId: callId, tool, sideEffect: true });
                   if (!started.begun) throw new HttpError(409, "repeated_effect", "this call already has durable execution evidence; it was not run again");
                 } : undefined },
            name,
            args,
          )
        : await runCollabTool(
            {
              store,
              read: await readForCall(turn, name, args),
              botId: turn.bot_id,
              sessionId: turn.session_id,
              turnId: turn.id,
              parentId: live.parentId,
              writtenPaths: live.writtenPaths,
              producedPaths: live.producedPaths ?? [],
              workDir: live.workDir,
              planDir: live.planDir,
              mentionWarned: live.mentionWarned,
              planNudge: live.planNudge,
              availableToolNames: live.toolNames,
              admission,
              signal: live.abort.signal,
            },
            name,
            args,
          );
    }
    if (!mcp) {
      return toolFail("failed", `unknown tool: ${name}`);
    }
    // A `workspace://` picture goes out as its data URI; the call the model sees keeps the reference.
    const outgoing = inlineWorkspaceRefs(args, store.workspacePath());
    if (!outgoing.ok) {
      return toolFail("invalid_args", outgoing.message);
    }
    // External jobs (ADR 0047, from level 6): a media server's submit/check pair is the daemon's to
    // poll. A check on a registered job reads its last known state without reaching the server; the
    // same submit within half an hour gets the first job back; a part with a job pending, or a result
    // not handed over yet, is not submitted again without a reason.
    const pair = store.jobsOn() ? jobPair(name, live.mcpTools) : null;
    // A large job not laid out yet, or a ticket still waiting for another (ADR 0060): nothing is
    // generated through a server meanwhile. Reading and checking on a job already running go on.
    if (pair?.kind !== "check" && live.mcpTools.get(name)?.readOnly !== true) {
      const refusal = store.largeJobRefusal(turn.id);
      if (refusal) return toolFail(refusal.code, refusal.message);
    }
    const en = live.locale === "en";
    let forwarded = outgoing.args;
    let job: { digest: string; partNo: number | null; reason: string | null } | null = null;
    if (pair?.kind === "check") {
      const requestId = checkedJobId(outgoing.args);
      const known = requestId ? store.jobForRequest(pair.server, requestId) : null;
      if (known) {
        if (known.state === "pending") store.addJobWaiter(known.id, { bot_id: turn.bot_id, work_item_id: turn.work_item_id ?? null, session_id: turn.session_id });
        return { ok: true, emitted: [], data: jobReply({ [pair.idParam]: known.request_id, status: known.status_text ?? known.state, ...(known.result ? { result: known.result } : {}),
          cached: true, app_note: known.state === "pending"
            ? (en ? "The app polls this job itself and wakes you when it is done: no need to check again or book a check-back for it." : "应用自己在查这个作业，完成后会叫你：不用再查，也不用为它约回看。")
            : (en ? `Finished (${known.state}); this is what the app last heard.` : `已结束（${known.state}）；这是应用最后查到的结果。`) }) };
      }
    }
    if (pair?.kind === "submit") {
      const { resubmit_reason: given, ...rest } = outgoing.args;
      forwarded = rest;
      const reason = typeof given === "string" && given.trim() ? given.trim() : null;
      const digest = jobArgsDigest(pair.server, live.mcpTools.get(name)!.tool, rest);
      const recent = store.recentJob(digest);
      if (recent && !reason) {
        // Still running: this Bot waits on it too, so the result wakes it as well.
        if (recent.state === "pending") store.addJobWaiter(recent.id, { bot_id: turn.bot_id, work_item_id: turn.work_item_id ?? null, session_id: turn.session_id });
        return { ok: true, emitted: [], data: jobReply({ [pair.idParam]: recent.request_id, status: recent.status_text ?? recent.state, deduped: true,
          ...(recent.result ? { result: recent.result } : {}),
          app_note: recent.state === "pending"
            ? (en ? "The same submit already started this job in the last half hour; it was not sent again. The app wakes you when it is done."
              : "半小时内同样的提交已经开过这个作业，没有再发一次。完成后应用会叫你。")
            : (en ? "The same submit already ran as this job in the last half hour and has finished; this is its result. Pass resubmit_reason to render it again."
              : "半小时内同样的提交已经跑过、已结束，这是它的结果；确实要重渲，带上 resubmit_reason。") }) };
      }
      const prompt = typeof rest.prompt === "string" ? rest.prompt : JSON.stringify(rest);
      const partNo = promptPartNumber(prompt);
      const holding = turn.ticket_id && partNo !== null && !reason ? store.partJob(turn.ticket_id, partNo) : null;
      if (holding) {
        return { ok: false, emitted: [], error: { code: "job_pending", message: holding.state === "pending"
          ? `part ${partNo} already has job ${holding.request_id} running; the app polls it and wakes you when it is done. To submit it again anyway, pass resubmit_reason saying why.`
          : `part ${partNo}'s job ${holding.request_id} is done but its result has not been handed over yet; hand it over (or say why it will not do) first. To submit again anyway, pass resubmit_reason saying why.` } };
      }
      job = { digest, partNo, reason };
    }
    if (callId && live.mcpTools.get(name)?.readOnly !== true && store.capabilities().engine_level >= ENGINE_LEVELS.supervision) {
      const started = store.beginToolExecution({ turnId: turn.id, toolCallId: callId, tool: name, sideEffect: true });
      if (!started.begun) return toolFail("repeated_effect", "this remote call already started; no duplicate submission was sent");
    }
    const called = await mcp.call(name, forwarded, live.abort.signal);
    if (called.ok && pair?.kind === "submit" && job) {
      const requestId = jobIdOf(called.data);
      if (requestId) {
        store.registerJob({ server: pair.server, submitTool: pair.submitTool, checkTool: pair.checkTool, idParam: pair.idParam, requestId, digest: job.digest,
          taskId: turn.task_id ?? null, ticketId: turn.ticket_id ?? null, partNo: job.partNo, botId: turn.bot_id, workItemId: turn.work_item_id ?? null,
          turnId: turn.id, sessionId: turn.session_id, statusText: jobStatusOf(called.data).statusText, resubmitReason: job.reason });
        const note = en ? `(app) Job ${requestId} is registered: the app polls it and wakes you when it is done — no need to check on it or book a check-back.`
          : `（应用）作业 ${requestId} 已登记：应用自己去查，完成后会叫你——不用轮询，也不用为它约回看。`;
        const data = called.data as { content?: unknown[] } | null;
        return { ok: true, emitted: [], data: data && Array.isArray(data.content) ? { ...data, content: [...data.content, { type: "text", text: note }] } : called.data };
      }
    }
    if (called.ok) return { ok: true, data: called.data, emitted: [] };
    return { ok: false, error: called.error, emitted: [] };
  }

  async function inspectForTurn(turnId: string, live: Live, server: McpServer): Promise<McpServer | null> {
    if (!mcp || !server.enabled || !active(turnId, live)) return null;
    const inspected = await mcp.inspect(server);
    if (!active(turnId, live)) return null;
    return store.applyMcpInspection(server.id, server.updated_at, inspected);
  }

  async function publishEmitted(turnId: string, live: Live, emitted: ToolResult["emitted"]): Promise<void> {
    for (const item of emitted) {
      if (!active(turnId, live)) return;
      if (item.kind === "bot") {
        publish({ event: "bot.upsert", occurred_at: occurred(), ...item.bot, deleted_at: item.deleted_at });
      } else if (item.kind === "session") {
        const s = item.session;
        publish({
          event: "session.upsert",
          occurred_at: occurred(),
          ...sessionUpsertFields(s),
        });
      } else if (item.kind === "message") {
        publishMessage(item.message);
      } else if (item.kind === "participation") {
        void track(handleParticipation(item.message, { fromUser: false }));
      } else if (item.kind === "routine") {
        publish({ event: "routine.upsert", occurred_at: occurred(), ...item.routine });
        if (!admission?.draining) fireRoutine(item.routine.id);
      } else if (item.kind === "routine_removed") {
        publish({ event: "routine.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "skill") {
        publish({ event: "skill.upsert", occurred_at: occurred(), ...item.skill });
      } else if (item.kind === "skill_removed") {
        publish({ event: "skill.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "memory") {
        publish({ event: "memory.upsert", occurred_at: occurred(), ...item.memory });
      } else if (item.kind === "memory_removed") {
        publish({ event: "memory.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "provider") {
        publish({ event: "provider.upsert", occurred_at: occurred(), ...item.provider });
      } else if (item.kind === "provider_removed") {
        publish({ event: "provider.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "mcp") {
        let server = item.server;
        if (mcp) {
          try {
            const inspected = await inspectForTurn(turnId, live, server);
            if (!active(turnId, live)) return;
            const current = inspected ?? store.listMcpServers().find((row) => row.id === server.id);
            if (!current) continue;
            server = current;
          } catch {
            // catalog parse is best-effort; the row is already saved
          }
        }
        publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
      } else if (item.kind === "mcp_removed") {
        publish({ event: "mcp.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "settings") {
        const settings = await store.settings();
        if (!active(turnId, live)) return;
        publish({ event: "settings.changed", occurred_at: occurred(), ...settings });
      }
    }
  }

  /**
   * The card a call waits on for your OK, with its approval row and `waiting_approval`, written in
   * one transaction; resolves with what `run` returned once you allowed it, a refusal when you
   * denied it, or null when the turn stopped first. The app's own tools and a Claude Agent turn's
   * permission prompts (ADR 0061) both come through here.
   */
  async function openApprovalCard(
    turn: Turn,
    live: Live,
    waitApproval: NonNullable<ToolResult["waitApproval"]>,
    toolCallId: string,
  ): Promise<ToolResult | null> {
    const turnId = turn.id;
    const { card, approval, waiting } = store.transaction(() => {
      const card = store.insertMessage({
        sessionId: turn.session_id,
        turnId,
        parentId: live.parentId,
        kind: "approval",
        author: turn.bot_id,
        body: waitApproval.summary,
      });
      const approval = store.insertApproval({
        turnId,
        messageId: card.id,
        kind_key: waitApproval.kind_key,
        summary: waitApproval.summary,
        target: waitApproval.target,
        requires_api_key: Boolean(waitApproval.requiresApiKey),
      });
      const waiting = store.setTurnStatus(turnId, "waiting_approval");
      return { card, approval, waiting };
    });
    const pending = waitForApproval(
      turnId,
      approval.id,
      toolCallId,
      waitApproval.run,
      waitApproval.requiresApiKey,
    );
    publishMessage(card);
    publish({ event: "approval.upsert", occurred_at: occurred(), ...approval });
    publishTurn(waiting, null);
    return pending;
  }

  /**
   * A question card for you, with `waiting_ask` and its notification, written in one transaction;
   * resolves with your answer, or null when the turn stopped first. Shared with a Claude Agent
   * turn's own questions (ADR 0061).
   */
  async function openAskCard(
    turn: Turn,
    live: Live,
    waitAsk: NonNullable<ToolResult["waitAsk"]>,
    toolCallId: string,
  ): Promise<{ ask: Message; answer: AskAnswer | null }> {
    const turnId = turn.id;
    const { ask, waiting } = store.transaction(() => {
      const ask = store.insertMessage({
        sessionId: turn.session_id,
        turnId,
        parentId: live.parentId,
        kind: "ask",
        author: turn.bot_id,
        body: waitAsk.question,
        ask: waitAsk.spec,
      });
      store.db.run(
        "UPDATE turns SET status = 'waiting_ask', pending_ask_id = ?, updated_at = ? WHERE id = ?",
        [ask.id, isoNow(), turnId],
      );
      const waiting = store.getTurn(turnId);
      store.createNotification({
        semantic_key: `ask:${ask.id}`,
        kind: "ask",
        session_id: turn.session_id,
        message_id: ask.id,
        turn_id: turnId,
        created_at: ask.created_at,
        action_state: "open",
      });
      return { ask, waiting };
    });
    publishMessage(ask);
    publishTurn(waiting, null);
    const answer = await waitForAsk(turnId, ask.id, toolCallId);
    return { ask, answer };
  }

  function waitForApproval(
    turnId: string,
    approvalId: string,
    toolCallId: string,
    run: (opts?: { api_key?: string; approval_id?: string; message_id?: string | null }) => Promise<ToolResult> | ToolResult,
    requiresApiKey?: boolean,
  ): Promise<ToolResult | null> {
    const live = lives.get(turnId);
    if (!live) return Promise.resolve(null);
    return new Promise((resolve) => {
      live.approval = {
        id: approvalId,
        toolCallId,
        run,
        requiresApiKey,
        waiter: (result) => resolve(result),
      };
      const abort = () => resolve(null);
      live.abort.signal.addEventListener("abort", abort, { once: true });
    });
  }

  function waitForAsk(turnId: string, askId: string, toolCallId: string): Promise<AskAnswer | null> {
    const live = lives.get(turnId);
    if (!live) return Promise.resolve(null);
    return new Promise((resolve) => {
      live.ask = {
        id: askId,
        toolCallId,
        waiter: (answer) => {
          resolve(answer);
        },
      };
      const abort = () => resolve(null);
      live.abort.signal.addEventListener("abort", abort, { once: true });
    });
  }

  return {
    noteWrittenPaths,
    noteWrites,
    executeTools,
    recordRun,
    admitPicture,
    withLatestMcp,
    dispatchTool,
    inspectForTurn,
    publishEmitted,
    waitForApproval,
    waitForAsk,
    openApprovalCard,
    openAskCard,
    beforeEffect,
  };
}
