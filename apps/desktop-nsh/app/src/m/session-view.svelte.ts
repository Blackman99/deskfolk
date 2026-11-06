// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: b740df50b34bc60d
import { state } from "../lib/reactive";
import type { ComposerSuggestion } from "@real-bot/protocol";

/** A file picked or pasted into the composer, waiting for the next send. */
export type StagedAttachment = {
  id: string;
  file: File;
  name: string;
  size: number;
  isImage: boolean;
  previewUrl: string | null;
};

/**
 * A file or folder already in the workspace, dragged in from the file tree. It goes out as its
 * path: nothing is uploaded or copied.
 */
export type StagedWorkspacePath = {
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  isImage: boolean;
  /** The Mac's small copy of a picture, once it has arrived. */
  previewUrl: string | null;
};

/**
 * One open conversation's own state.
 *
 * Not one pane's: two panes showing the same conversation share a view, so the draft you started
 * in one is the draft in the other. There is one message you are about to send to one Bot. What
 * genuinely differs between two panes on the same conversation is scroll position and how far the
 * transcript is mounted, and both of those already live in the `ChatStage` instance.
 *
 * Everything here used to be a single slot on `MessengerRuntime`, which is why only one
 * conversation could be open at a time. The runtime still exposes each field under its old name,
 * forwarding to whichever view is selected — but a conversation on screen reads its own view,
 * never those forwards: on the workbench several are on screen and only one is selected, so a
 * forward read from a second pane is the first pane's draft.
 */
export class SessionView {
  readonly sessionId: string;

  /** What you have typed here but not sent. */
  #draft$s = state("");
	get draft() { return this.#draft$s.get(); }
	set draft(value) { this.#draft$s.set(value); }
  /** The message a reply is aimed at, or null for an ordinary send. */
  #replyingToId$s = state<string | null>(null);
	get replyingToId(): string | null { return this.#replyingToId$s.get(); }
	set replyingToId(value: string | null) { this.#replyingToId$s.set(value); }
  /** The line of yours being changed in its bubble here (ADR 0063), or null. */
  #editingMessageId$s = state<string | null>(null);
	get editingMessageId(): string | null { return this.#editingMessageId$s.get(); }
	set editingMessageId(value: string | null) { this.#editingMessageId$s.set(value); }
  /** What that bubble's editor holds: kept while you look at another conversation. */
  #editDraft$s = state("");
	get editDraft() { return this.#editDraft$s.get(); }
	set editDraft(value) { this.#editDraft$s.set(value); }
  /** The change is on its way to the Mac. */
  #editSaving$s = state(false);
	get editSaving() { return this.#editSaving$s.get(); }
	set editSaving(value) { this.#editSaving$s.set(value); }
  /** Why the last save did not land, said under the editor until you change the words or leave. */
  #editError$s = state<"not_editable" | "empty" | "failed" | null>(null);
	get editError(): "not_editable" | "empty" | "failed" | null { return this.#editError$s.get(); }
	set editError(value: "not_editable" | "empty" | "failed" | null) { this.#editError$s.set(value); }
  /** A line of yours being taken back or read now (ADR 0069): its buttons wait for the answer. */
  #lineAction$s = state<{ id: string; kind: "withdraw" | "insert" } | null>(null);
	get lineAction(): { id: string; kind: "withdraw" | "insert" } | null { return this.#lineAction$s.get(); }
	set lineAction(value: { id: string; kind: "withdraw" | "insert" } | null) { this.#lineAction$s.set(value); }
  /** What came of the last of those, said under that line: refused as read, nothing to cut, or no answer. */
  #lineNote$s = state<{ id: string; code: "already_read" | "not_now" | "held" | "failed" } | null>(null);
	get lineNote(): { id: string; code: "already_read" | "not_now" | "held" | "failed" } | null { return this.#lineNote$s.get(); }
	set lineNote(value: { id: string; code: "already_read" | "not_now" | "held" | "failed" } | null) { this.#lineNote$s.set(value); }
  /** The turn the transcript is following, set when you send and when a Bot wakes for you. */
  #focusedTurnId$s = state<string | null>(null);
	get focusedTurnId(): string | null { return this.#focusedTurnId$s.get(); }
	set focusedTurnId(value: string | null) { this.#focusedTurnId$s.set(value); }
  /** Flashed after a jump — a search hit, a trace node, a notification. */
  #highlightedMessageId$s = state<string | null>(null);
	get highlightedMessageId(): string | null { return this.#highlightedMessageId$s.get(); }
	set highlightedMessageId(value: string | null) { this.#highlightedMessageId$s.set(value); }
  /** Bumped so a repeat jump to the same message flashes again. */
  #searchHighlightToken$s = state(0);
	get searchHighlightToken() { return this.#searchHighlightToken$s.get(); }
	set searchHighlightToken(value) { this.#searchHighlightToken$s.set(value); }
  /**
   * Drafted next steps offered above the composer. Each draft is a model call you pay for, so
   * they come only when you press ✨, and go once a new message makes them about the past.
   */
  #composerSuggestions$s = state<ComposerSuggestion[]>([]);
	get composerSuggestions(): ComposerSuggestion[] { return this.#composerSuggestions$s.get(); }
	set composerSuggestions(value: ComposerSuggestion[]) { this.#composerSuggestions$s.set(value); }
  /** The ✨ was pressed and its drafts are still on the way. */
  #suggestionsLoading$s = state(false);
	get suggestionsLoading() { return this.#suggestionsLoading$s.get(); }
	set suggestionsLoading(value) { this.#suggestionsLoading$s.set(value); }
  /** The last ✨ came back with nothing to suggest, or failed; the composer says so briefly. */
  #suggestionsEmpty$s = state(false);
	get suggestionsEmpty() { return this.#suggestionsEmpty$s.get(); }
	set suggestionsEmpty(value) { this.#suggestionsEmpty$s.set(value); }
  /** Stops the drafts on the way when you put them away or the conversation moves on. */
  suggestAbort: AbortController | null = null;
  /** Files waiting to go out with the next message here. */
  #stagedAttachments$s = state<StagedAttachment[]>([]);
	get stagedAttachments(): StagedAttachment[] { return this.#stagedAttachments$s.get(); }
	set stagedAttachments(value: StagedAttachment[]) { this.#stagedAttachments$s.set(value); }
  /** Workspace files and folders dragged in from the tree, going out with it by path. */
  #stagedPaths$s = state<StagedWorkspacePath[]>([]);
	get stagedPaths(): StagedWorkspacePath[] { return this.#stagedPaths$s.get(); }
	set stagedPaths(value: StagedWorkspacePath[]) { this.#stagedPaths$s.set(value); }
  /** A send, an answer, an approval or a continue from here is in flight. Other conversations are not held up by it. */
  #sending$s = state(false);
	get sending() { return this.#sending$s.get(); }
	set sending(value) { this.#sending$s.set(value); }
  /**
   * The files of the send in flight, and how many of their bytes have gone out — set once a remote
   * link reports it. They leave one after the other, in this order.
   */
  #upload$s = state<{ files: File[]; loaded: number } | null>(null);
	get upload(): { files: File[]; loaded: number } | null { return this.#upload$s.get(); }
	set upload(value: { files: File[]; loaded: number } | null) { this.#upload$s.set(value); }
  /** The Mac answered the last send, and the answer was no. The link is fine: the composer says why. */
  #sendRefused$s = state<"too_many_files" | "refused" | null>(null);
	get sendRefused(): "too_many_files" | "refused" | null { return this.#sendRefused$s.get(); }
	set sendRefused(value: "too_many_files" | "refused" | null) { this.#sendRefused$s.set(value); }
  /** The message just sent from here, until the turn it wakes is known and can be followed. */
  pendingFocusTrigger: string | null = null;
  /** Clears this conversation's highlight a few seconds after a jump. */
  highlightTimer: ReturnType<typeof setTimeout> | null = null;

  /** The first page is in flight: the stage waits rather than looking empty. */
  #historyLoading$s = state(false);
	get historyLoading() { return this.#historyLoading$s.get(); }
	set historyLoading(value) { this.#historyLoading$s.set(value); }
  /** A page further back is in flight, asked for by scrolling to the top of what is loaded. */
  #olderLoading$s = state(false);
	get olderLoading() { return this.#olderLoading$s.get(); }
	set olderLoading(value) { this.#olderLoading$s.set(value); }
  /** The cursor for the next page back, or null once the beginning is loaded. */
  #messageNext$s = state<string | null>(null);
	get messageNext(): string | null { return this.#messageNext$s.get(); }
	set messageNext(value: string | null) { this.#messageNext$s.set(value); }
  /** Whether the full history has been read, as opposed to the summary row the roster carries. */
  #detailLoaded$s = state(false);
	get detailLoaded() { return this.#detailLoaded$s.get(); }
	set detailLoaded(value) { this.#detailLoaded$s.set(value); }

  /**
   * The newest read for this conversation. An older page landing after a newer one started must
   * not win. Per conversation rather than one global counter, so loading a second conversation
   * no longer cancels the first one's read.
   */
  loadSeq = 0;
  /**
   * Bumped when the daemon says this conversation's history was cleared or the conversation went
   * away. A page fetched before that must not be written back on top of the emptied rows.
   */
  revision = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get hasOlderMessages(): boolean {
    return this.messageNext !== null;
  }

  /**
   * Back to the state a session has before anything is read for it. Used when the daemon says the
   * history was cleared, which empties the rows without the conversation being closed.
   */
  resetHistory(): void {
    this.messageNext = null;
    this.detailLoaded = false;
    this.historyLoading = false;
    this.olderLoading = false;
  }
}
