/**
 * A delivery to the user goes out only after one look at what the job asked for. The closing check
 * runs once per turn, when a message that cites workspace files — or says the work is still going
 * — is about to reach a session the user is in; it fails open on anything but a clear miss, since
 * the call is a courtesy, not a gate. `publishCitedBotMessage` and `completeSilent` are the two
 * ways a turn's reply actually reaches the transcript, closing check already run.
 */
import { attachmentLinePaths, USER_MEMBER, type Message, type Turn } from "@real-bot/protocol";
import {
  extractWorkspacePathsFromBody,
  linkifyWorkspacePaths,
  mergeCitedPaths,
  resolveBodyPathsToWorkDir,
} from "../artifact-paths";
import { pathExists } from "../collab-tools";
import {
  CLOSING_CHECK_MAX_TOKENS,
  CLOSING_CHECK_SYSTEM,
  CLOSING_CHECK_TIMEOUT_MS,
  closingCheckNote,
  closingCheckPayload,
  parseClosingCheck,
  promisesLaterWork,
} from "../closing-check";
import type { CompletionsClient } from "../completions";
import { isNoWorkCloser } from "../no-work";
import type { TurnAdmission } from "../quiesce";
import type { TurnExecution } from "../store/routing";
import type { Store } from "../store";
import type { SpendTracker } from "./spend";
import type { Live } from "./types";

export type ClosingDeps = {
  store: Store;
  completions: CompletionsClient;
  admission: TurnAdmission | undefined;
  lives: Map<string, Live>;
  active: (turnId: string, live: Live) => boolean;
  publishTurn: (turn: Turn, partial?: string | null) => void;
  publishMessage: (message: Message) => void;
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  spendOwner: SpendTracker["spendOwner"];
  /** Late-bound: lifecycle.ts is built after this module. */
  executionOf: (live: Live | undefined) => TurnExecution | null;
  /** Late-bound: plan-watch.ts is built after this module. */
  observeTicket: (turnId: string, botId: string, seen: "working" | "delivered") => void;
};

export type Closing = {
  closingCheck: (
    turnId: string,
    live: Live,
    turn: Turn,
    input: { body: string; paths: string[]; sessionId: string },
  ) => Promise<string | null>;
  closingCheckForSend: (
    turnId: string,
    live: Live,
    turn: Turn,
    args: Record<string, unknown>,
  ) => Promise<string | null>;
  completeSilent: (turnId: string) => void;
  publishCitedBotMessage: (turn: Turn, live: Live, turnId: string, rawBody: string) => Message | null;
};

export function createClosing(deps: ClosingDeps): Closing {
  const { store, completions, admission, lives, active, publishTurn, publishMessage, recordResponseSpend, spendOwner, executionOf, observeTicket } = deps;

  /**
   * Runs the closing check once per turn, when a delivery — a message that cites workspace files,
   * or one that says the work is still going — is about to reach a session the user is in. Returns
   * the note to hand back when something in the job's opening request is neither delivered nor
   * accounted for, else null. Fails open: no job, no brief, no default model, draining, a refused
   * call or an unreadable verdict all mean "let it through". The call is billed to the turn, on
   * the default model it ran on.
   */
  async function closingCheck(
    turnId: string,
    live: Live,
    turn: Turn,
    input: { body: string; paths: string[]; sessionId: string },
  ): Promise<string | null> {
    if (live.closingChecked) return null;
    if (input.paths.length === 0 && !promisesLaterWork(input.body)) return null;
    if (!live.routing || admission?.draining) return null;
    let userPresent = false;
    try {
      userPresent = store.isPresent(input.sessionId, USER_MEMBER);
    } catch {
      userPresent = false;
    }
    if (!userPresent) return null;
    const taskId = store.taskOfTurn(turnId);
    if (!taskId) return null;
    live.closingChecked = true;
    const payload = closingCheckPayload(store, {
      taskId,
      ticketId: store.ticketOfTurn(turnId),
      turnId,
      botId: turn.bot_id,
      sessionId: turn.session_id,
      reply: input.body,
      paths: input.paths,
      locale: live.locale,
    });
    if (!payload) return null;
    let result;
    try {
      result = await completions.judge({
        baseUrl: live.routing.baseUrl,
        apiKey: live.routing.apiKey,
        model: live.routing.model,
        messages: [
          { role: "system", content: CLOSING_CHECK_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal: live.abort.signal,
        timeoutMs: CLOSING_CHECK_TIMEOUT_MS,
        maxTokens: CLOSING_CHECK_MAX_TOKENS,
      });
    } catch {
      return null;
    }
    recordResponseSpend({
      kind: "turn",
      owner: spendOwner(turn.session_id, turn.bot_id),
      turnId,
      target: live.routing,
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
    if (!active(turnId, live)) return null;
    if (result.failKind && result.failKind !== "incomplete") return null;
    const items = parseClosingCheck(result.content ?? "");
    if (!items || items.length === 0) return null;
    return closingCheckNote(live.locale, items);
  }

  /** The closing check for a `send_message`: the body and paths as the tool would resolve them. */
  async function closingCheckForSend(
    turnId: string,
    live: Live,
    turn: Turn,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim() || isNoWorkCloser(body)) return null;
    const sessionId = typeof args.session_id === "string" && args.session_id ? args.session_id : turn.session_id;
    const corrected = resolveBodyPathsToWorkDir(body, live.workDir, (relpath) => pathExists(store, relpath));
    const explicit = Array.isArray(args.paths)
      ? args.paths.filter((item): item is string => typeof item === "string")
      : [];
    const paths = mergeCitedPaths(
      [...live.writtenPaths, ...explicit],
      [...extractWorkspacePathsFromBody(corrected), ...attachmentLinePaths(corrected)],
    );
    return closingCheck(turnId, live, turn, { body: corrected, paths, sessionId });
  }

  function completeSilent(turnId: string): void {
    const live = lives.get(turnId);
    try {
      if (store.getTurn(turnId).status !== "running") {
        lives.delete(turnId);
        return;
      }
    } catch {
      lives.delete(turnId);
      return;
    }
    const current = store.getTurn(turnId);
    if (live && !live.spoke && live.writtenPaths.length > 0) {
      publishCitedBotMessage(current, live, turnId, "");
    }
    if (live?.spoke && live.writtenPaths.length > 0) observeTicket(turnId, current.bot_id, "delivered");
    const completed = store.setTurnStatus(turnId, "completed", executionOf(live));
    lives.delete(turnId);
    publishTurn(completed, null);
  }

  function publishCitedBotMessage(turn: Turn, live: Live, turnId: string, rawBody: string): Message | null {
    // Same correction `send_message` makes: a file named from the shell's cwd is linked where it is.
    const body = resolveBodyPathsToWorkDir(rawBody, live.workDir, (relpath) => pathExists(store, relpath));
    const linked = linkifyWorkspacePaths(body, live.writtenPaths);
    if (!linked.trim() && live.writtenPaths.length === 0) return null;
    const message = store.insertMessage({
      sessionId: turn.session_id,
      turnId,
      parentId: live.parentId,
      kind: "bot",
      author: turn.bot_id,
      body: linked,
      paths: mergeCitedPaths(live.writtenPaths, attachmentLinePaths(body)),
    });
    publishMessage(message);
    live.spoke = true;
    return message;
  }

  return { closingCheck, closingCheckForSend, completeSilent, publishCitedBotMessage };
}
