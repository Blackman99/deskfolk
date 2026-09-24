import { expect, test } from "bun:test";
import type { Annotation, Message, Turn } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aMessage, anAttachment, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { click } from "../test-render.ts";
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

test("a Bot-to-Bot chat offers Continue on an interruption and on a failed turn", () => {
  const session = aBotDirect();
  const messages = [
    aMessage({
      id: "cut", session_id: session.id, kind: "system", author: "bot-1",
      body: "中断", turn_id: "turn-cut", created_at: "2026-09-19T02:00:01.000Z",
    }),
    aMessage({
      id: "fail", session_id: session.id, kind: "system", author: "bot-2",
      body: "这一轮没写完：运行时出错", turn_id: "turn-fail", created_at: "2026-09-19T02:00:02.000Z",
    }),
  ];
  const runtime = reactive(fakeRuntime({
    bots: [aBot(), aBot({ id: "bot-2", name: "审片员" })],
    sessions: [session],
    messages,
    turns: [
      aTurn({ id: "turn-cut", session_id: session.id, bot_id: "bot-1", status: "interrupted" }),
      aTurn({ id: "turn-fail", session_id: session.id, bot_id: "bot-2", status: "completed" }),
    ],
  }, { selectedId: session.id }));
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".btn-continue-turn")];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(buttons[0]?.getAttribute("title")).toBe(t.stream.continueInterruptHint);
    expect(buttons[1]?.getAttribute("title")).toBe(t.stream.continueFailedHint);
    click(buttons[1]);
    expect(runtime.calls.some((call) => call.name === "continueInterrupt" && call.args[0] === "fail")).toBe(true);
  } finally {
    close();
  }
});

test("a direct chat you can type in still continues a failed turn, and an archived one does not", () => {
  const session = aDirect();
  const runtime = reactive(fakeRuntime({
    bots: [aBot()],
    sessions: [session],
    messages: [aMessage({
      id: "fail", session_id: session.id, kind: "system", author: "bot-1",
      body: "这一轮没写完：端点拒绝了这次补全", turn_id: "turn-fail",
    })],
    turns: [aTurn({ id: "turn-fail", session_id: session.id, status: "completed" })],
  }, { selectedId: session.id }));
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    expect(host.querySelector(".btn-continue-turn")).not.toBeNull();
  } finally {
    close();
  }
  const archived = reactive(fakeRuntime({
    bots: [aBot()],
    sessions: [{ ...session, archived_at: "2026-09-19T03:00:00.000Z" }],
    messages: [aMessage({
      id: "fail-2", session_id: session.id, kind: "system", author: "bot-1",
      body: "中断", turn_id: "turn-cut",
    })],
    turns: [aTurn({ id: "turn-cut", session_id: session.id, status: "interrupted" })],
  }, { selectedId: session.id }));
  const second = render(ChatStage, {
    runtime: archived, t, selected: { ...session, archived_at: "2026-09-19T03:00:00.000Z" },
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    expect(second.host.querySelector(".btn-continue-turn")).toBeNull();
  } finally {
    second.close();
  }
});

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

  // A rendered picture keeps this menu closed so its own menu can copy the pixels.
  const image = document.createElement("img");
  image.dataset.copyImage = "";
  Object.defineProperty(image, "currentSrc", { configurable: true, get: () => "blob:http://localhost/shot" });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 8 });
  botSegment.append(image);
  const onPicture = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  image.dispatchEvent(onPicture);
  flushSync();
  expect(onPicture.defaultPrevented).toBe(false);
  expect(onPicture.cancelBubble).toBe(false);
  expect(host.querySelector(".msg-context-menu")).toBeNull();
  expect(botSegment.classList.contains("is-selected")).toBe(false);
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
  image.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);

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

test("a slow picture waits in its thumbnail's box, with the bytes received shown, and grows once", async () => {
  let report: ((progress: { loaded: number; total: number | null }) => void) | undefined;
  let resolveBlob!: (blob: Blob) => void;
  const pending = new Promise<Blob>((resolve) => {
    resolveBlob = resolve;
  });
  const session = aDirect();
  const picture = anAttachment({
    id: "pic",
    message_id: "msg-pic",
    original_filename: "image.png",
    workspace_relpath: "inbox/image-3.png",
    mime: "image/png",
    size: 4096,
  });
  const message = aMessage({
    id: "msg-pic",
    session_id: session.id,
    kind: "user",
    body: "选哪个",
    attachments: [picture],
  });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session], messages: [message], turns: [],
  }, {
    selectedId: session.id,
    client: {
      getAttachmentBlob: (_id: string, onProgress?: (progress: { loaded: number; total: number | null }) => void) => {
        report = onProgress;
        return pending;
      },
    },
  }));
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: () => {},
    onCreateBot: () => {},
  });
  try {
    const chip = host.querySelector(".attachment-file-btn")!;
    const thumb = chip.querySelector(".attachment-chip-pending")!;
    thumb.getBoundingClientRect = () =>
      ({ top: 40, left: 80, width: 36, height: 36, right: 116, bottom: 76, x: 80, y: 40, toJSON() {} }) as DOMRect;
    click(chip);
    const frame = host.querySelector<HTMLElement>(".msg-image-frame");
    expect(frame).not.toBeNull();
    // The first paint keeps the thumbnail's box; the spinner is already inside it.
    expect(frame!.style.top).toBe("40px");
    expect(frame!.style.left).toBe("80px");
    expect(frame!.style.width).toBe("36px");
    expect(frame!.style.height).toBe("36px");
    expect(frame!.querySelector(".msg-image-loading-ring")).not.toBeNull();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    flushSync();
    // No pixels yet, so no shape to grow to: the frame stays in the thumbnail's box instead of
    // growing to a guessed one and resizing again when the picture comes.
    expect(frame!.style.width).toBe("36px");
    expect(frame!.style.height).toBe("36px");
    expect(host.querySelector(".msg-image-waiting")?.textContent).toContain("正在打开文件…");
    const loading = frame!.querySelector(".msg-image-loading");
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(loading?.textContent).toContain("正在打开文件…");
    expect(frame!.querySelector(".msg-image-loading-ring")).not.toBeNull();
    expect(frame!.querySelector(".msg-image-full")).toBeNull();
    const bar = frame!.querySelector(".msg-image-loading-bar");
    expect(bar?.getAttribute("aria-valuenow")).toBe("0");
    expect(frame!.textContent).toContain("0 B / 4.0 KB");
    report?.({ loaded: 2048, total: 4096 });
    flushSync();
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
    expect(frame!.querySelector<HTMLElement>(".msg-image-loading-fill")?.style.width).toBe("50%");
    expect(frame!.textContent).toContain("2.0 KB / 4.0 KB");
    expect(host.querySelector(".msg-image-waiting")?.textContent).toContain("2.0 KB / 4.0 KB");
    resolveBlob(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(host.querySelector(".msg-image-loading")).toBeNull();
    expect(host.querySelector(".msg-image-waiting")).toBeNull();
    expect(host.querySelector(".msg-image-full")).not.toBeNull();
  } finally {
    close();
  }
});

test("clicking a picture attachment opens it over the messages", () => {
  const session = aDirect();
  const picture = anAttachment({
    id: "pic",
    message_id: "msg-pic",
    original_filename: "image.png",
    workspace_relpath: "inbox/image-3.png",
    mime: "image/png",
  });
  const message = aMessage({
    id: "msg-pic",
    session_id: session.id,
    kind: "user",
    body: "选哪个",
    attachments: [picture],
  });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session], messages: [message], turns: [],
  }, {
    selectedId: session.id,
    client: {
      getAttachmentBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      getWorkspaceFileBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    },
  }));
  const opened: string[] = [];
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: (path: string) => opened.push(path),
    onCreateBot: () => {},
  });
  try {
    click(host.querySelector(".attachment-file-btn"));
    const stage = host.querySelector(".msg-image-lightbox");
    expect(stage).not.toBeNull();
    expect(getComputedStyle(stage!).position).toBe("fixed");
    expect(stage?.getAttribute("role")).not.toBe("dialog");
    expect(host.querySelector(".msg-image-frame")?.getAttribute("aria-label")).toBe("image.png");
    expect(opened).toEqual([]);
    click(host.querySelector(".msg-image-close"));
    expect(host.querySelector(".msg-image-lightbox")).toBeNull();
  } finally {
    close();
  }
});

test("a markdown image link opens over the messages and a text link still opens the preview", () => {
  const session = aDirect();
  const message = aMessage({
    id: "msg-links",
    session_id: session.id,
    kind: "bot",
    author: "bot-1",
    body: "看 [shot.png](inbox/shot.png) 和 [notes.md](inbox/notes.md)",
  });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session], messages: [message], turns: [],
  }, { selectedId: session.id }));
  const opened: string[] = [];
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: (path: string) => opened.push(path),
    onCreateBot: () => {},
  });
  try {
    const links = [...host.querySelectorAll("a")];
    click(links.find((link) => link.textContent?.includes("shot.png")));
    expect(host.querySelector(".msg-image-lightbox")).not.toBeNull();
    expect(opened).toEqual([]);
    click(links.find((link) => link.textContent?.includes("notes.md")));
    expect(opened).toEqual(["inbox/notes.md"]);
  } finally {
    close();
  }
});

for (const session of [aDirect(), aGroup(), aBotDirect()]) {
  test(`${session.kind} keeps a complete attachment entry without repeating its inventory`, () => {
    const paths = ["work/check/a.txt", "work/check/b.txt"];
    const body = "检查继续。查看 [重点](work/check/a.txt)。\n\n" + paths.map(path => `[${path}](${path})`).join("\n");
    const message = aMessage({ id: "inventory", session_id: session.id, kind: "bot", author: "bot-1", body,
      attachments: paths.map((path, index) => anAttachment({ id: `att-${index}`, message_id: "inventory", workspace_relpath: path, original_filename: path.split("/").pop()! })),
    });
    const runtime = reactive(fakeRuntime({ bots: [aBot()], sessions: [session], messages: [message], turns: [] }, { selectedId: session.id }));
    let opened = "";
    const { host, close } = render(ChatStage, { runtime, t, selected: session,
      onOpenProfile: () => {}, onCreateBot: () => {},
      onOpenArtifact: (path: string) => { opened = path; },
    });
    try {
      const segment = host.querySelector('[data-message-id="inventory"]')!;
      expect(segment.querySelectorAll(".md-artifact-link").length).toBe(1);
      expect(segment.textContent).toContain("检查继续");
      const bundle = segment.querySelector<HTMLButtonElement>(".attachment-bundle-btn")!;
      expect(bundle.textContent).toContain("2 个文件");
      expect(bundle.title.split("\n")).toEqual(paths);
      bundle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(opened).toBe(paths[0]!);
      expect(message.body).toBe(body);
    } finally { close(); }
  });
}

/**
 * A continuable row (中断 unless `body` says otherwise) that was continued says what the continuing
 * came to, in place of 继续.
 */
function renderInterrupt(over: {
  body?: string;
  source_turn_id?: string | null;
  messages?: Message[];
  turns?: Turn[];
}) {
  const session = aGroup({ id: "sess-1" });
  const cut = aMessage({
    id: "cut-1",
    session_id: "sess-1",
    kind: "system",
    author: "bot-1",
    body: over.body ?? "中断",
    turn_id: "turn-cut",
    source_turn_id: over.source_turn_id ?? null,
    created_at: "2026-09-19T02:00:00.000Z",
  });
  const runtime = reactive(
    fakeRuntime(
      {
        bots: [aBot({ id: "bot-1", name: "甲" })],
        sessions: [session],
        messages: [cut, ...(over.messages ?? [])],
        turns: over.turns ?? [],
      },
      { selectedId: "sess-1" },
    ),
  );
  const view = render(ChatStage, {
    runtime,
    t,
    selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: () => {},
    onCreateBot: () => {},
  });
  const row = view.host.querySelector('[data-message-id="cut-1"] .msg.is-system') as HTMLElement;
  return { ...view, runtime, row };
}

const followUpMessage = (over: Partial<Message> = {}) =>
  aMessage({
    id: "said-1",
    session_id: "sess-1",
    kind: "bot",
    author: "bot-1",
    body: "接着把剩下的发了。",
    turn_id: "turn-next",
    created_at: "2026-09-19T02:01:00.000Z",
    ...over,
  });

test("a 中断 row nobody continued yet offers 继续", () => {
  const { row, close } = renderInterrupt({});
  expect(row.querySelector(".btn-continue-turn")?.textContent?.trim()).toBe(t.stream.continueInterrupt);
  expect(row.querySelector(".interrupt-follow-up")).toBeNull();
  close();
});

test("while the follow-up runs, the 中断 row reads 继续中 instead of 继续", () => {
  const { row, close } = renderInterrupt({
    source_turn_id: "turn-next",
    turns: [aTurn({ id: "turn-next", trigger_message_id: "cut-1" })],
  });
  expect(row.querySelector(".btn-continue-turn")).toBeNull();
  expect(row.querySelector(".interrupt-follow-up")?.textContent?.trim()).toBe(
    t.stream.continueInterruptLive,
  );
  close();
});

test("a follow-up that left a message reads 已继续 and jumps to it", () => {
  const { row, runtime, close } = renderInterrupt({
    source_turn_id: "turn-next",
    messages: [followUpMessage()],
  });
  const status = row.querySelector("button.interrupt-follow-up") as HTMLButtonElement;
  expect(status.textContent?.trim()).toBe(t.stream.continueInterruptDone);
  expect(status.title).toBe(t.stream.continueInterruptJump);
  status.click();
  flushSync();
  expect(runtime.calls.filter((call) => call.name === "selectSession").map((call) => call.args)).toEqual([
    ["sess-1", { messageId: "said-1" }],
  ]);
  close();
});

test("a follow-up that failed again says so beside the 中断 row", () => {
  const { row, close } = renderInterrupt({
    source_turn_id: "turn-next",
    messages: [followUpMessage({ kind: "system", body: "这一轮没写完：端点出错" })],
  });
  expect(row.querySelector(".interrupt-follow-up")?.textContent?.trim()).toBe(
    t.stream.continueInterruptFailed,
  );
  close();
});

test("a follow-up seen to end without a message reads 已继续，没有发消息", () => {
  const { row, close } = renderInterrupt({
    source_turn_id: "turn-next",
    turns: [aTurn({ id: "turn-next", trigger_message_id: "cut-1", status: "completed" })],
  });
  expect(row.querySelector(".btn-continue-turn")).toBeNull();
  const status = row.querySelector(".interrupt-follow-up") as HTMLElement;
  expect(status.tagName).toBe("SPAN");
  expect(status.textContent?.trim()).toBe(t.stream.continueInterruptNothing);
  close();
});

test("a follow-up stopped before it left anything reads 已继续，中途停下", () => {
  const { row, close } = renderInterrupt({
    source_turn_id: "turn-next",
    turns: [aTurn({ id: "turn-next", trigger_message_id: "cut-1", status: "stopped" })],
  });
  expect(row.querySelector(".interrupt-follow-up")?.textContent?.trim()).toBe(t.stream.continueInterruptStopped);
  close();
});

test("after a reload, a follow-up with nothing in view reads just 已继续, not clickable", () => {
  const { row, close } = renderInterrupt({ source_turn_id: "turn-next" });
  const status = row.querySelector(".interrupt-follow-up") as HTMLElement;
  expect(status.tagName).toBe("SPAN");
  expect(status.textContent?.trim()).toBe(t.stream.continueInterruptDone);
  close();
});

test("a continued 这一轮没写完 row shows its follow-up the same way", () => {
  const { row, close } = renderInterrupt({
    body: "这一轮没写完：连不上端点",
    source_turn_id: "turn-next",
    turns: [aTurn({ id: "turn-next", trigger_message_id: "cut-1" })],
  });
  expect(row.querySelector(".btn-continue-turn")).toBeNull();
  expect(row.querySelector(".interrupt-follow-up")?.textContent?.trim()).toBe(
    t.stream.continueInterruptLive,
  );
  close();
});
