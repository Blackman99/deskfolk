/**
 * The conversation's last line counts as read once the window has shown it for a moment
 * (ChatStage's and ProjectChat's reading effect). The Svelte read `document.hasFocus()` and
 * `visibilityState`; NSH tells the app how it is in use: `active` is a focused window, `inactive`
 * a visible one without the focus, `background` a hidden or minimized one.
 *
 * `report`: the pane tells the runtime where the reader is (`runtime.noteConversationView`), so no
 * banner comes for the conversation you are looking at, as ChatStage does.
 */
import { cleanup, effect, untracked } from "nsh";
import { desktopReadingMode, transcriptReadingReady, TRANSCRIPT_VISIBLE_MS } from "../../m/notifications/reading.ts";
import { lifecycle } from "../../platform/lifecycle";
import { runtime } from "../../runtime";

export function trackReading(opts: {
  sessionId: () => string | null;
  lastMessageId: () => string | null;
  /** The reader is at the newest line. */
  atLatest: () => boolean;
  report?: boolean;
}): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  cleanup(clear);

  // The window gained or lost the focus, or went out of sight.
  let first = true;
  effect(() => {
    const state = lifecycle();
    if (first) {
      first = false;
      return;
    }
    if (state !== "active") clear();
    if (!opts.report || !runtime.isDesktopShell || state !== "active") return;
    untracked(() => void runtime.pollDesktopNativeState());
  });

  // Where the reader is, for the runtime to hold back a banner for the conversation in front of
  // you: told as the window gains or loses the focus, the reader reaches or leaves the newest line,
  // or another conversation is picked. Only the selected conversation's pane tells it, since the
  // report names the selected conversation; the five-second beat repeats what it last said.
  effect(() => {
    if (!opts.report) return;
    const id = opts.sessionId();
    const state = lifecycle();
    const atLatest = opts.atLatest();
    if (!id || id !== runtime.selectedId) return;
    untracked(() => runtime.noteConversationView(id, state === "active" && atLatest));
  });

  effect(() => {
    // Each visible pane times its own read, whichever of them has the keyboard.
    const id = opts.sessionId();
    const last = opts.lastMessageId();
    // A note the conversation does not list has a notification and no line: its arrival is
    // what lets the read of the last line go once more, and read it.
    const noticeMark = id ? runtime.noticeMark(id) : 0;
    const state = lifecycle();
    const atLatest = opts.atLatest();
    clear();
    if (!id || !last) return;
    const facts = {
      visibility: state === "background" ? ("hidden" as const) : ("visible" as const),
      hasFocus: state === "active",
      connected: runtime.connection === "connected",
      snapshotReady: true,
      overlayBlocksTranscript: runtime.settingsOpen || runtime.workspaceOpen,
    };
    const mode = desktopReadingMode(runtime.isDesktopShell, runtime.nativeCapabilities);
    // Not `runtime.nativeFocusFacts`: the messenger asks the shell whether its window is key because
    // the page's `document.hasFocus()` can say yes to a window that is not. Here `lifecycle()` is
    // the shell's own word, and the facts only move when a report reaches the shell: before
    // reports read `lifecycle()` they never did, the facts stayed at "nothing visible, nothing
    // focused" and, read as a gate, kept every conversation unread. They lag the window by a report.
    if (!transcriptReadingReady(facts, mode, null) || !atLatest) return;
    timer = setTimeout(() => {
      timer = null;
      if (lifecycle() === "active" && untracked(() => opts.sessionId()) === id) void runtime.submitBoundedRead(id, last, noticeMark);
    }, TRANSCRIPT_VISIBLE_MS);
    return clear;
  });
}
