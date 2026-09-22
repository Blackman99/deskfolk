import type { ComposerSuggestion } from "@real-bot/protocol";

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
 * forwarding to whichever view is active, so nothing outside had to change when this appeared.
 */
export class SessionView {
  readonly sessionId: string;

  /** What you have typed here but not sent. */
  draft = $state("");
  /** The message a reply is aimed at, or null for an ordinary send. */
  replyingToId = $state<string | null>(null);
  /** The turn the transcript is following, set when you send and when a Bot wakes for you. */
  focusedTurnId = $state<string | null>(null);
  /** Flashed after a jump — a search hit, a trace node, a notification. */
  highlightedMessageId = $state<string | null>(null);
  /** Bumped so a repeat jump to the same message flashes again. */
  searchHighlightToken = $state(0);
  /** Drafted next steps offered above the composer; empty when none apply or the call failed. */
  composerSuggestions = $state<ComposerSuggestion[]>([]);

  /** The first page is in flight: the stage waits rather than looking empty. */
  historyLoading = $state(false);
  /** A page further back is in flight, asked for by scrolling to the top of what is loaded. */
  olderLoading = $state(false);
  /** The cursor for the next page back, or null once the beginning is loaded. */
  messageNext = $state<string | null>(null);
  /** Whether the full history has been read, as opposed to the summary row the roster carries. */
  detailLoaded = $state(false);

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
