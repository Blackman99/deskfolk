import { USER_MEMBER, type ControlActionResult, type ControlOffer, type ResolveApprovalRequest } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { FileProgress } from "../file-progress.ts";
import type { MessengerApi } from "../messenger-api.ts";
import {
  askSubmitAllowed,
  classifySendAskFailure,
  clearAskIfMatching,
  nextDraftVersion,
  recordAskError,
} from "../notifications/ask-state.ts";
import type { AskDraftRecord, NotificationCapabilities, SendAskResult } from "../notifications/types.ts";
import type { Connection, DraftReconnect } from "../runtime.svelte.ts";
import type { SessionView } from "../session-view.svelte.ts";
import { applyEvent, type Snapshot } from "../snapshot.ts";
import { stopTarget } from "./transcript.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client and the
 * connection an action rides on, the conversation it is about and its view, the snapshot a reply
 * goes into, a draft kept across a dropped link, the turn a sent line wakes, the request a dropped
 * link left unconfirmed, what the Mac says it supports, and the moves a refusal or a drop needs.
 */
export interface ChatActionsHost {
  readonly api: MessengerApi | null;
  readonly connection: Connection;
  readonly selectedId: string | null;
  snapshot: Snapshot;
  draftReconnect: DraftReconnect;
  readonly notificationCapabilities: NotificationCapabilities;
  viewFor(sessionId: string | null | undefined): SessionView | null;
  claimFocus(sessionId: string, triggerMessageId: string, turnId?: string): void;
  keepUnknownRequest(error: unknown, api: MessengerApi): boolean;
  markDisconnected(): void;
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void>;
}

/**
 * What you do in a conversation besides typing: sending the draft, answering a Bot's question
 * (with the drafts each question keeps), reacting, stopping a turn or a scope and lifting a stop,
 * the buttons on a line's control row, going on after an interrupt, and resolving an approval.
 * `MessengerRuntime` forwards every field and method here under the same names, and reaches back
 * in through {@link ChatActionsHost}.
 */
export class ChatActions {
  constructor(private readonly host: ChatActionsHost) {}

  askDrafts = $state<Map<string, AskDraftRecord>>(new Map());

  /**
   * Send what is drafted in a conversation — the one named, or the selected one. On the workbench
   * a pane always names its own: the selected conversation is whichever pane has the keyboard.
   * True once the Mac has the message; the composer keeps what it staged until then.
   */
  async send(opts?: { attachments?: File[]; paths?: string[]; sessionId?: string }): Promise<boolean> {
    const api = this.host.api;
    const id = opts?.sessionId ?? this.host.selectedId;
    const view = this.host.viewFor(id);
    if (!view) return false;
    const body = view.draft.trim();
    const hasAttachments = Boolean(opts?.attachments && opts.attachments.length > 0);
    const hasPaths = Boolean(opts?.paths && opts.paths.length > 0);
    if (!api || !id || (!body && !hasAttachments && !hasPaths) || view.sending) return false;
    const kept = this.host.draftReconnect;
    if (kept && !kept.confirm && kept.sessionId === id) return false;
    const parentId = view.replyingToId;
    view.sending = true;
    view.upload = null;
    const files = opts?.attachments ?? [];
    try {
      const message = await api.postMessage(id, body, {
        attachments: opts?.attachments,
        ...(hasPaths ? { paths: opts?.paths } : {}),
        parentId,
        ...(hasAttachments ? { onUploadProgress: (progress: FileProgress) => { view.upload = { files, loaded: progress.loaded }; } } : {}),
      });
      if (this.host.draftReconnect?.confirm && this.host.draftReconnect.sessionId === id) this.host.draftReconnect = null;
      if (this.host.api !== api) return true;
      view.draft = "";
      view.replyingToId = null;
      view.pendingFocusTrigger = message.id;
      this.host.claimFocus(id, message.id);
      return true;
    } catch (error) {
      if (this.host.api !== api) return false;
      if (error instanceof ApiError && error.status === 422) return false;
      this.host.keepUnknownRequest(error, api);
      this.host.markDisconnected();
      return false;
    } finally {
      if (this.host.api === api) {
        view.sending = false;
        view.upload = null;
      }
    }
  }

  getAskDraft(askId: string): AskDraftRecord | undefined {
    return this.askDrafts.get(askId);
  }

  setAskDraft(askId: string, body: string): void {
    const current = this.askDrafts.get(askId);
    const updated = { ...nextDraftVersion(current, body), askId };
    const nextMap = new Map(this.askDrafts);
    nextMap.set(askId, updated);
    this.askDrafts = nextMap;
  }

  /** The choices ticked on a question so far; the text you wrote stays as it was. */
  setAskSelection(askId: string, selected: readonly string[]): void {
    const current = this.askDrafts.get(askId);
    const updated = { ...nextDraftVersion(current, current?.body ?? "", selected), askId };
    const nextMap = new Map(this.askDrafts);
    nextMap.set(askId, updated);
    this.askDrafts = nextMap;
  }

  clearAskDraft(askId: string, submittedVersion: number): void {
    const current = this.askDrafts.get(askId);
    const turn = this.host.snapshot.turns.find((t) => t.pending_ask_id === askId);
    const stillCurrent = Boolean(turn && turn.status === "waiting_ask" && turn.pending_ask_id === askId);
    const cleared = clearAskIfMatching(current, submittedVersion, stillCurrent);
    const nextMap = new Map(this.askDrafts);
    if (!cleared) nextMap.delete(askId);
    else nextMap.set(askId, cleared);
    this.askDrafts = nextMap;
  }

  setAskError(askId: string, error: string): void {
    const current = this.askDrafts.get(askId);
    const updated = recordAskError(current, askId, current?.body ?? "", error);
    const nextMap = new Map(this.askDrafts);
    nextMap.set(askId, updated);
    this.askDrafts = nextMap;
  }

  /**
   * Your answer to a question: the choices you ticked, what you wrote, or both. It is written onto
   * the question, which comes back already answered, so the card turns over without waiting for
   * the event.
   */
  async sendAsk(askId: string, answer: { selected?: readonly string[]; custom?: string }, sessionId?: string): Promise<SendAskResult> {
    const api = this.host.api;
    const id = sessionId ?? this.host.selectedId;
    const view = this.host.viewFor(id);
    const sending = view?.sending ?? false;
    const text = (answer.custom ?? "").trim();
    const selected = [...(answer.selected ?? [])];
    const existingDraft = this.askDrafts.get(askId);
    const turn = this.host.snapshot.turns.find((t) => t.pending_ask_id === askId);
    if (this.host.notificationCapabilities.pending_ask_v1) {
      const pendingId = turn ? (turn.pending_ask_id ?? null) : null;
      const notAllowed = askSubmitAllowed(
        this.host.connection === "connected",
        sending,
        text,
        pendingId,
        askId,
        true,
        selected.length,
      );
      if (notAllowed) return notAllowed;
    } else {
      if (!text && selected.length === 0) return { status: "not_submitted", reason: "empty" };
      if (this.host.connection !== "connected") return { status: "not_submitted", reason: "disconnected" };
      if (sending) return { status: "not_submitted", reason: "busy" };
    }
    if (!api || !id || !view) return { status: "not_submitted", reason: "disconnected" };

    const reqId = existingDraft?.requestId;
    view.sending = true;
    try {
      const res = await api.answerAsk(askId, { selected, custom: text || null }, reqId ? { requestId: reqId } : {});
      if (this.host.api === api && res?.id === askId) {
        this.host.snapshot = applyEvent(this.host.snapshot, { event: "message.upsert", occurred_at: new Date().toISOString(), ...res });
      }
      return {
        status: "accepted",
        request_id: reqId,
        message_id: res?.id,
      };
    } catch (error) {
      if (this.host.api !== api) return { status: "not_submitted", reason: "stale_connection" };
      if (error instanceof ApiError) {
        if (error.status === 422 || error.status === 409) {
          void this.host.selectSession(id);
          const stillCurrent = Boolean(turn && turn.status === "waiting_ask" && turn.pending_ask_id === askId);
          return classifySendAskFailure(error, stillCurrent);
        }
        if (error.code === "request_unknown" || error.code === "request_pending") {
          this.host.keepUnknownRequest(error, api);
          const activeRequestId = error.requestId ?? reqId;
          const draft = existingDraft ?? { ...nextDraftVersion(undefined, text, selected), askId };
          draft.requestId = activeRequestId;
          draft.error = error.message;
          const nextMap = new Map(this.askDrafts);
          nextMap.set(askId, draft);
          this.askDrafts = nextMap;
          return { status: "unknown", request_id: activeRequestId, error };
        }
        this.host.keepUnknownRequest(error, api);
        this.host.markDisconnected();
        return { status: "rejected", error };
      }
      const apiError = new ApiError(500, "failed", error instanceof Error ? error.message : "request failed");
      return { status: "rejected", error: apiError };
    } finally {
      if (this.host.api === api) view.sending = false;
    }
  }

  async toggleReaction(messageId: string, emoji: string): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    const message = this.host.snapshot.messages.find((m) => m.id === messageId);
    const hasReacted = message?.reactions.some((r) => r.actor === USER_MEMBER && r.emoji === emoji);
    try {
      if (hasReacted) {
        await api.deleteReaction(messageId, emoji);
      } else {
        await api.putReaction(messageId, emoji);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Stop the turn a conversation is on — the one named, or the selected one. In a group, where
   * several Bots may be at work, the Stop on one Bot's reply names that turn.
   */
  async stopTurn(sessionId?: string, turnId?: string): Promise<void> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") return;
    const id = sessionId ?? this.host.selectedId;
    const session = this.host.snapshot.sessions.find((row) => row.id === id);
    const target =
      turnId ??
      stopTarget(
        this.host.snapshot.turns,
        id,
        this.host.viewFor(id)?.focusedTurnId ?? null,
        session?.kind ?? null,
      );
    if (!target) return;
    try {
      await api.stop(target);
    } catch {
      if (this.host.api === api) this.host.markDisconnected();
    }
  }

  /**
   * A stop chosen from a menu: everything, one Bot, a conversation or a plan. The receipt goes to
   * the conversation it was chosen in, when one is named. A refusal comes back to show; a dropped
   * link marks the connection.
   */
  async stopScope(
    scope: "global" | "bot" | "session" | "plan",
    scopeId: string | null,
    sessionId?: string | null,
    opts: { liftOnNext?: boolean } = {},
  ): Promise<ApiError | null> {
    return this.controlCall((api) =>
      api.createHold({
        scope,
        scope_id: scopeId,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(opts.liftOnNext ? { lift_on_next_user_message: true } : {}),
      }),
    );
  }

  /** Your lift of one stop, from the list of them or the board. */
  async liftHold(holdId: string): Promise<ApiError | null> {
    return this.controlCall((api) => api.liftHold(holdId));
  }

  /** A button on a line about your stops; `taskId` names the plan a widen or narrow button is about. */
  /**
   * A button on a line's control row. Resolves to a refusal to show; to `{ partial }` when a
   * restart notice's 继续 went on with some of its turns and a stop of yours holds the rest; or null.
   */
  async controlAction(messageId: string, action: ControlOffer, taskId?: string, note?: string): Promise<ApiError | { partial: NonNullable<ControlActionResult["partial"]> } | null> {
    const answer: { partial?: ControlActionResult["partial"] } = {};
    const refused = await this.controlCall(async (api) => {
      answer.partial = (await api.controlAction(messageId, { action, ...(taskId ? { task_id: taskId } : {}), ...(note ? { note } : {}) })).partial;
    });
    return refused ?? (answer.partial ? { partial: answer.partial } : null);
  }

  private async controlCall(call: (api: MessengerApi) => Promise<unknown>): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") return null;
    try {
      await call(api);
      return null;
    } catch (error) {
      if (this.host.api !== api) return null;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return error;
      this.host.markDisconnected();
      return null;
    }
  }

  async continueInterrupt(messageId: string, sessionId?: string): Promise<void> {
    const api = this.host.api;
    const view = this.host.viewFor(sessionId);
    if (!api || !view || this.host.connection !== "connected" || view.sending) return;
    view.sending = true;
    try {
      const turn = await api.continueInterrupt(messageId);
      if (this.host.api === api) view.focusedTurnId = turn.id;
    } catch (error) {
      if (this.host.api !== api) return;
      if (error instanceof ApiError && error.status === 422) return;
      this.host.markDisconnected();
    } finally {
      if (this.host.api === api) view.sending = false;
    }
  }

  async resolveApproval(
    id: string,
    action: ResolveApprovalRequest["action"],
    apiKey?: string,
    sessionId?: string,
  ): Promise<ApiError | null> {
    const api = this.host.api;
    const view = this.host.viewFor(sessionId);
    if (!api || !view || view.sending) return null;
    view.sending = true;
    try {
      const body: ResolveApprovalRequest = { action };
      if (typeof apiKey === "string" && apiKey.length > 0) body.api_key = apiKey;
      await api.resolveApproval(id, body);
      return null;
    } catch (error) {
      if (this.host.api !== api) return null;
      if (error instanceof ApiError && (error.status === 422 || error.status === 409)) return error;
      this.host.markDisconnected();
      return null;
    } finally {
      if (this.host.api === api) view.sending = false;
    }
  }
}
