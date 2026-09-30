/**
 * Running a hop's tool calls: workspace tools, collab tools (memories, skills, mentions, ...) and
 * whatever an MCP server offers, plus the ask/approval waits a call can put a turn into. What a
 * tool actually wrote to the workspace is tracked here too, since that is what a closing check and
 * a delivered message both cite.
 */
import type { AskAnswer, ClientEvent, McpServer, Message, Turn } from "@real-bot/protocol";
import { askAnswerText } from "../ask";
import { runCollabTool, type ToolResult } from "../collab-tools";
import type { ToolCall } from "../completions";
import { isoNow } from "../ids";
import { attachPictures, fitsHop, pictureResultNote, type LoopPicture } from "../loop-pictures";
import type { McpHost } from "../mcp-host";
import { inlineWorkspaceRefs } from "../mcp-workspace-refs";
import { COLLAB_TOOL_NAMES } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { sessionUpsertFields } from "../session-events";
import { isReservedTaskPath, type Store } from "../store";
import { TOOL_FAILURES_KEPT } from "../store/routing";
import { mergeCitedPaths, writtenPathFromToolData } from "../artifact-paths";
import { takeCodePoints } from "../text";
import { toolTargetOf } from "../tool-activity";
import { serializeToolResult } from "../tool-results";
import type { WakeWatch } from "../wake";
import { classifyPath } from "../workspace-paths";
import { isWorkspaceTool, runWorkspaceTool, type ShellStream } from "../workspace-tools";
import type { Closing } from "./closing";
import type { Participation } from "./participation";
import type { Live } from "./types";

/** Tools that are the work itself, not looking around: a turn using one is working on its ticket. */
const WORKING_TOOLS = new Set(["write_file", "delete_file", "shell"]);

/** How much of a failed call's target and error the learning hop reads: enough to name it. */
const FAILURE_TARGET_MAX = 160;
const FAILURE_ERROR_MAX = 240;

export type ToolsDeps = {
  store: Store;
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
};

export type Tools = {
  noteWrittenPaths: (live: Live, toolName: string, result: ToolResult) => void;
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
    run: (opts?: { api_key?: string }) => Promise<ToolResult> | ToolResult,
    requiresApiKey?: boolean,
  ) => Promise<ToolResult | null>;
  waitForAsk: (turnId: string, askId: string, toolCallId: string) => Promise<AskAnswer | null>;
};

export function createTools(deps: ToolsDeps): Tools {
  const { store, publish, publishMessage, publishTurn, occurred, wake, mcp, admission, streams, lives, active, track, closingCheckForSend, handleParticipation, fireRoutine, observeTicket } = deps;

  function noteWrittenPaths(live: Live, toolName: string, result: ToolResult): void {
    if (!result.ok) return;
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
    }
  }

  async function executeTools(turnId: string, calls: ToolCall[]): Promise<"wait" | "noop" | "more" | "spoke"> {
    const live = lives.get(turnId);
    if (!live) return "wait";
    const turn = store.getTurn(turnId);
    const workDir = live.workDir;
    let posted = false;
    let spoke = false;
    let ended = false;
    // What read_file found this hop; shown after all the hop's tool results (see loop-pictures.ts).
    const pictures: LoopPicture[] = [];
    for (const call of calls) {
      if (!active(turnId, live)) return "wait";
      live.toolCalls += 1;
      if (!live.ticketWorking && (WORKING_TOOLS.has(call.name) || live.mcpTools.has(call.name))) {
        live.ticketWorking = true;
        observeTicket(turnId, turn.bot_id, "working");
      }
      const fingerprint = `${call.name}\n${call.arguments}`;
      if (live.failedCalls.has(fingerprint)) live.repeatedFailures += 1;
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
      const bounce = call.name === "send_message" ? await closingCheckForSend(turnId, live, turn, args) : null;
      if (!active(turnId, live)) return "wait";
      let result: ToolResult;
      if (bounce) {
        result = { ok: false, error: { code: "closing_check", message: bounce }, emitted: [] };
      } else {
        const target = toolTargetOf(call.name, args);
        const mcpTool = live.mcpTools.get(call.name);
        publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id: call.id,
          name: call.name, arguments: call.arguments, phase: "started",
          ...(target ? { target } : {}),
          ...(mcpTool ? { mcp_server: mcpTool.server, mcp_tool: mcpTool.tool } : {}) });
        result = await dispatchTool(turn, live, call.name, args, call.id);
        publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id: call.id,
          name: call.name, phase: "exited", duration_ms: Date.now() - startedAt,
          exit_code: typeof result.data?.exit_code === "number" ? result.data.exit_code : null,
          // How it came back, unless it is still waiting on an approval or an answer: a refusal
          // (bad arguments, a draining runtime) is known here, whether or not another hop follows.
          ...(result.waitApproval || result.waitAsk
            ? {}
            : { ok: result.ok, ...(result.ok || !result.error ? {} : { error_code: result.error.code }) }) });
        if (!result.waitApproval) recordRun(turnId, live, call.name, args, result);
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
      noteWrittenPaths(live, call.name, result);
      if (result.waitAsk) {
        const waitAsk = result.waitAsk;
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
        const answer = await waitForAsk(turnId, ask.id, call.id);
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
        const waitApproval = result.waitApproval;
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
          call.id,
          waitApproval.run,
          waitApproval.requiresApiKey,
        );
        publishMessage(card);
        publish({ event: "approval.upsert", occurred_at: occurred(), ...approval });
        publishTurn(waiting, null);
        let resolved = await pending;
        if (resolved == null || !active(turnId, live)) return "wait";
        recordRun(turnId, live, call.name, args, resolved);
        await publishEmitted(turnId, live, resolved.emitted);
        if (!active(turnId, live)) return "wait";
        resolved = withLatestMcp(call.name, resolved);
        noteWrittenPaths(live, call.name, resolved);
        const payload = resolved.ok
          ? { ok: true, data: admitPicture(live, pictures, resolved) }
          : { ok: false, error: resolved.error };
        if (!resolved.ok) noteFailure(live, call.name, args, fingerprint, resolved.error);
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
      if (call.name === "end_turn" && result.ok) ended = true;
      if (!skipped) posted = true;
      const payload = result.ok
        ? { ok: true, data: admitPicture(live, pictures, result) }
        : { ok: false, error: result.error };
      // A closing-check bounce is a nudge, not a tool that failed: the review must not read it as one.
      if (!result.ok && result.error?.code !== "closing_check") {
        noteFailure(live, call.name, args, fingerprint, result.error);
      }
      live.loop.push({
        role: "tool",
        tool_call_id: call.id,
        content: serializeToolResult(payload, store.workspacePath(), workDir),
      });
    }
    if (spoke) return "spoke";
    // end_turn: the Bot has nothing to say, so the turn ends here with no message.
    if (ended) return "noop";
    attachPictures(live.loop, pictures, live.locale);
    return posted ? "more" : "noop";
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
  function recordRun(turnId: string, live: Live, name: string, args: Record<string, unknown>, result: ToolResult): void {
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
      });
    } catch {
      // the record is evidence, not the work; the call already happened
    }
  }

  /** A picture's tool result, which says whether this hop had room to show it. */
  function admitPicture(live: Live, pictures: LoopPicture[], result: ToolResult): Record<string, unknown> | undefined {
    if (!result.picture) return result.data;
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
    if (isWorkspaceTool(name) || COLLAB_TOOL_NAMES.includes(name)) {
      const streamId = callId ? `${turn.id}:${callId}` : undefined;
      return isWorkspaceTool(name)
        ? await runWorkspaceTool(
            { store, signal: live.abort.signal, workDir: live.workDir, stream: streams, streamId, wake,
              turnId: turn.id, toolCallId: callId },
            name,
            args,
          )
        : await runCollabTool(
            {
              store,
              botId: turn.bot_id,
              sessionId: turn.session_id,
              turnId: turn.id,
              parentId: live.parentId,
              writtenPaths: live.writtenPaths,
              workDir: live.workDir,
              planDir: live.planDir,
              mentionWarned: live.mentionWarned,
              availableToolNames: live.toolNames,
              admission,
              signal: live.abort.signal,
            },
            name,
            args,
          );
    }
    if (!mcp) {
      return { ok: false, error: { code: "failed", message: `unknown tool: ${name}` }, emitted: [] };
    }
    // A `workspace://` picture goes out as its data URI; the call the model sees keeps the reference.
    const outgoing = inlineWorkspaceRefs(args, store.workspacePath());
    if (!outgoing.ok) {
      return { ok: false, error: { code: "invalid_args", message: outgoing.message }, emitted: [] };
    }
    const called = await mcp.call(name, outgoing.args, live.abort.signal);
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

  function waitForApproval(
    turnId: string,
    approvalId: string,
    toolCallId: string,
    run: (opts?: { api_key?: string }) => Promise<ToolResult> | ToolResult,
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
    executeTools,
    recordRun,
    admitPicture,
    withLatestMcp,
    dispatchTool,
    inspectForTurn,
    publishEmitted,
    waitForApproval,
    waitForAsk,
  };
}
