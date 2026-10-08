import type { Annotation, AnnotationFilter, CreateAnnotationRequest, PatchAnnotationRequest } from "@real-bot/protocol";
import type { ApiError } from "../api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { SessionView } from "../session-view.svelte.ts";
import type { Snapshot } from "../snapshot.ts";
import { canonicalRelpath, mergeAnnotationRows } from "./model.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client a read or a
 * write rides on, the snapshot annotations live in, the workspace a path is folded against, the
 * failure mapping every sheet shares, and where a sent batch takes you — the conversation it lands
 * in, its view and the turn it wakes. `noteAnnotationWrite` and `selectSession` go through the
 * runtime as it answers to them.
 */
export interface AnnotationStoreHost {
  readonly api: MessengerApi | null;
  snapshot: Snapshot;
  readonly workspacePath: string;
  readonly selectedId: string | null;
  noteAnnotationWrite(id: string): void;
  sheetFailure(error: unknown, api: MessengerApi): ApiError | null;
  sessionView(id: string): SessionView;
  claimFocus(sessionId: string, triggerMessageId: string, turnId?: string): void;
  setHighlightedMessage(messageId: string | null, sessionId?: string): void;
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void>;
}

/**
 * Annotations on deliveries: reading them by filter without bringing back a row an event changed
 * meanwhile, writing them, and sending a batch as one reply; plus which annotation the preview
 * scrolls to and which file each previewed path resolves to. `MessengerRuntime` forwards every
 * field and method here under the same names, and reaches back in through
 * {@link AnnotationStoreHost}.
 */
export class AnnotationStore {
  constructor(private readonly host: AnnotationStoreHost) {}

  /** The annotation a card or a row asked the preview to scroll to; cleared with the preview. */
  annotationFocusId = $state<string | null>(null);
  /**
   * The file each previewed path resolves to, as the daemon named it on the rows it returned for
   * that path: how a preview recognises annotations made on another spelling of the same file.
   */
  annotationFileKeys = $state<Record<string, string>>({});
  /**
   * While an annotation list is on its way, the ids an event or a write's reply changed since, by
   * a running count: the list was read before them, so for those rows the snapshot is the newer
   * word. Only kept while a list is in flight.
   */
  private annotationWriteSeq = 0;
  private readonly annotationWrites = new Map<string, number>();
  private annotationLoads = 0;

  // Annotations ----------------------------------------------------------------------------
  /**
   * Pull the annotations one filter names and put them in the snapshot in place of whatever it
   * held for that filter — a draft deleted from another device is gone here too. Events keep
   * them current afterwards; a failed pull keeps what is on screen.
   */
  async loadAnnotations(filter: AnnotationFilter & { target_session_id?: string }): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    const since = this.annotationWriteSeq;
    this.annotationLoads++;
    try {
      const rows = await api.listAnnotations(filter);
      if (this.host.api !== api) return;
      const fetched = new Set(rows.map((row) => row.id));
      if (filter.relpath) {
        const key = rows.find((row) => row.file_key)?.file_key;
        if (key && this.annotationFileKeys[filter.relpath] !== key) this.annotationFileKeys = { ...this.annotationFileKeys, [filter.relpath]: key };
      }
      // The daemon folds a path filter (absolute, `./`, `//`) and also matches the file's resolved
      // spelling, so a row it returned is in scope whatever this filter looked like, and the rest
      // are compared folded the same way — else a reload would keep the old copy beside the new.
      const wantPath = filter.relpath ? canonicalRelpath(filter.relpath, this.host.workspacePath || null) : null;
      const scoped = (row: Annotation): boolean =>
        (!filter.relpath || fetched.has(row.id) || row.relpath === filter.relpath || canonicalRelpath(row.relpath, this.host.workspacePath || null) === wantPath) &&
        (!filter.session_id || row.session_id === filter.session_id) &&
        (!filter.target_session_id || row.target_session_id === filter.target_session_id) &&
        (!filter.message_id || row.message_id === filter.message_id) &&
        (!filter.target_message_id || row.target_message_id === filter.target_message_id) &&
        (!filter.status || row.status === filter.status);
      // What the filter covers is replaced (a draft deleted elsewhere is gone), but a row an event
      // or a write's reply touched while the list was on its way stays as it left it: one created
      // after the read is kept, one deleted after it is not brought back, and an updated one keeps
      // the newer copy.
      const touched = (id: string): boolean => (this.annotationWrites.get(id) ?? 0) > since;
      const current = this.host.snapshot.annotations;
      const held = new Set(current.map((row) => row.id));
      const kept = current.filter((row) => !scoped(row) && !fetched.has(row.id));
      const inScope = current.filter(scoped);
      const merged = mergeAnnotationRows(
        inScope.filter((row) => fetched.has(row.id) || touched(row.id)),
        rows.filter((row) => held.has(row.id) || !touched(row.id)),
        "replace",
      );
      // One row per id, whatever else went wrong: every keyed list over annotations relies on it.
      this.host.snapshot = { ...this.host.snapshot, annotations: mergeAnnotationRows(kept, merged, "replace") };
    } catch {
      // Keep what is on screen.
    } finally {
      if (--this.annotationLoads === 0) this.annotationWrites.clear();
    }
  }

  /** An event or a write's reply changed (or removed) this row; see {@link annotationWrites}. */
  noteAnnotationWrite(id: string): void {
    if (this.annotationLoads > 0) this.annotationWrites.set(id, ++this.annotationWriteSeq);
  }

  async createAnnotation(input: CreateAnnotationRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      const row = await api.createAnnotation(input);
      if (this.host.api !== api) return null;
      // The event follows; showing the draft now spares the pane a flicker.
      this.host.snapshot = { ...this.host.snapshot, annotations: mergeAnnotationRows(this.host.snapshot.annotations, [row]) };
      this.host.noteAnnotationWrite(row.id);
      return null;
    } catch (error) {
      return this.host.sheetFailure(error, api);
    }
  }

  async patchAnnotation(id: string, patch: PatchAnnotationRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      const row = await api.patchAnnotation(id, patch);
      if (this.host.api !== api) return null;
      if (this.host.snapshot.annotations.some((a) => a.id === row.id)) {
        this.host.snapshot = { ...this.host.snapshot, annotations: mergeAnnotationRows(this.host.snapshot.annotations, [row]) };
        this.host.noteAnnotationWrite(row.id);
      }
      return null;
    } catch (error) {
      return this.host.sheetFailure(error, api);
    }
  }

  async deleteAnnotation(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.deleteAnnotation(id);
      if (this.host.api !== api) return null;
      this.host.snapshot = { ...this.host.snapshot, annotations: this.host.snapshot.annotations.filter((a) => a.id !== id) };
      this.host.noteAnnotationWrite(id);
      if (this.annotationFocusId === id) this.annotationFocusId = null;
      return null;
    } catch (error) {
      return this.host.sheetFailure(error, api);
    }
  }

  /**
   * Send a batch: one reply the Mac composes, quoting the delivery and naming the Bot. The
   * transcript follows the new message the way `send()` does; a batch that lands in another
   * conversation (a Bot↔Bot artifact) takes you there.
   */
  async sendAnnotations(sessionId: string, summary: string, ids: string[]): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api || ids.length === 0) return null;
    try {
      const sent = await api.sendAnnotations({ session_id: sessionId, body: summary, annotation_ids: ids });
      if (this.host.api !== api) return null;
      // A quick Bot may have resolved the batch before this reply landed; its events are newer.
      const held = new Set(this.host.snapshot.annotations.map((a) => a.id));
      this.host.snapshot = {
        ...this.host.snapshot,
        annotations: mergeAnnotationRows(this.host.snapshot.annotations, sent.annotations.filter((row) => held.has(row.id))),
      };
      for (const row of sent.annotations) if (held.has(row.id)) this.host.noteAnnotationWrite(row.id);
      this.annotationFocusId = null;
      // The conversation the reply landed in follows the turn it wakes, whichever pane shows it.
      const landed = sent.message.session_id;
      this.host.sessionView(landed).pendingFocusTrigger = sent.message.id;
      this.host.claimFocus(landed, sent.message.id);
      if (landed === this.host.selectedId) this.host.setHighlightedMessage(sent.message.id, landed);
      else void this.host.selectSession(landed, { messageId: sent.message.id });
      return null;
    } catch (error) {
      return this.host.sheetFailure(error, api);
    }
  }
}
