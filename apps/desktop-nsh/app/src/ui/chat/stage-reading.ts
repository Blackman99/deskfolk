/**
 * The conversation's last line counts as read once the window has shown it for a moment
 * (ChatStage's and ProjectChat's reading effect). The Svelte read `document.hasFocus()` and
 * `visibilityState`; NSH tells the app how it is in use: `active` is a focused window, `inactive`
 * a visible one without the focus, `background` a hidden or minimized one.
 *
 * `report`: a window gaining or losing the focus tells the shell where the reader is
 * (`runtime.reportDesktopNotificationView`), as ChatStage does.
 */
import { cleanup, effect, lifecycle, untracked } from "nsh";
import { desktopReadingMode, transcriptReadingReady, TRANSCRIPT_VISIBLE_MS } from "../../m/notifications/reading.ts";
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
    if (!opts.report || !runtime.isDesktopShell) return;
    untracked(() => {
      if (state === "active") void runtime.pollDesktopNativeState();
      void runtime.reportDesktopNotificationView(state === "active" && opts.atLatest());
    });
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
    const nativeFacts = runtime.isDesktopShell ? runtime.nativeFocusFacts : null;
    if (!transcriptReadingReady(facts, mode, nativeFacts) || !atLatest) return;
    timer = setTimeout(() => {
      timer = null;
      if (lifecycle() === "active" && untracked(() => opts.sessionId()) === id) void runtime.submitBoundedRead(id, last, noticeMark);
    }, TRANSCRIPT_VISIBLE_MS);
    return clear;
  });
}
