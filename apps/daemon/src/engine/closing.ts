/**
 * A delivery to the user goes out only after one look at what the job asked for. The closing check
 * runs once per turn, when a message that cites workspace files — or says the work is still going
 * — is about to reach a session the user is in; it fails open on anything it cannot prove. Since
 * 2026-09-28 (ADR 0036, `docs/adr/0036-acceptance-checks-run-by-the-daemon.md`) that proof is
 * deterministic: the app's own acceptance checks, a booked check-back or an @-mention for an
 * unbacked promise, and `turn_runs` for an unverified claim — see `closing-check.ts`'s header for
 * why the old model-judged version was dropped. `publishCitedBotMessage` and `completeSilent` are
 * the two ways a turn's reply actually reaches the transcript, closing check already run.
 */
import { attachmentLinePaths, USER_MEMBER, type AcceptanceCheck, type Locale, type Message, type Turn } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "../ablation";
import {
  extractWorkspacePathsFromBody,
  linkifyWorkspacePaths,
  mergeCitedPaths,
  resolveBodyPathsToWorkDir,
} from "../artifact-paths";
import { pathExists } from "../collab-tools";
import {
  claimsVerification,
  closingNote,
  describeFailingCheck,
  FAILING_CHECKS_LIMIT,
  promisesLaterWork,
} from "../closing-check";
import type { CompletionsClient } from "../completions";
import { evaluateFileCheck } from "../acceptance-eval";
import { runMeasureCheck } from "../measure-check";
import { parseMentions } from "../mentions";
import { isNoWorkCloser } from "../no-work";
import type { TurnAdmission } from "../quiesce";
import type { TurnExecution } from "../store/routing";
import { derivedNotGate, type Store } from "../store";
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
  /** Benchmark switches (see `ablation.ts`): `closing-check` lets every delivery through unchecked. */
  ablation?: Ablation;
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
  const { store, admission, lives, active, publishTurn, publishMessage, executionOf, observeTicket } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;

  /**
   * This turn's plan checks that fail right now, named the way the note lists them, oldest-defined
   * first, capped at {@link FAILING_CHECKS_LIMIT}. File-kind checks (`exists`/`contains`/`matches`)
   * are re-evaluated in memory with `evaluateFileCheck` — a Bot that just fixed the file is not
   * bounced on a stale result, and no run is recorded for this look — and so is a `measure` (one
   * ffprobe call). Command checks read the latest stored run instead (the app never re-spawns a
   * command on a Bot's behalf); one is skipped when this turn already ran the exact same command
   * successfully. A check from your words with no file bound yet is skipped: it gates nothing.
   */
  async function failingCheckLines(taskId: string, turnId: string, locale: Locale): Promise<string[]> {
    let checks: AcceptanceCheck[];
    try {
      checks = store.listChecks(taskId);
    } catch {
      return [];
    }
    if (checks.length === 0) return [];
    let runs: ReturnType<Store["turnRuns"]> = [];
    try {
      runs = store.turnRuns(turnId);
    } catch {
      runs = [];
    }
    const ranOkThisTurn = (command: string): boolean => {
      const normalized = command.replace(/\s+/g, " ").trim();
      return runs.some(
        (run) => run.tool === "shell" && run.ok === 1 && run.exit_code === 0 && run.command.replace(/\s+/g, " ").trim() === normalized,
      );
    };
    const root = store.workspacePath();
    const lines: string[] = [];
    for (const check of checks) {
      if (lines.length >= FAILING_CHECKS_LIMIT) break;
      if (derivedNotGate(check)) continue;
      if (check.kind === "command") {
        if (!check.command || ranOkThisTurn(check.command)) continue;
        const lastRun = check.last_run;
        if (!lastRun || lastRun.outcome !== "fail") continue;
        lines.push(describeFailingCheck(check, locale, lastRun.detail));
        continue;
      }
      if (!root) continue;
      const verdict = check.kind === "measure" ? await runMeasureCheck(root, check, { locale }) : await evaluateFileCheck(root, check, locale);
      if (verdict.outcome !== "fail") continue;
      lines.push(describeFailingCheck(check, locale, verdict.detail));
    }
    return lines;
  }

  /** Whether the body @-mentions a real Bot by name, or `@everyone` — either counts as "handed to someone". */
  function mentionsSomeone(body: string): boolean {
    let roster: Array<{ name: string }> = [];
    try {
      roster = store.listBots();
    } catch {
      roster = [];
    }
    const parsed = parseMentions(body, roster.map((bot) => bot.name));
    return parsed.everyone || parsed.mentions.length > 0;
  }

  /**
   * Runs the closing check once per turn, when a delivery — a message that cites workspace files,
   * or one that says the work is still going — is about to reach a session the user is in. Returns
   * the note to hand back when the app's own evidence contradicts the reply, else null. Fails
   * open: no task, draining, the user not present, or the turn going inactive mid-check all mean
   * "let it through" — this is a courtesy, not a gate.
   */
  async function closingCheck(
    turnId: string,
    live: Live,
    turn: Turn,
    input: { body: string; paths: string[]; sessionId: string },
  ): Promise<string | null> {
    if (ablation.has("closing-check")) return null;
    if (live.closingChecked) return null;
    const isDelivery = input.paths.length > 0;
    const isPromise = promisesLaterWork(input.body);
    if (!isDelivery && !isPromise) return null;
    if (admission?.draining) return null;
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

    const failingChecks = isDelivery ? await failingCheckLines(taskId, turnId, live.locale) : [];
    if (!active(turnId, live)) return null;

    let unbackedPromise = false;
    if (isPromise) {
      let booked: unknown = null;
      try {
        booked = store.pendingCheckBack(turn.bot_id, input.sessionId);
      } catch {
        booked = null;
      }
      unbackedPromise = !booked && !mentionsSomeone(input.body);
    }

    let unverifiedClaim = false;
    if (claimsVerification(input.body)) {
      let ranThisTurn = 0;
      try {
        ranThisTurn = store.turnRuns(turnId).length;
      } catch {
        ranThisTurn = 0;
      }
      unverifiedClaim = ranThisTurn === 0;
    }

    return closingNote(live.locale, { failingChecks, unbackedPromise, unverifiedClaim });
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
    const remaining = live ? store.uncitedTurnPaths(turnId, live.writtenPaths) : [];
    if (live && remaining.length > 0) {
      const paths = live.writtenPaths;
      live.writtenPaths = remaining;
      publishCitedBotMessage(current, live, turnId, "");
      live.writtenPaths = paths;
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
    // A plan call-back that only says again what this Bot already said here moves nothing. The
    // turn ends without the second copy; the plan watch then tells you the plan stopped.
    if (
      live.writtenPaths.length === 0 &&
      store.repeatsPlanAnswer({ turnId, sessionId: turn.session_id, author: turn.bot_id, body: linked, planNudge: live.planNudge === true })
    ) {
      return null;
    }
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
