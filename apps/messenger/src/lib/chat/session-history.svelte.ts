import {
  FILE_DROP_SESSION_ID,
  type AnnotationFilter,
  type ClientEvent,
  type SequencedEvent,
  type SessionDetail,
} from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { EventSync } from "../event-sync.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { NotificationCapabilities } from "../notifications/types.ts";
import type { SessionView } from "../session-view.svelte.ts";
import { collectUntilMessage } from "../sidebar/search-jump.ts";
import type { Snapshot } from "../snapshot.ts";
import type { PaneContent } from "../workbench/pane-content.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client and the
 * event reader a read rides on and the connection it belongs to, the snapshot a conversation's
 * history goes into, the conversation the app is pointed at and its view, the pages a selection
 * closes or puts back, and the event and annotation machinery a read hands its result to.
 * `selectSession` itself goes through the runtime too: a component or a test may replace it there.
 */
export interface SessionHistoryHost {
  readonly api: MessengerApi | null;
  readonly sync: EventSync | null;
  readonly connectionSeq: number;
  snapshot: Snapshot;
  selectedId: string | null;
  readonly activeView: SessionView | null;
  focusedTurnId: string | null;
  historyLoading: boolean;
  readonly notificationCapabilities: NotificationCapabilities;
  readonly spendOpen: boolean;
  readonly terminalOpen: boolean;
  readonly traceOpen: boolean;
  traceSessionId: string | null;
  threadOpen: boolean;
  sessionView(id: string): SessionView;
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void>;
  markSessionRead(id: string): Promise<void>;
  setHighlightedMessage(messageId: string | null, sessionId?: string): void;
  ingest(event: ClientEvent, frame?: SequencedEvent): void;
  loadAnnotations(filter: AnnotationFilter & { target_session_id?: string }): Promise<void>;
  markDisconnected(): void;
  toPane(content: PaneContent): boolean;
  closeRoutines(): void;
  closeSpend(): void;
  closeTerminal(): void;
  closeRemoteScreen(): void;
  closeListPage(): void;
  closeSessionSettings(): void;
  openSpend(): void;
  openTerminal(): void;
}

/**
 * Selecting a conversation and reading its history: the detail read and the events that raced it,
 * paging further back, reaching a message a link names, and marking it read. `MessengerRuntime`
 * forwards every public method here under the same name, and reaches back in through
 * {@link SessionHistoryHost}.
 */
export class SessionHistory {
  constructor(private readonly host: SessionHistoryHost) {}

  private get sessionMessageNext(): string | null { return this.host.activeView?.messageNext ?? null; }
  private set sessionMessageNext(value: string | null) { const view = this.host.activeView; if (view) view.messageNext = value; }

  private get sessionDetailId(): string | null {
    const view = this.host.activeView;
    return view?.detailLoaded ? view.sessionId : null;
  }
  private set sessionDetailId(value: string | null) {
    const view = this.host.activeView;
    if (view) view.detailLoaded = value === view.sessionId;
  }

  sessionLoad = Promise.resolve();

  /** A ledger or search link can outlive the conversation it names. */
  async openChat(id: string, opts?: { messageId?: string }): Promise<void> {
    if (!this.host.snapshot.sessions.some((session) => session.id === id)) return;
    await this.host.selectSession(id, opts);
  }

  async selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void> {
    const previousId = this.host.selectedId;
    const previousSpend = this.host.spendOpen;
    const previousTerminal = this.host.terminalOpen;
    if (!opts?.preservePage) {
      this.host.closeRoutines();
      this.host.closeSpend();
      this.host.closeTerminal();
      this.host.closeRemoteScreen();
      this.host.closeListPage();
      // Selecting the conversation already underneath a pane must still bring it forward.
      if (this.host.selectedId === id) this.host.toPane({ kind: "chat", sessionId: id });
    }
    const api = this.host.api;
    const sync = this.host.sync;
    const view = this.host.sessionView(id);
    const connection = this.host.connectionSeq;
    const selection = ++view.loadSeq;
    const messageId = opts?.messageId;
    this.host.setHighlightedMessage(messageId ?? null, id);
    // The window stays open across conversations and follows the one on screen.
    if (this.host.traceOpen && this.host.selectedId !== id) this.host.traceSessionId = id;
    if (this.host.selectedId !== id) {
      this.host.closeSessionSettings();
      this.host.threadOpen = false;
    }
    // A selected row may still have only summary data, not its history cursor.
    if (this.host.selectedId === id && this.sessionDetailId === id && messageId) {
      const revision = view.revision;
      await this.ensureMessageLoaded(id, messageId);
      if (this.host.api !== api || this.host.sync !== sync || this.host.connectionSeq !== connection ||
        selection !== view.loadSeq || this.host.selectedId !== id || revision !== view.revision) return;
      this.host.setHighlightedMessage(messageId, id);
      return;
    }
    this.host.selectedId = id;
    this.sessionDetailId = null;
    this.sessionMessageNext = null;
    // The reply you were aiming and the chips offered stay with the conversation, like its draft:
    // clicking into another pane is not leaving this one. Opening one drafts nothing: that is ✨.
    if (this.host.focusedTurnId) {
      const focused = this.host.snapshot.turns.find((turn) => turn.id === this.host.focusedTurnId);
      if (!focused || focused.session_id !== id) this.host.focusedTurnId = null;
    }
    if (!this.host.notificationCapabilities.bounded_read_v1) {
      this.host.snapshot = {
        ...this.host.snapshot,
        sessions: this.host.snapshot.sessions.map((s) =>
          s.id === id ? { ...s, unread_count: 0 } : s,
        ),
      };
    }
    if (!api || !sync) return;
    this.host.historyLoading = true;
    this.sessionLoad = this.sessionLoad.catch(() => {}).then(async () => {
      if (selection !== view.loadSeq || this.host.connectionSeq !== connection ||
        this.host.api !== api || this.host.sync !== sync) return;
      sync.pause();
      let readingDetail = true;
      try {
        const detail = await api.sessionSnapshot(id);
        readingDetail = false;
        if (this.host.api !== api || this.host.sync !== sync) return;
        const ready = await sync.waitThrough(detail);
        if (this.host.api !== api || this.host.sync !== sync) return;
        if (!ready) throw new Error("event instance changed");
        const frames = sync.install();
        if (!frames) throw new Error("event gap");
        for (const frame of frames) this.host.ingest(frame.payload, frame);
        if (selection !== view.loadSeq || this.host.connectionSeq !== connection) return;
        const unread = this.host.notificationCapabilities.bounded_read_v1 ? detail.session.unread_count : 0;
        this.applySessionDetail(id, { ...detail.session, unread_count: unread }, detail.judgements);
        // Pulled, not in the snapshot: what was sent here, and what hangs on this conversation's
        // deliveries (drafts on a Bot↔Bot artifact live in your direct but belong to this view).
        // The file drop has no Bot, so nothing there can be annotated or annotated from.
        if (id !== FILE_DROP_SESSION_ID) {
          void this.host.loadAnnotations({ session_id: id });
          void this.host.loadAnnotations({ target_session_id: id });
        }
        for (const frame of frames) {
          if (frame.event_instance_id !== detail.event_instance_id) throw new Error("event instance changed");
          if (frame.seq > detail.watermark_seq) this.host.ingest(frame.payload, frame);
        }
        if (messageId) {
          const revision = view.revision;
          await this.ensureMessageLoaded(id, messageId);
          if (this.host.api !== api || this.host.sync !== sync || this.host.connectionSeq !== connection ||
            selection !== view.loadSeq || this.host.selectedId !== id || revision !== view.revision) return;
          this.host.setHighlightedMessage(messageId, id);
        }
        if (this.host.api !== api || this.host.sync !== sync || this.host.connectionSeq !== connection ||
          selection !== view.loadSeq || this.host.selectedId !== id) return;
        if (!this.host.notificationCapabilities.bounded_read_v1) {
          await this.host.markSessionRead(id);
        }
      } catch (error) {
        if (this.host.api !== api || this.host.sync !== sync) return;
        if (readingDetail && error instanceof ApiError && error.status === 404 && error.code === "not_found") {
          // Resume the event stream even when a stale ledger link has no detail to install.
          const frames = sync.install();
          if (!frames) { this.host.markDisconnected(); return; }
          const stillSelected = this.host.selectedId === id;
          for (const frame of frames) this.host.ingest(frame.payload, frame);
          if (stillSelected && selection === view.loadSeq) {
            this.host.selectedId = previousId && previousId !== id && this.host.snapshot.sessions.some((session) => session.id === previousId)
              ? previousId : null;
            if (previousSpend) this.host.openSpend();
            if (previousTerminal) this.host.openTerminal();
          }
          return;
        }
        this.host.markDisconnected();
      } finally {
        // Only the newest read of this conversation owns its flag; an older one must not clear it.
        if (selection === view.loadSeq && this.host.connectionSeq === connection) view.historyLoading = false;
      }
    });
    await this.sessionLoad;
  }

  /** The transcript holds everything that was fetched for it, and the Mac has more behind it. */
  get hasOlderMessages(): boolean {
    return this.sessionMessageNext !== null;
  }

  /**
   * One page further back. The cursor belongs to the fetch that produced it, so a page landing
   * after the selection moved, the history was cleared, or the connection was replaced is
   * dropped rather than mixed into a transcript it does not belong to.
   */
  async loadOlderMessages(sessionId?: string): Promise<void> {
    const api = this.host.api;
    const sync = this.host.sync;
    const id = sessionId ?? this.host.selectedId;
    if (!api || !id) return;
    // A pane scrolled to its top pages its own conversation back, in front or not.
    const view = this.host.sessionView(id);
    const cursor = view.messageNext;
    if (!cursor || view.olderLoading) return;
    const connection = this.host.connectionSeq;
    const selection = view.loadSeq;
    const revision = view.revision;
    view.olderLoading = true;
    try {
      const page = await api.messages(id, { cursor });
      if (this.host.api !== api || this.host.sync !== sync ||
        this.host.connectionSeq !== connection || view.loadSeq !== selection || view.revision !== revision) return;
      view.messageNext = page.next ?? null;
      const known = new Set(this.host.snapshot.messages.map((message) => message.id));
      const added = page.items.filter((message) => !known.has(message.id));
      if (added.length > 0) {
        this.host.snapshot = { ...this.host.snapshot, messages: [...this.host.snapshot.messages, ...added] };
      }
    } catch {
      // What is on screen stays; a real drop surfaces as the socket closing.
    } finally {
      view.olderLoading = false;
    }
  }

  async markSessionRead(id: string): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    try {
      await api.markSessionRead(id);
    } catch {
      // The selected session is already shown as read; socket failure owns reconnection.
    }
  }

  private async ensureMessageLoaded(sessionId: string, messageId: string): Promise<void> {
    const api = this.host.api;
    const sync = this.host.sync;
    const view = this.host.sessionView(sessionId);
    const connection = this.host.connectionSeq;
    const selection = view.loadSeq;
    const revision = view.revision;
    if (!api) return;
    const loaded = this.host.snapshot.messages.filter((m) => m.session_id === sessionId);
    if (loaded.some((m) => m.id === messageId)) return;
    const result = await collectUntilMessage(
      loaded,
      messageId,
      (cursor) => api.messages(sessionId, { cursor }),
      this.sessionMessageNext,
    );
    if (this.host.selectedId !== sessionId || this.host.api !== api || this.host.sync !== sync ||
      this.host.connectionSeq !== connection || view.loadSeq !== selection || view.revision !== revision) return;
    this.sessionMessageNext = result.next;
    const current = new Map(this.host.snapshot.messages.map((message) => [message.id, message]));
    for (const message of result.messages) if (!current.has(message.id)) current.set(message.id, message);
    this.host.snapshot = { ...this.host.snapshot, messages: [...current.values()] };
  }

  private applySessionDetail(
    id: string,
    detail: SessionDetail,
    judgements: Snapshot["judgements"],
  ): void {
    this.sessionDetailId = id;
    this.sessionMessageNext = detail.messages.next ?? null;
    this.host.snapshot = {
      ...this.host.snapshot,
      sessions: this.host.snapshot.sessions.map((s) =>
        s.id === id
          ? {
              id: detail.id,
              kind: detail.kind,
              name: detail.name,
              last_read_at: detail.last_read_at ?? s.last_read_at ?? null,
              archived_at: detail.archived_at ?? s.archived_at ?? null,
              origin_session_id: detail.origin_session_id ?? s.origin_session_id ?? null,
              origin_message_id: detail.origin_message_id ?? s.origin_message_id ?? null,
              created_at: detail.created_at,
              updated_at: detail.updated_at,
              participants: detail.participants,
              last_message: s.last_message,
              live_turns: s.live_turns,
              unread_count: detail.unread_count ?? s.unread_count ?? 0,
              waiting_on_you: s.waiting_on_you ?? null,
              notification_preference: detail.notification_preference ?? s.notification_preference,
            }
          : s,
      ),
      messages: [
        ...this.host.snapshot.messages.filter((m) => m.session_id !== id),
        ...detail.messages.items,
      ],
      turns: [
        ...this.host.snapshot.turns.filter((t) => t.session_id !== id),
        ...detail.turns,
      ],
      judgements: [
        ...this.host.snapshot.judgements.filter((j) => j.session_id !== id),
        ...judgements,
      ],
      pendingJudgements: [
        ...this.host.snapshot.pendingJudgements.filter((j) => j.session_id !== id),
        ...(detail.pending_judgements ?? []),
      ],
    };
  }
}
