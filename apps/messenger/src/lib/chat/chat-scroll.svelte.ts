import { tick, untrack } from "svelte";
import type { SessionSummary } from "@real-bot/protocol";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import type { SessionView } from "../session-view.svelte.ts";
import { HISTORY_WINDOW_INITIAL, HISTORY_WINDOW_STEP, windowForIndex } from "./history-window.ts";
import { activeIndexMark, type IndexMark } from "./message-index.ts";
import { distanceFromBottom, isNearBottom, maxScrollTop, stickAfterScroll } from "./stream-scroll.ts";
import type { TranscriptItem } from "./transcript.ts";
import { deferWhileDragging } from "../workbench/pane-resize.svelte.ts";

/** What the transcript's scrolling reads from the stage around it; each is read when needed, so it stays live. */
export type ChatScrollDeps = {
  runtime: () => MessengerRuntime;
  selected: () => SessionSummary | null;
  view: () => SessionView | null;
  snapshot: () => MessengerRuntime["snapshot"];
  highlightedId: () => string | null;
  stream: () => TranscriptItem[];
  hiddenOlder: () => number;
  indexMarks: () => IndexMark[];
};

/**
 * Where the transcript is scrolled: stuck to the newest line or not, the jump to the bottom, the
 * jump to a message (a search hit or a tick of the index) and how much of the history is mounted.
 * The stage owns the effects that drive it, in the order it always ran them; their bodies are here.
 */
export class ChatScroll {
  private readonly deps: ChatScrollDeps;

  constructor(deps: ChatScrollDeps) {
    this.deps = deps;
  }

  /**
   * Only the tail of a long conversation is mounted; see history-window.ts for why. The window
   * grows when the person scrolls into it, and the runtime fetches another page once the window
   * has reached the oldest message it holds.
   */
  historyWindow = $state(HISTORY_WINDOW_INITIAL);

  activeIndexId = $state<string | null>(null);
  /** Held while a tick is being brought into view, so sticking to the bottom cannot undo the jump. */
  indexJumpSequence = 0;
  indexJumping = false;

  /**
   * Growing the window prepends content, and the browser keeps `scrollTop`, so the view would
   * slide down by whatever was added. Anchoring on the distance to the bottom keeps the message
   * the person was reading exactly where it was.
   */
  showEarlier = async (): Promise<void> => {
    const el = this.streamContainer;
    const anchor = el ? el.scrollHeight - el.scrollTop : null;
    this.stickToBottom = false;
    const view = this.deps.view();
    if (this.deps.hiddenOlder() > 0) this.historyWindow += HISTORY_WINDOW_STEP;
    else if (view?.hasOlderMessages) {
      await this.deps.runtime().loadOlderMessages(view.sessionId);
      this.historyWindow += HISTORY_WINDOW_STEP;
    }
    await tick();
    if (el && anchor !== null) {
      this.ignoreStreamScroll = true;
      el.scrollTop = el.scrollHeight - anchor;
    }
  };

  streamContainer = $state<HTMLElement | null>(null);

  streamInner = $state<HTMLElement | null>(null);

  showScrollBottom = $state(false);

  stickToBottom = $state(true);

  ignoreStreamScroll = false;

  jumpToBottom = false;

  jumpToBottomTimer: ReturnType<typeof setTimeout> | null = null;

  pinStreamToBottom = (): void => {
    const el = this.streamContainer;
    if (!el) return;
    this.ignoreStreamScroll = true;
    el.scrollTop = maxScrollTop(el.scrollHeight, el.clientHeight);
    this.showScrollBottom = false;
  };

  cancelJumpToBottom = (): void => {
    if (this.jumpToBottomTimer !== null) {
      clearTimeout(this.jumpToBottomTimer);
      this.jumpToBottomTimer = null;
    }
    this.jumpToBottom = false;
  };

  finishJumpToBottom = (): void => {
    this.cancelJumpToBottom();
    this.pinStreamToBottom();
  };

  /** The stage's effect for another conversation in it. */
  startOver = (): (() => void) => {
    void this.deps.selected()?.id;
    this.indexJumpSequence++;
    this.indexJumping = false;
    this.activeIndexId = null;
    this.cancelJumpToBottom();
    this.historyWindow = HISTORY_WINDOW_INITIAL;
    if (untrack(() => this.deps.highlightedId())) {
      this.stickToBottom = false;
      return () => this.cancelJumpToBottom();
    }
    this.stickToBottom = true;
    this.showScrollBottom = false;
    void tick().then(() => { if (this.stickToBottom) this.pinStreamToBottom(); });
    return () => this.cancelJumpToBottom();
  };

  /** The stage's effect for a highlighted message: mounted, then brought into view. */
  followHighlight = (): void => {
    const id = this.deps.highlightedId();
    const token = this.deps.view()?.searchHighlightToken ?? 0;
    if (!id) return;
    this.stickToBottom = false;
    void this.deps.snapshot().messages;
    void this.deps.selected()?.id;
    void token;
    const stream = this.deps.stream();
    const at = stream.findIndex((item) => item.type === "message" && item.message.id === id);
    this.historyWindow = windowForIndex(stream.length, at, untrack(() => this.historyWindow));
    void tick().then(() => {
      if (this.deps.highlightedId() !== id) return;
      this.scrollHighlightedMessage();
    });
  };

  /** The stage's effect for the list and its pane changing size. */
  followSize = (): (() => void) | undefined => {
    const outer = this.streamContainer;
    const inner = this.streamInner;
    if (!outer || !inner) return;
    void this.stickToBottom;
    const follow = () => {
      if (this.jumpToBottom || this.indexJumping) return;
      if (this.stickToBottom) this.pinStreamToBottom();
      else this.showScrollBottom = !isNearBottom(outer.scrollHeight, outer.scrollTop, outer.clientHeight);
      this.refreshActiveIndex();
    };
    // Measuring every mounted bubble on each size change is what makes a divider drag
    // stutter once several transcripts are on screen. One run when the pointer is released.
    const deferred = deferWhileDragging(follow);
    const ro = new ResizeObserver(deferred.run);
    ro.observe(inner);
    ro.observe(outer);
    window.addEventListener("resize", deferred.run);
    deferred.run();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", deferred.run);
      deferred.cancel();
    };
  };

  scrollHighlightedMessage = (): void => {
    const id = this.deps.highlightedId();
    const root = this.streamContainer;
    if (!id || !root) return;
    const el = root.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (!(el instanceof HTMLElement)) return;
    this.stickToBottom = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => {
      if (!this.streamContainer) return;
      this.showScrollBottom = !isNearBottom(
        this.streamContainer.scrollHeight,
        this.streamContainer.scrollTop,
        this.streamContainer.clientHeight
      );
    }, 320);
  };

  refreshActiveIndex = (): void => {
    const root = this.streamContainer;
    if (!root || this.indexJumping) return;
    const rootTop = root.getBoundingClientRect().top;
    const positions = new Map<string, number>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-message-id]")) {
      positions.set(el.dataset.messageId!, el.getBoundingClientRect().top - rootTop + root.scrollTop);
    }
    this.activeIndexId = activeIndexMark(this.deps.indexMarks(), positions, root.scrollTop,
      isNearBottom(root.scrollHeight, root.scrollTop, root.clientHeight));
  };

  jumpToIndexMark = async (mark: IndexMark): Promise<void> => {
    const sessionId = this.deps.selected()?.id;
    const sequence = ++this.indexJumpSequence;
    this.cancelJumpToBottom();
    this.stickToBottom = false;
    this.ignoreStreamScroll = false;
    this.indexJumping = true;
    const stream = this.deps.stream();
    const at = stream.findIndex((item) => item.type === "message" && item.message.id === mark.id);
    this.historyWindow = windowForIndex(stream.length, at, this.historyWindow);
    await tick();
    if (sequence !== this.indexJumpSequence || this.deps.selected()?.id !== sessionId) return;
    const root = this.streamContainer;
    const el = root?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(mark.id)}"]`);
    if (root && el) {
      const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 24;
      root.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      this.showScrollBottom = !isNearBottom(root.scrollHeight, root.scrollTop, root.clientHeight);
      this.activeIndexId = mark.id;
    }
    this.indexJumping = false;
  };

  onStreamScroll = (e: Event): void => {
    const el = e.currentTarget as HTMLElement;
    if (!el || this.indexJumping) return;
    this.refreshActiveIndex();
    const near = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    const next = stickAfterScroll(this.ignoreStreamScroll, near, this.jumpToBottom);
    this.ignoreStreamScroll = next.ignore;
    if (next.ignore) {
      if (this.jumpToBottom && distanceFromBottom(el.scrollHeight, el.scrollTop, el.clientHeight) <= 1) {
        this.finishJumpToBottom();
      }
      return;
    }
    this.showScrollBottom = !next.stick;
    this.stickToBottom = next.stick;
    // Already-fetched messages come back seamlessly; a page that needs the Mac waits for the
    // button, so scrolling never blocks on the network. Only for someone who has actually
    // scrolled up: a transcript shorter than its pane sits at the top and would otherwise
    // keep asking for more.
    if (this.deps.hiddenOlder() > 0 && !next.stick && el.scrollTop < 240) void this.showEarlier();
  };

  onStreamScrollEnd = (): void => {
    if (!this.jumpToBottom) return;
    this.finishJumpToBottom();
  };

  scrollToBottom = (smooth = true): void => {
    if (!this.streamContainer) return;
    this.stickToBottom = true;
    this.showScrollBottom = false;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!smooth || reduceMotion) {
      this.finishJumpToBottom();
      return;
    }
    this.jumpToBottom = true;
    this.ignoreStreamScroll = true;
    const el = this.streamContainer;
    el.scrollTo({
      top: maxScrollTop(el.scrollHeight, el.clientHeight),
      behavior: "smooth"
    });
    if (this.jumpToBottomTimer !== null) clearTimeout(this.jumpToBottomTimer);
    this.jumpToBottomTimer = setTimeout(() => {
      this.jumpToBottomTimer = null;
      this.finishJumpToBottom();
    }, 800);
  };
}
