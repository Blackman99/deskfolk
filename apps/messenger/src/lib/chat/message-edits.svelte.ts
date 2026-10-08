import type { Message, MessageVersion, PatchMessageAttributionRequest, WorkAnswerResult } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { Connection } from "../runtime.svelte.ts";
import type { SessionView } from "../session-view.svelte.ts";
import { applyEvent, type Snapshot } from "../snapshot.ts";
import type { AttributedMessage } from "./attribution.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client and the
 * connection a write rides on, the view of the conversation a line is open in, the snapshot a
 * write's reply goes into, the trace a refiled line reloads, the job list a new job loads, the
 * failure mapping every sheet shares, and `cancelEdit` as the runtime answers to it.
 */
export interface MessageEditsHost {
  readonly api: MessengerApi | null;
  readonly connection: Connection;
  snapshot: Snapshot;
  traceReload: number;
  viewFor(sessionId: string | null | undefined): SessionView | null;
  cancelEdit(sessionId: string): void;
  sheetFailure(error: unknown, api: MessengerApi): ApiError | null;
  loadAttributionFor(message: AttributedMessage & { id: string; session_id: string }): void;
}

/**
 * Changing a line you sent and reading what it said before (ADR 0063), refiling a line under
 * another job or a new one, and answering a durable work question — the writes whose replies race
 * the sequenced stream, with the counters that let a newer event win. `MessengerRuntime.ingest`
 * bumps those counters; the runtime forwards every field and method here under the same names,
 * and this reaches back in through {@link MessageEditsHost}.
 */
export class MessageEdits {
  constructor(private readonly host: MessageEditsHost) {}

  readonly attributionRevision = new Map<string, number>();
  messageSnapshotRevision = 0;
  messageInvalidationSeq = 0;
  readonly messageSessionInvalidated = new Map<string, number>();

  /** Opens a line of yours for changing, in its bubble (ADR 0063). */
  startEdit(sessionId: string, message: Message): void {
    const view = this.host.viewFor(sessionId);
    if (!view || view.editSaving) return;
    view.editingMessageId = message.id;
    view.editDraft = message.body;
    view.editError = null;
  }

  /** Leaves the line as it was: nothing is sent. */
  cancelEdit(sessionId: string): void {
    const view = this.host.viewFor(sessionId);
    if (!view || view.editSaving) return;
    view.editingMessageId = null;
    view.editDraft = "";
    view.editError = null;
  }

  /**
   * Sends the new words of the line open in its bubble. It comes back as it now reads and shows at
   * once, and the bubble closes; the same words close it with nothing sent. A refusal, or a link
   * that dropped, is said under the editor, and the words you typed stay there.
   */
  async saveEdit(sessionId: string): Promise<boolean> {
    const view = this.host.viewFor(sessionId);
    const id = view?.editingMessageId ?? null;
    if (!view || !id || view.editSaving) return false;
    const current = this.host.snapshot.messages.find((message) => message.id === id) ?? null;
    if (current && view.editDraft.trim() === current.body.trim()) {
      this.host.cancelEdit(sessionId);
      return true;
    }
    if (!view.editDraft.trim() && !(current?.attachments.length)) {
      view.editError = "empty";
      return false;
    }
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") {
      view.editError = "failed";
      return false;
    }
    const revision = this.attributionRevision.get(id) ?? 0;
    const snapshotRevision = this.messageSnapshotRevision;
    const invalidationSeq = this.messageInvalidationSeq;
    view.editSaving = true;
    view.editError = null;
    try {
      const message = await api.editMessage(id, view.editDraft);
      if (this.host.api !== api) return false;
      // The sequenced stream is newer than an in-flight, unsequenced HTTP response.
      if ((this.attributionRevision.get(id) ?? 0) === revision && this.messageSnapshotRevision === snapshotRevision &&
          (this.messageSessionInvalidated.get(message.session_id) ?? 0) <= invalidationSeq) {
        this.host.snapshot = applyEvent(this.host.snapshot, { ...message, event: "message.upsert", occurred_at: new Date().toISOString() });
      }
      if (view.editingMessageId === id) {
        view.editingMessageId = null;
        view.editDraft = "";
      }
      return true;
    } catch (error) {
      const failure = this.host.sheetFailure(error, api);
      view.editError = failure?.code === "not_editable" ? "not_editable" : failure?.code === "invalid_args" ? "empty" : "failed";
      return false;
    } finally {
      view.editSaving = false;
    }
  }

  /**
   * Takes back a line of yours no Bot has read yet (撤回, ADR 0069). It comes back marked so and
   * shows at once; with nothing typed in the box, its words go back there — and the line it quoted
   * with them — to send again as they are or changed. A Bot that read it meanwhile is said under it.
   */
  async withdrawLine(sessionId: string, message: Message): Promise<boolean> {
    const view = this.host.viewFor(sessionId);
    if (!view || view.lineAction) return false;
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") {
      view.lineNote = { id: message.id, code: "failed" };
      return false;
    }
    view.lineAction = { id: message.id, kind: "withdraw" };
    view.lineNote = null;
    try {
      const taken = await this.lineWrite(message.id, api, () => api.withdrawMessage(message.id));
      if (!taken) return false;
      this.refill(sessionId, message);
      return true;
    } catch (error) {
      const failure = this.host.sheetFailure(error, api);
      view.lineNote = { id: message.id, code: failure?.code === "already_read" ? "already_read" : "failed" };
      return false;
    } finally {
      view.lineAction = null;
    }
  }

  /**
   * A line you took back, in the box again. Taking it back fills only an empty box, so nothing typed
   * is lost; 重新编辑 (`append`) puts the words after what is there — once: words already in the box
   * are not put there twice.
   */
  refill(sessionId: string, message: Message, opts: { append?: boolean } = {}): boolean {
    const view = this.host.viewFor(sessionId);
    if (!view) return false;
    const typed = view.draft.trim();
    if (typed && (!opts.append || typed.includes(message.body.trim()))) return false;
    view.draft = typed ? `${view.draft.trimEnd()}\n${message.body}` : message.body;
    if (!typed && message.parent_id) view.replyingToId = message.parent_id;
    return true;
  }

  /**
   * Has the working Bot read a line of yours now (直接插入, ADR 0069), cutting short the step it is
   * on. When no step could be cut — it is wrapping up, or the turn ended — the line still waits
   * for the next one, and that is said under it.
   */
  async insertLine(sessionId: string, message: Message): Promise<boolean> {
    const view = this.host.viewFor(sessionId);
    if (!view || view.lineAction) return false;
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") {
      view.lineNote = { id: message.id, code: "failed" };
      return false;
    }
    view.lineAction = { id: message.id, kind: "insert" };
    view.lineNote = null;
    try {
      let inserted = 0;
      const line = await this.lineWrite(message.id, api, async () => {
        const result = await api.insertMessageNow(message.id);
        inserted = result.inserted;
        return result.message;
      });
      if (!line) return false;
      if (inserted === 0) view.lineNote = { id: message.id, code: "not_now" };
      return inserted > 0;
    } catch (error) {
      this.host.sheetFailure(error, api);
      view.lineNote = { id: message.id, code: "failed" };
      return false;
    } finally {
      view.lineAction = null;
    }
  }

  /** A write about one line whose answer is that line: shown unless the stream already said newer. */
  private async lineWrite(id: string, api: MessengerApi, write: () => Promise<Message>): Promise<Message | null> {
    const revision = this.attributionRevision.get(id) ?? 0;
    const snapshotRevision = this.messageSnapshotRevision;
    const invalidationSeq = this.messageInvalidationSeq;
    const message = await write();
    if (this.host.api !== api) return null;
    if ((this.attributionRevision.get(id) ?? 0) === revision && this.messageSnapshotRevision === snapshotRevision &&
        (this.messageSessionInvalidated.get(message.session_id) ?? 0) <= invalidationSeq) {
      this.host.snapshot = applyEvent(this.host.snapshot, { ...message, event: "message.upsert", occurred_at: new Date().toISOString() });
    }
    return message;
  }

  private readonly versionsRead = new Map<string, { editedAt: string; versions: MessageVersion[] }>();

  /** What a line you changed said before, oldest first: read once per change of it, then kept. */
  async messageVersions(id: string, editedAt: string): Promise<MessageVersion[] | null> {
    const kept = this.versionsRead.get(id);
    if (kept && kept.editedAt === editedAt) return kept.versions;
    const api = this.host.api;
    if (!api) return null;
    try {
      const { versions } = await api.messageVersions(id);
      this.versionsRead.set(id, { editedAt, versions });
      return versions;
    } catch {
      return null;
    }
  }

  /** Refile only after an acknowledged write; a refusal never changes the shown selection. */
  async patchMessageAttribution(id: string, filings: PatchMessageAttributionRequest["filings"]): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") return new ApiError(0, "disconnected", "Attribution not saved");
    const revision = this.attributionRevision.get(id) ?? 0;
    const snapshotRevision = this.messageSnapshotRevision;
    const invalidationSeq = this.messageInvalidationSeq;
    try {
      const message = await api.patchMessageAttribution(id, filings);
      if (this.host.api !== api) return new ApiError(0, "disconnected", "Attribution result unconfirmed");
      // The sequenced stream is newer than an in-flight, unsequenced HTTP response.
      if ((this.attributionRevision.get(id) ?? 0) === revision && this.messageSnapshotRevision === snapshotRevision &&
          (this.messageSessionInvalidated.get(message.session_id) ?? 0) <= invalidationSeq) {
        this.host.snapshot = applyEvent(this.host.snapshot, { ...message, event: "message.upsert", occurred_at: new Date().toISOString() });
      }
      this.host.traceReload += 1;
      return null;
    } catch (error) {
      return this.host.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Attribution result unconfirmed");
    }
  }

  /**
   * 「新开一件事」: a line of yours opens a job of its own and is filed there (the Bots that read it
   * start on it there). The message comes back as it now stands, and the job's name loads with it.
   */
  async newJobFromMessage(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") return new ApiError(0, "disconnected", "Attribution not saved");
    try {
      const message = await api.newJobFromMessage(id);
      if (this.host.api !== api) return new ApiError(0, "disconnected", "Attribution result unconfirmed");
      this.host.snapshot = applyEvent(this.host.snapshot, { ...message, event: "message.upsert", occurred_at: new Date().toISOString() });
      this.host.loadAttributionFor(message);
      this.host.traceReload += 1;
      return null;
    } catch (error) {
      return this.host.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Attribution result unconfirmed");
    }
  }

  /** A durable question belongs to ended work, not a live legacy ask. Never lift a hold here. */
  async answerWorkQuestion(id: string, body: string): Promise<WorkAnswerResult | ApiError> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") return new ApiError(0, "disconnected", "Answer not saved");
    if (!body.trim()) return new ApiError(422, "invalid", "Enter an answer");
    const revision = this.attributionRevision.get(id) ?? 0;
    const snapshotRevision = this.messageSnapshotRevision;
    const invalidationSeq = this.messageInvalidationSeq;
    try {
      // Generic post owns the canonical receipt and reuses its request id on an explicit retry.
      const result = await api.answerWorkQuestion(id, body);
      if (this.host.api !== api) return new ApiError(0, "disconnected", "Answer result unconfirmed");
      if ((this.attributionRevision.get(id) ?? 0) === revision && this.messageSnapshotRevision === snapshotRevision &&
          (this.messageSessionInvalidated.get(result.message.session_id) ?? 0) <= invalidationSeq) {
        this.host.snapshot = applyEvent(this.host.snapshot, { ...result.message, event: "message.upsert", occurred_at: new Date().toISOString() });
      }
      return result;
    } catch (error) {
      return this.host.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Answer result unconfirmed");
    }
  }
}
