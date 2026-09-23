import { expect, test } from "bun:test";
import type { Annotation } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aMessage, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const t = copyFor("zh");

for (const [label, session, showAvatars] of [
  ["user-Bot direct", aDirect(), false],
  ["group", aGroup(), true],
  ["Bot-Bot direct", aBotDirect(), true],
] as const) {
  test(`${label} uses the correct avatars for messages and streaming replies`, () => {
    const messages = (["user", "bot", "ask", "system"] as const).map((kind, index) => aMessage({
      id: `avatar-${kind}`, session_id: session.id, kind,
      author: kind === "user" ? "user" : "bot-1",
      body: kind === "system" ? "中断" : `${kind} message`,
      created_at: `2026-09-19T02:00:0${index}.000Z`,
    }));
    const runtime = reactive(fakeRuntime({
      bots: [aBot()], sessions: [session], messages,
      turns: [aTurn({ session_id: session.id, partial_text: "Streaming reply", created_at: "2026-09-19T02:00:05.000Z" })],
    }, { selectedId: session.id }));
    let openedProfile = "";
    const { host, close } = render(ChatStage, {
      runtime, t, selected: session,
      onOpenProfile: (id: string) => { openedProfile = id; },
      onOpenArtifact: () => {}, onCreateBot: () => {},
    });
    try {
      for (const message of messages) {
        const row = host.querySelector(`[data-message-id="${message.id}"]`)?.closest(".msg-wrap");
        expect(row).not.toBeNull();
        expect(Boolean(row?.querySelector(".avatar-col"))).toBe(showAvatars);
        expect(row?.textContent).toContain(message.body);
      }
      const streamingRow = host.querySelector(".is-streaming-wrap");
      expect(streamingRow).not.toBeNull();
      expect(Boolean(streamingRow?.querySelector(".avatar-col"))).toBe(showAvatars);
      expect(streamingRow?.textContent).toContain("Streaming reply");
      host.querySelector<HTMLButtonElement>(".is-bot .sender-name")?.click();
      expect(openedProfile).toBe("bot-1");
    } finally {
      close();
    }
  });
}

test("empty direct chat keeps its welcome avatar and profile entry", () => {
  const session = aDirect();
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session], messages: [], turns: [],
  }, { selectedId: session.id }));
  let openedProfile = "";
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: (id: string) => { openedProfile = id; },
    onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    expect(host.querySelector(".welcome-avatar")).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".welcome-identity-btn")?.click();
    expect(openedProfile).toBe("bot-1");
  } finally {
    close();
  }
});

for (const kind of ["user", "bot", "ask", "system"] as const) {
  test(`${kind} message prevents secondary-click selection and preserves manual selection`, () => {
    const session = aGroup({ id: "sess-1" });
    const message = aMessage({
      id: "selection-message", session_id: session.id, kind,
      author: kind === "user" ? "user" : "bot-1", body: "Hello selected text",
    });
    const runtime = reactive(fakeRuntime({
      bots: [aBot({ id: "bot-1" })], sessions: [session], messages: [message], turns: [],
    }, { selectedId: session.id }));
    const { host, close } = render(ChatStage, {
      runtime, t, selected: session,
      onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
    });
    try {
      const segment = host.querySelector('[data-message-id="selection-message"]')!;
      const body = segment.querySelector(".body, .md-body")!;
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedText = selection.toString();
      expect(selectedText).toContain(message.body);
      for (const init of [{ button: 2 }, { button: 0, ctrlKey: true }]) {
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
        body.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        expect(selection.toString()).toBe(selectedText);
      }
      for (const init of [{ button: 0 }, { button: 0, shiftKey: true }, { button: 1 }]) {
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
        body.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(false);
      }
      body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      flushSync();
      expect(host.querySelector(".msg-context-menu")).not.toBeNull();
      expect(selection.toString()).toBe(selectedText);
    } finally {
      window.getSelection()?.removeAllRanges();
      close();
    }
  });

  test(`${kind} message does not select text on mobile long press and clears any accidental selection`, () => {
    const session = aGroup({ id: "sess-1" });
    const message = aMessage({
      id: `mobile-selection-${kind}`, session_id: session.id, kind,
      author: kind === "user" ? "user" : "bot-1", body: "Hello mobile long press message",
    });
    const runtime = reactive(fakeRuntime({
      bots: [aBot({ id: "bot-1" })], sessions: [session], messages: [message], turns: [],
    }, { selectedId: session.id }));
    const { host, close } = render(ChatStage, {
      runtime, t, selected: session,
      onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
    });
    let written = "";
    const origClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written = text;
        },
      },
    });

    try {
      const segment = host.querySelector(`[data-message-id="mobile-selection-${kind}"]`)!;
      const body = segment.querySelector(".body, .md-body")!;
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString()).toContain(message.body);

      // Simulate mobile touchstart before contextmenu (long press)
      segment.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
      segment.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      flushSync();

      expect(selection.toString()).toBe("");
      expect(host.querySelector(".msg-context-menu")).not.toBeNull();

      // Find the copy button in the context menu
      const copyBtn = Array.from(host.querySelectorAll<HTMLButtonElement>(".msg-context-menu-item"))
        .find((btn) => btn.textContent?.includes(t.chat.copyMessage));
      expect(copyBtn).toBeDefined();
      copyBtn?.click();
      flushSync();

      // Should copy the full message body, not the accidental selection
      expect(written).toBe(message.body);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: origClipboard });
      window.getSelection()?.removeAllRanges();
      close();
    }
  });

  test(`${kind} message does not select text on mobile viewport (max-width: 680px) and coarse pointer`, () => {
    const origMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 680px)" || query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;

    const session = aGroup({ id: "sess-2" });
    const message = aMessage({
      id: `mobile-media-${kind}`, session_id: session.id, kind,
      author: kind === "user" ? "user" : "bot-1", body: "Hello mobile media query message",
    });
    const runtime = reactive(fakeRuntime({
      bots: [aBot({ id: "bot-1" })], sessions: [session], messages: [message], turns: [],
    }, { selectedId: session.id }));
    const { host, close } = render(ChatStage, {
      runtime, t, selected: session,
      onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
    });

    try {
      const segment = host.querySelector(`[data-message-id="mobile-media-${kind}"]`)!;
      const body = segment.querySelector(".body, .md-body")!;
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString()).toContain(message.body);

      // Contextmenu on mobile screen
      segment.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      flushSync();

      expect(selection.toString()).toBe("");
      expect(host.querySelector(".msg-context-menu")).not.toBeNull();
    } finally {
      window.matchMedia = origMatchMedia;
      window.getSelection()?.removeAllRanges();
      close();
    }
  });
}

test("left clicking a message does not add is-selected class, right clicking selects it", async () => {
  const bot = aBot({ id: "bot-1", name: "Alpha" });
  const session = aGroup({ id: "sess-1" });
  const userMsg = aMessage({
    id: "msg-user-1",
    session_id: "sess-1",
    kind: "user",
    body: "Hello bot",
  });
  const botMsg = aMessage({
    id: "msg-bot-1",
    session_id: "sess-1",
    kind: "bot",
    author: "bot-1",
    body: "Hello user",
  });

  const runtime = reactive(
    fakeRuntime(
      {
        bots: [bot],
        sessions: [session],
        messages: [userMsg, botMsg],
        turns: [],
      },
      { selectedId: "sess-1" },
    ),
  );

  const { host, close } = render(ChatStage, {
    runtime,
    t,
    selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: () => {},
    onCreateBot: () => {},
  });

  const userSegment = host.querySelector('[data-message-id="msg-user-1"]') as HTMLElement;
  const botSegment = host.querySelector('[data-message-id="msg-bot-1"]') as HTMLElement;
  expect(userSegment).not.toBeNull();
  expect(botSegment).not.toBeNull();

  // Left click on user message does not select
  userSegment.click();
  flushSync();
  expect(userSegment.classList.contains("is-selected")).toBe(false);

  // Left click on bot message does not select
  botSegment.click();
  flushSync();
  expect(botSegment.classList.contains("is-selected")).toBe(false);

  // Check dimensions before selection
  const beforePadding = window.getComputedStyle(botSegment).padding;
  const beforeMargin = window.getComputedStyle(botSegment).margin;

  // Right click on bot message should select it and open context menu
  botSegment.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  flushSync();
  expect(botSegment.classList.contains("is-selected")).toBe(true);
  expect(host.querySelector(".msg-context-menu")).not.toBeNull();

  // Padding and margin must not change when selected (no shaking / layout shift)
  const afterPadding = window.getComputedStyle(botSegment).padding;
  const afterMargin = window.getComputedStyle(botSegment).margin;
  expect(afterPadding).toBe(beforePadding);
  expect(afterMargin).toBe(beforeMargin);

  // Wait for context menu event listeners to attach
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Context menu must remain open after attaching listeners (no flickering/auto-dismiss)
  expect(host.querySelector(".msg-context-menu")).not.toBeNull();
  expect(botSegment.classList.contains("is-selected")).toBe(true);

  // Press Escape to close context menu and deselect
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(botSegment.classList.contains("is-selected")).toBe(false);
  expect(host.querySelector(".msg-context-menu")).toBeNull();

  close();
});

function annotationRow(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "src/pick.ts",
    anchor_kind: "text_range",
    anchor: { start_line: 1, start_col: 1, end_line: 1, end_col: 5, quote: "const", prefix: "", suffix: "" },
    content_sha256: "0".repeat(64),
    target_message_id: "delivery-d",
    target_session_id: "direct-1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "direct-1",
    message_id: "batch-1",
    body: "换个名字",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

test("a routed batch links back to the session of the delivery it quotes, not its oldest row's", () => {
  // Your direct with Writer holds one draft on Writer's delivery here and a newer one on Writer's
  // delivery in the Writer ↔ Critic direct; the daemon quoted the newer one.
  const direct = aDirect({ id: "direct-1" });
  const botDirect = aBotDirect({ id: "botbot-1" });
  const bots = [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Critic" })];
  const messages = [
    aMessage({ id: "delivery-d", session_id: direct.id, kind: "bot", author: "bot-1", body: "写好了", created_at: "2026-09-23T00:00:00.000Z" }),
    aMessage({ id: "batch-1", session_id: direct.id, body: "两处请改", annotation_source_message_id: "delivery-b", created_at: "2026-09-23T00:01:00.000Z" }),
    // Quotes a delivery that the snapshot holds but no row of the batch sits on.
    aMessage({ id: "batch-2", session_id: direct.id, body: "再看一下", annotation_source_message_id: "delivery-b2", created_at: "2026-09-23T00:02:00.000Z" }),
    aMessage({ id: "delivery-b2", session_id: botDirect.id, kind: "bot", author: "bot-1", body: "又改了", created_at: "2026-09-23T00:00:30.000Z" }),
    // Quotes a delivery nothing here can place.
    aMessage({ id: "batch-3", session_id: direct.id, body: "还有这个", annotation_source_message_id: "delivery-gone", created_at: "2026-09-23T00:03:00.000Z" }),
  ];
  const annotations = [
    annotationRow({ id: "old-here", created_at: "2026-09-23T00:00:10.000Z" }),
    annotationRow({ id: "new-there", target_message_id: "delivery-b", target_session_id: botDirect.id, created_at: "2026-09-23T00:00:20.000Z" }),
    annotationRow({ id: "here-2", message_id: "batch-2" }),
    annotationRow({ id: "here-3", message_id: "batch-3" }),
  ];
  const opened: unknown[][] = [];
  const runtime = reactive(fakeRuntime({ bots, sessions: [direct, botDirect], messages, turns: [], annotations }, {
    selectedId: direct.id,
    selectSession: (...args: unknown[]) => { opened.push(args); return Promise.resolve(); },
  }));
  const { host, close } = render(ChatStage, {
    runtime, t, selected: direct,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  const sourceOf = (id: string) =>
    host.querySelector(`[data-message-id="${id}"]`)?.querySelector<HTMLButtonElement>(".annot-source") ?? null;
  try {
    const mixed = sourceOf("batch-1");
    expect(mixed?.textContent).toBe(t.chat.annotationSource("Writer ↔ Critic"));
    mixed!.click();
    expect(opened).toEqual([["botbot-1", { messageId: "delivery-b" }]]);

    const fromMessage = sourceOf("batch-2");
    expect(fromMessage?.textContent).toBe(t.chat.annotationSource("Writer ↔ Critic"));
    fromMessage!.click();
    expect(opened.at(-1)).toEqual(["botbot-1", { messageId: "delivery-b2" }]);

    expect(host.querySelector('[data-message-id="batch-3"]')).not.toBeNull();
    expect(sourceOf("batch-3")).toBeNull();
  } finally {
    close();
  }
});
