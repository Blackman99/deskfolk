import { expect, test } from "bun:test";
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
