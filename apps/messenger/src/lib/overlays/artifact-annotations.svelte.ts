import { untrack } from "svelte";
import type { AnchorOf, Annotation, AnnotationAnchor, AnnotationAnchorKind, CreateAnnotationRequest, PatchAnnotationRequest } from "@real-bot/protocol";
import type { EncodedCrop } from "../annotations/region-box.ts";
import type { Copy } from "../copy.ts";
import type { ApiError } from "../api.ts";
import {
  annotationsForFile,
  draftsForView,
  groupByDestination,
  type AnnotationTarget,
} from "../annotations/model.ts";
import { anchorFromSelection, type EditorRange } from "../annotations/text-range.ts";
import type { annotateGate } from "../annotations/model.ts";
import type { ArtifactKind } from "./artifacts.ts";

/** What the pane hands the annotation state: each is read where it was read before, so effects track the same signals. */
export interface ArtifactAnnotationsHost {
  relpath: () => string;
  mode: () => "cited" | "workspace";
  target: () => AnnotationTarget | null;
  annotations: () => Annotation[];
  annotationFocusId: () => string | null;
  annotationFileKey: () => string | null;
  workspacePath: () => string | null;
  viewedSessionId: () => string | null;
  onLoadAnnotations: () => ((relpath: string) => void) | undefined;
  onCreateAnnotation: () => ((input: CreateAnnotationRequest) => Promise<ApiError | null>) | undefined;
  onPatchAnnotation: () => ((id: string, patch: PatchAnnotationRequest) => Promise<ApiError | null>) | undefined;
  onDeleteAnnotation: () => ((id: string) => Promise<ApiError | null>) | undefined;
  onSendAnnotations: () => ((sessionId: string, summary: string, ids: string[]) => Promise<ApiError | null>) | undefined;
  t: () => Copy;
  gate: () => ReturnType<typeof annotateGate>;
  contentSha: () => string | null;
  kind: () => ArtifactKind;
  reducedFrom: () => number | null;
  loadOriginal: () => Promise<void>;
}

/** The annotations of the file on screen: this file's rows, the list column, the composer for a new one, the send bar. */
export class ArtifactAnnotations {
  readonly #h: ArtifactAnnotationsHost;

  annotOpen = $state(false);
  annotFocus = $state<string | null>(null);
  /**
   * Bumped on every request to go to `annotFocus` — a list row, a mark, a card — so asking for the
   * one that already has focus shows it again. Every adapter reveals when this changes.
   */
  annotFocusSeq = $state(0);
  /**
   * Resolved rows come off the file itself the moment they are resolved — what is drawn is what is
   * still to do. The bar's checkbox puts them back, for this pane, until it is unchecked.
   */
  annotShowResolved = $state(false);
  /**
   * A resolved row the person went to from this pane while resolved ones were off the file: it is
   * drawn while it has focus, so the 定位 lands somewhere. A card in the transcript is not this — it
   * opens the list on the row and leaves the file as it was; nor is a Bot resolving the row that
   * has focus — that one comes off like any other.
   */
  annotRevealedResolved = $state<string | null>(null);
  /**
   * The spot chosen and waiting for its remark: which kind, the anchor, and — for a region or a
   * frame — how to cut the crop when the draft is saved. The file's path and hash and the message
   * it hangs on are taken when the spot is picked: the anchor was read off that file.
   */
  pendingDraft = $state<{
    kind: AnnotationAnchorKind;
    anchor: AnnotationAnchor;
    crop?: () => Promise<EncodedCrop | null>;
    relpath: string;
    sha: string | null;
    target: AnnotationTarget;
  } | null>(null);
  /** Box and element kinds need a mode: the pointer draws instead of scrolling or clicking through. */
  annotMode = $state(false);
  /** The file's frame (it holds the scroller), and how far down the composer sits so it clears the view's own toolbar. */
  bodyEl = $state<HTMLElement | null>(null);
  composerTop = $state<number | null>(null);
  annotBusy = $state(false);
  annotError = $state<string | null>(null);
  sendBusy = $state(false);
  sendError = $state<string | null>(null);
  fileAnnotations = $derived.by(() => annotationsForFile(this.#h.annotations(), this.#h.relpath(), this.#h.workspacePath(), this.#h.annotationFileKey()));
  annotDrafts = $derived.by(() => groupByDestination(draftsForView(this.#h.annotations(), this.#h.viewedSessionId())));
  annotLoadedPath: string | null = null;
  /** The file the composer and annotate mode belong to. */
  draftPath: string | null = null;

  constructor(host: ArtifactAnnotationsHost) {
    this.#h = host;

    // The HTML picker's bar and the PDF toolbar hold controls the pending spot needs (外层 / 内层,
    // pages, zoom): the composer goes under them instead of over them.
    $effect(() => {
      const body = this.bodyEl;
      if (!this.pendingDraft || !body) {
        this.composerTop = null;
        return;
      }
      const measure = () => {
        // The composer is pinned to the frame, over the scroller, so a bar is measured from the
        // frame's top as it is on screen.
        const top = body.getBoundingClientRect().top;
        let bottom = 0;
        for (const bar of body.querySelectorAll<HTMLElement>("[data-annotator-bar]")) {
          bottom = Math.max(bottom, bar.getBoundingClientRect().bottom - top);
        }
        this.composerTop = bottom > 0 ? Math.round(bottom + 8) : null;
      };
      measure();
      if (typeof ResizeObserver !== "function") return;
      const observer = new ResizeObserver(measure);
      for (const bar of body.querySelectorAll("[data-annotator-bar]")) observer.observe(bar);
      return () => observer.disconnect();
    });
    $effect(() => {
      const path = this.#h.relpath();
      const load = this.#h.onLoadAnnotations();
      if (!path || !load || this.#h.mode() === "workspace" && !path) return;
      if (path === this.annotLoadedPath) return;
      this.annotLoadedPath = path;
      load(path);
    });
    $effect(() => {
      const id = this.#h.annotationFocusId();
      if (!id) return;
      untrack(() => {
        this.focusAnnotation(id, false);
        this.annotOpen = true;
      });
    });
    $effect(() => {
      // A new file: the composer for the old one has nothing to hang on. The shell hands the path
      // over off an object it rebuilds on every snapshot, so the same path again is no new file —
      // letting go there threw away a remark half typed whenever any event came in.
      const path = this.#h.relpath();
      if (path === this.draftPath) return;
      this.draftPath = path;
      untrack(() => {
        this.pendingDraft = null;
        this.annotMode = false;
        this.annotError = null;
        this.annotRevealedResolved = null;
      });
    });
  }

  /**
   * Go to an annotation: a request, so the one already focused is revealed and flashed again.
   * `drawResolved` is false for a card in the transcript: a resolved row stays off the file.
   */
  focusAnnotation(id: string, drawResolved = true): void {
    this.annotFocus = id;
    this.annotFocusSeq += 1;
    this.annotRevealedResolved =
      drawResolved && this.fileAnnotations.find((row) => row.id === id)?.status === "resolved" ? id : null;
  }

  offerAnnotation = (range: EditorRange, value: string): void => {
    if (!this.#h.gate().ok) return;
    this.offerDraft("text_range", anchorFromSelection(value, range));
  };

  /** Any adapter's chosen spot: the composer opens for it. */
  offerDraft(kind: AnnotationAnchorKind, anchor: AnnotationAnchor, crop?: () => Promise<EncodedCrop | null>): void {
    if (!this.#h.gate().ok || !this.#h.target()) return;
    this.pendingDraft = { kind, anchor, crop, relpath: this.#h.relpath(), sha: this.#h.contentSha(), target: this.#h.target()! };
    this.annotError = null;
  }

  cancelDraft = (): void => {
    this.pendingDraft = null;
    this.annotError = null;
  };

  /**
   * Annotate mode on or off. Remotely a picture opens as the Mac's smaller copy, whose size and
   * hash are not the file's: a box is drawn on the original, so that is fetched first.
   */
  async toggleAnnotMode(): Promise<void> {
    if (this.annotMode) {
      this.annotMode = false;
      this.cancelDraft();
      return;
    }
    if (this.#h.kind() === "image" && this.#h.reducedFrom() !== null) {
      const path = this.#h.relpath();
      await this.#h.loadOriginal();
      // Still the copy (the original did not come), or another file by now: stay out of the mode.
      if (this.#h.reducedFrom() !== null || this.#h.relpath() !== path) return;
    }
    this.annotMode = true;
  }

  /** Escape from an adapter: the spot waiting for its remark first, then annotate mode; then the pane's. */
  escapeAnnotation = (): void => {
    if (this.pendingDraft) this.cancelDraft();
    else this.annotMode = false;
  };

  async saveDraft(body: string): Promise<void> {
    const pending = this.pendingDraft;
    if (!pending || !this.#h.onCreateAnnotation()) return;
    const sha = pending.sha;
    if (!sha) {
      this.annotError = this.#h.t().stream.annotationSaveFailed;
      return;
    }
    // Saved, or edited and not saved, since the spot was picked: the anchor describes text that is
    // no longer what is on disk, and the daemon would take it as fresh against the new hash.
    const gate = this.#h.gate();
    if (sha !== this.#h.contentSha() || (!gate.ok && gate.reason === "dirty")) {
      this.annotError = this.#h.t().stream.annotationFileChanged;
      return;
    }
    this.annotBusy = true;
    this.annotError = null;
    // The crop is cut once, from what is on screen, when the draft is kept.
    let crop: EncodedCrop | null = null;
    try {
      crop = (await pending.crop?.()) ?? null;
    } catch {
      crop = null;
    }
    const failed = await this.#h.onCreateAnnotation()!({
      target_message_id: pending.target.messageId,
      relpath: pending.relpath,
      anchor_kind: pending.kind,
      anchor: pending.anchor,
      content_sha256: sha,
      body,
      ...(crop ? { crop } : {}),
    });
    this.annotBusy = false;
    if (failed) {
      this.annotError = this.#h.t().stream.annotationSaveFailed;
      return;
    }
    this.pendingDraft = null;
    this.annotOpen = true;
  }

  async editDraft(row: Annotation, body: string): Promise<void> {
    if (!this.#h.onPatchAnnotation()) return;
    this.annotBusy = true;
    const failed = await this.#h.onPatchAnnotation()!(row.id, { body });
    this.annotBusy = false;
    this.annotError = failed ? this.#h.t().stream.annotationSaveFailed : null;
  }

  async deleteDraft(row: Annotation): Promise<void> {
    if (!this.#h.onDeleteAnnotation()) return;
    this.annotBusy = true;
    const failed = await this.#h.onDeleteAnnotation()!(row.id);
    this.annotBusy = false;
    this.annotError = failed ? this.#h.t().stream.annotationSaveFailed : null;
  }

  async toggleAnnotation(row: Annotation, status: "open" | "resolved"): Promise<void> {
    if (!this.#h.onPatchAnnotation()) return;
    this.annotBusy = true;
    const failed = await this.#h.onPatchAnnotation()!(row.id, { status });
    this.annotBusy = false;
    this.annotError = failed ? this.#h.t().stream.annotationSaveFailed : null;
  }

  /**
   * A click on a row in the list goes to it; a click on the row already selected lets go of it, and
   * a resolved one drawn for it comes back off the file.
   */
  revealAnnotation = (row: Annotation): void => {
    if (this.annotFocus === row.id) {
      this.annotFocus = null;
      this.annotRevealedResolved = null;
      return;
    }
    this.focusAnnotation(row.id);
  };

  /**
   * A click on a drawn mark: open the list on it. The mark is where the person is looking, so a
   * second click on the same one is not a new request to go there.
   */
  pickAnnotation = (id: string): void => {
    if (this.annotFocus !== id) this.focusAnnotation(id);
    this.annotOpen = true;
  };

  /**
   * A control that stands for an annotation away from its spot (the HTML bar's numbered chips):
   * every click is a request to go there, the same one again included.
   */
  goToAnnotation = (id: string): void => {
    this.focusAnnotation(id);
    this.annotOpen = true;
  };

  /** True once the batch went out; the send bar keeps its summary until then. */
  async sendDrafts(sessionId: string, summary: string, ids: string[]): Promise<boolean> {
    if (!this.#h.onSendAnnotations()) return false;
    this.sendBusy = true;
    this.sendError = null;
    const failed = await this.#h.onSendAnnotations()!(sessionId, summary, ids);
    this.sendBusy = false;
    if (failed) this.sendError = this.#h.t().stream.annotationSendFailed;
    return !failed;
  }

  async clearDrafts(ids: string[]): Promise<void> {
    if (!this.#h.onDeleteAnnotation()) return;
    this.sendBusy = true;
    this.sendError = null;
    let failed = 0;
    for (const id of ids) if (await this.#h.onDeleteAnnotation()!(id)) failed += 1;
    this.sendBusy = false;
    if (failed) this.sendError = this.#h.t().stream.annotationClearFailed;
  }

  /** The pending anchor, handed back to the adapter that made it so it can keep drawing it. */
  pendingOf<K extends AnnotationAnchorKind>(k: K): AnchorOf<K> | null {
    return this.pendingDraft && this.pendingDraft.kind === k ? (this.pendingDraft.anchor as AnchorOf<K>) : null;
  }

  movePending = (anchor: AnnotationAnchor): void => {
    if (this.pendingDraft) this.pendingDraft = { ...this.pendingDraft, anchor };
  };
}
