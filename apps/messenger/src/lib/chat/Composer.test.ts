import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, USER_MEMBER } from "@real-bot/protocol";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, render } from "../test-render.ts";
import { pressWorkspacePaths, type WorkspaceDragItem } from "../workspace-drag.svelte.ts";
import Composer from "./Composer.svelte";

const t = copyFor("zh");

function open(draft = "写点什么", remote = false) {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  runtime.draft = draft;
  runtime.remote = remote;
  const sent: File[][] = [];
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async (files: File[]) => {
      sent.push(files);
      runtime.draft = "";
      return true;
    },
    onPickPrompt: (prompt: string) => { runtime.draft = prompt; },
  });
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  return { ...view, runtime, editor, sent };
}

test("single-line text is vertically centered within the action button height", () => {
  const viewport = (window as unknown as {
    happyDOM: { setViewport: (size: { width: number; height: number }) => void };
  }).happyDOM;
  const original = { width: window.innerWidth, height: window.innerHeight };
  try {
    for (const width of [320, 390, 680, 1180]) {
      viewport.setViewport({ width, height: 844 });
      for (const draft of ["", "中文输入 test"]) {
        const { host, editor, close } = open(draft);
        try {
          const input = getComputedStyle(editor);
          const button = getComputedStyle(host.querySelector(".composer-action")!);
          const line = parseFloat(input.lineHeight);
          const top = parseFloat(input.paddingTop);
          const bottom = parseFloat(input.paddingBottom);
          expect(top).toBe(bottom);
          expect(line + top + bottom).toBe(parseFloat(button.height));
          expect(parseFloat(input.minHeight)).toBe(parseFloat(button.height));
        } finally {
          close();
        }
      }
    }
  } finally {
    viewport.setViewport(original);
  }
});

test("suggestions stay in one sideways-scrolling row and insert the complete prompt", () => {
  const viewport = (window as unknown as {
    happyDOM: { setViewport: (size: { width: number; height: number }) => void };
  }).happyDOM;
  const original = { width: window.innerWidth, height: window.innerHeight };
  try {
    for (const width of [320, 390, 680]) {
      viewport.setViewport({ width, height: 844 });
      const { host, runtime, editor, sent, close } = open("");
      try {
        const prompt = "核对所有镜头字幕与配音细节。".repeat(50);
        runtime.composerSuggestions = Array.from({ length: 3 }, (_, i) => ({
          id: String(i), label: "请审片员复审并同步完整结果".repeat(20), prompt,
        }));
        flushSync();
        const bar = host.querySelector(".composer-suggest-bar")!;
        expect(getComputedStyle(bar).pointerEvents).toBe("auto");
        const row = bar.querySelector(".suggest-scroll")!;
        const style = getComputedStyle(row);
        expect(style.flexWrap).toBe("nowrap");
        expect(style.overflowX).toBe("auto");
        expect(style.overflowY).toBe("hidden");
        const chip = row.querySelector("button")!;
        expect(getComputedStyle(chip).whiteSpace).toBe("nowrap");
        expect(getComputedStyle(chip).textOverflow).toBe("ellipsis");
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        flushSync();
        expect(runtime.draft).toBe(prompt);
        expect(editor.textContent).toBe(prompt);
        expect(sent).toHaveLength(0);
      } finally {
        close();
      }
    }
  } finally {
    viewport.setViewport(original);
  }
});

/** The editor follows `runtime.draft`, whoever set it — a quote reply, a starter chip, a send. */
test("the contenteditable mirrors the runtime draft", async () => {
  const { editor, runtime, close } = open("初始草稿");
  expect(editor.textContent).toContain("初始草稿");
  runtime.draft = "换成别的";
  await tick();
  flushSync();
  expect(editor.textContent).toContain("换成别的");
  close();
});

test("Enter sends", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(1);
  close();
});

test("Shift+Enter does not send", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

test("Enter while the IME is composing does not send", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

/** Confirming a candidate fires `compositionend` and then a leftover Enter. It must not send. */
test("the Enter right after the IME commits is swallowed", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  editor.dispatchEvent(new CompositionEvent("compositionend", { data: "字", bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

test("an empty draft cannot be sent", () => {
  const { editor, sent, close } = open("");
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

test("the jump-to-bottom control hides inside the input and floats clear of it when shown", () => {
  const { host, close } = open("");
  const slot = host.querySelector(".scroll-bottom-slot") as HTMLElement;
  const button = slot.querySelector(".scroll-bottom-btn") as HTMLButtonElement;
  const hidden = getComputedStyle(button);
  const slotStyle = getComputedStyle(slot);
  expect(slot.classList.contains("is-shown")).toBe(false);
  expect(hidden.transform).toContain("translateY(76px)");
  expect(hidden.borderRadius).toBe("50%");
  expect(hidden.boxShadow).toBe("none");
  expect(hidden.pointerEvents).toBe("none");
  expect(button.tabIndex).toBe(-1);
  expect(slotStyle.overflow).toBe("hidden");
  expect(slotStyle.top).toBe("-44px");
  const card = host.querySelector(".composer-card") as HTMLElement;
  const shell = host.querySelector(".composer-card-shell") as HTMLElement;
  expect(getComputedStyle(shell).zIndex === "auto" || getComputedStyle(shell).zIndex === "").toBe(true);
  expect(Number(getComputedStyle(card).zIndex)).toBeGreaterThan(Number(slotStyle.zIndex));
  close();
});

test("showing the jump-to-bottom control slides it out of the card and keeps it clickable", () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  let jumps = 0;
  const view = render(Composer, {
    runtime,
    t,
    selected,
    showScrollBottom: true,
    onScrollToBottom: () => { jumps += 1; },
    onSend: async () => true,
    onPickPrompt: () => {},
  });
  const slot = view.host.querySelector(".scroll-bottom-slot") as HTMLElement;
  const button = slot.querySelector(".scroll-bottom-btn") as HTMLButtonElement;
  expect(slot.classList.contains("is-shown")).toBe(true);
  expect(getComputedStyle(button).transform).toContain("translateY(0)");
  expect(getComputedStyle(button).boxShadow).toBe("none");
  expect(getComputedStyle(slot).width).toBe(getComputedStyle(button).width);
  expect(getComputedStyle(button).pointerEvents).toBe("auto");
  const focusRule = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    })
    .map((rule) => rule.cssText)
    .find((text) => text.includes("scroll-bottom-btn") && text.includes("focus-visible"));
  expect(focusRule).toBeTruthy();
  expect(focusRule).toContain("outline-style: none");
  expect(focusRule).toContain("box-shadow: inset");
  expect(focusRule).not.toContain("outline-offset");
  expect(button.tabIndex).toBe(0);
  expect(button.getAttribute("aria-label")).toBe(t.chat.scrollToBottom);
  runtime.composerSuggestions = [{ id: "1", label: "下一步", prompt: "下一步做什么" }];
  flushSync();
  const bar = view.host.querySelector(".composer-suggest-bar") as HTMLElement;
  const card = view.host.querySelector(".composer-card") as HTMLElement;
  expect(Number(getComputedStyle(bar).zIndex)).toBeGreaterThan(Number(getComputedStyle(card).zIndex));
  expect(getComputedStyle(bar).maxWidth).toContain("52px");
  button.click();
  expect(jumps).toBe(1);
  view.close();
});

/**
 * Each draft is a model call on the spend ledger. They used to be fetched on opening a
 * conversation and after every message; now only the ✨ beside the attachment button asks.
 */
test("✨ drafts suggestions only when pressed, for its own conversation", () => {
  const { host, runtime, close } = open("");
  const button = host.querySelector(".suggest-btn") as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.title).toBe(t.composer.suggest);
  expect(host.querySelector(".composer-suggest-bar")).toBeNull();
  button.click();
  flushSync();
  // Read only now: the render itself asked for nothing.
  const asks = runtime.calls.filter((call) => call.name.toLowerCase().includes("suggest"));
  expect(asks).toEqual([{ name: "suggestComposer", args: [runtime.selectedId] }]);
  close();
});

/**
 * On a phone ✨ right beside the attachment button was two small targets under one thumb. It sits
 * by send instead, and steps aside once there is something to send: an empty input has room the
 * placeholder does not use, and send is then never beside a button you meant.
 */
test("✨ sits beside send, and steps aside once there is text or a file to send", () => {
  const { host, runtime, close } = open("");
  const row = host.querySelector(".composer-row")!;
  const order = [...row.children]
    .filter((el) => el.tagName !== "INPUT")
    .map((el) => el.classList[0]);
  expect(order).toEqual(["attach-btn", "composer-editor-wrap", "suggest-btn", "composer-action"]);
  const button = host.querySelector(".suggest-btn")!;
  expect(button.classList.contains("steps-aside")).toBe(false);
  runtime.draft = "已经开始输入";
  flushSync();
  expect(button.classList.contains("steps-aside")).toBe(true);
  runtime.draft = "   ";
  flushSync();
  expect(button.classList.contains("steps-aside")).toBe(false);
  const view = runtime.sessionView(runtime.selectedId!);
  view.stagedAttachments = [
    { id: "a", file: new File(["x"], "a.txt"), name: "a.txt", size: 1, isImage: false, previewUrl: null },
  ];
  flushSync();
  expect(button.classList.contains("steps-aside")).toBe(true);
  close();
});

test("pressing ✨ again while drafts are on the way or out puts them away", () => {
  const { host, runtime, close } = open("");
  const view = runtime.sessionView(runtime.selectedId!);
  const button = host.querySelector(".suggest-btn") as HTMLButtonElement;
  view.suggestionsLoading = true;
  flushSync();
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.querySelector(".suggest-spinner")).not.toBeNull();
  expect(button.title).toBe(t.composer.suggestStop);
  button.click();
  view.suggestionsLoading = false;
  view.composerSuggestions = [{ id: "1", label: "下一步", prompt: "下一步做什么" }];
  flushSync();
  expect(button.getAttribute("aria-busy")).toBeNull();
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.classList.contains("is-active")).toBe(true);
  expect(button.title).toBe(t.composer.suggestHide);
  button.click();
  flushSync();
  const asks = runtime.calls.filter((call) => call.name.toLowerCase().includes("suggest"));
  expect(asks.map((call) => call.name)).toEqual(["dismissComposerSuggestions", "dismissComposerSuggestions"]);
  close();
});

test("a press that finds nothing to suggest says so where the chips would be", () => {
  const { host, runtime, close } = open("");
  runtime.sessionView(runtime.selectedId!).suggestionsEmpty = true;
  flushSync();
  const note = host.querySelector(".composer-suggest-bar .suggest-note");
  expect(note?.textContent).toBe(t.composer.suggestNone);
  expect(note?.getAttribute("role")).toBe("status");
  expect((host.querySelector(".suggest-btn") as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
  close();
});

test("✨ waits while a reply is still coming, since drafts made now would be stale when it lands", () => {
  const selected = aDirect();
  const runtime = reactive(
    fakeRuntime({
      bots: [aBot({ id: "bot-1" })],
      sessions: [selected],
      turns: [aTurn({ session_id: selected.id, status: "running" })],
    }),
  );
  runtime.selectedId = selected.id;
  const view = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
  const button = view.host.querySelector(".suggest-btn") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe(t.composer.suggestWait);
  // Chips already out can still be put away.
  runtime.sessionView(selected.id).composerSuggestions = [{ id: "1", label: "下一步", prompt: "下一步做什么" }];
  flushSync();
  expect(button.disabled).toBe(false);
  view.close();
});


test("a phone attaches a film of any size", () => {
  const { host, runtime, close } = open("", true);
  const film = new File(["x"], "film.mp4", { type: "video/mp4" });
  Object.defineProperty(film, "size", { value: 60 * 1024 * 1024 });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [film] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(runtime.sessionView(runtime.selectedId!).stagedAttachments.map((row) => row.name)).toEqual(["film.mp4"]);
  expect(host.textContent).not.toContain("50 MiB");
  close();
});

function typeAt(editor: HTMLElement): void {
  editor.textContent = "@";
  const range = document.createRange();
  range.setStart(editor.firstChild!, 1);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

test("the file conversation takes text as well as files, with no Bot to mention", () => {
  const selected = aDirect({
    id: FILE_DROP_SESSION_ID,
    participants: [{ member: USER_MEMBER, joined_at: "2026-09-19T00:00:00.000Z", left_at: null }],
  });
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  runtime.draft = "给自己记一句";
  const sent: File[][] = [];
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async (files: File[]) => {
      sent.push(files);
      runtime.draft = "";
      return true;
    },
    onPickPrompt: () => {},
  });
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  expect(editor.getAttribute("contenteditable")).toBe("true");
  expect(editor.dataset.placeholder).toBe(t.sidebar.fileDropPlaceholder);
  expect((view.host.querySelector(".composer-action") as HTMLButtonElement).disabled).toBe(false);
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toEqual([[]]);
  // Nothing here wakes a Bot, so offering one to mention would promise an answer that never comes.
  typeAt(editor);
  expect(view.host.querySelector(".mention-autocomplete-popup")).toBeNull();
  // Nor anything for ✨ to draft: what you send here is a note to yourself.
  expect(view.host.querySelector(".suggest-btn")).toBeNull();
  view.close();

  const direct = open("");
  typeAt(direct.editor);
  expect(direct.host.querySelector(".mention-autocomplete-popup")).not.toBeNull();
  direct.close();
});

/** You can read a Bot↔Bot direct, but there is nowhere to type: you are not a participant. */
test("a Bot to Bot direct shows the read-only notice and no way in", () => {
  const selected = aBotDirect();
  const runtime = reactive(
    fakeRuntime({
      bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })],
      sessions: [selected],
    }),
  );
  runtime.selectedId = selected.id;
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async () => true,
    onPickPrompt: () => {},
  });
  expect(view.host.querySelector(".composer-locked-message")?.textContent).toContain(
    t.chat.botBotLockedNotice,
  );
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  expect(editor.getAttribute("contenteditable")).toBe("false");
  expect((view.host.querySelector(".attach-btn") as HTMLButtonElement)?.disabled).toBe(true);
  view.close();
});

test("files staged in one conversation wait there while the composer shows another", () => {
  // A phone has one composer for every conversation. Staged files held by the component rode
  // along into the next conversation, and went out with its message.
  const first = aDirect({ id: "d-first" });
  const second = aDirect({ id: "d-second" });
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [first, second] }));
  runtime.selectedId = first.id;
  const props = reactive({
    runtime,
    t,
    selected: first,
    onSend: async () => true,
    onPickPrompt: () => {},
  });
  const view = render(Composer, props);
  const file = new File(["x"], "notes.txt", { type: "text/plain" });
  runtime.sessionView(first.id).stagedAttachments = [
    { id: "att-1", file, name: "notes.txt", size: 1, isImage: false, previewUrl: null },
  ];
  flushSync();
  expect(view.host.querySelectorAll(".composer-attachment-item")).toHaveLength(1);
  props.selected = second;
  flushSync();
  expect(view.host.querySelectorAll(".composer-attachment-item")).toHaveLength(0);
  props.selected = first;
  flushSync();
  expect(view.host.querySelectorAll(".composer-attachment-item")).toHaveLength(1);
  view.close();
});

/**
 * A phone whose link dropped mid-upload lost the files and the words with it: the composer
 * cleared both before the send, and they had to be picked and typed again.
 */
test("a send that does not land keeps the files and the words where they were", async () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  runtime.draft = "这两个文件";
  let lands = false;
  const sent: File[][] = [];
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async (files: File[]) => {
      sent.push(files);
      if (lands) runtime.draft = "";
      return lands;
    },
    onPickPrompt: () => {},
  });
  const staged = runtime.sessionView(selected.id);
  const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
  staged.stagedAttachments = [{ id: "att-1", file, name: "clip.mp4", size: 1, isImage: false, previewUrl: null }];
  flushSync();
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  };
  const action = view.host.querySelector(".composer-action") as HTMLButtonElement;
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  action.click();
  await settle();
  expect(sent).toEqual([[file]]);
  expect(view.host.querySelectorAll(".composer-attachment-item")).toHaveLength(1);
  expect(editor.textContent).toContain("这两个文件");

  // On its way, a staged file cannot be taken back.
  staged.sending = true;
  flushSync();
  expect((view.host.querySelector(".attachment-delete-btn") as HTMLButtonElement).disabled).toBe(true);
  staged.sending = false;
  flushSync();

  lands = true;
  action.click();
  await settle();
  expect(sent).toEqual([[file], [file]]);
  expect(view.host.querySelectorAll(".composer-attachment-item")).toHaveLength(0);
  expect(editor.textContent).toBe("");
  view.close();
});

/**
 * Over the relay a send can take a while, and the button only greyed out — the same look as a
 * composer with nothing to send. A send that lands at once still shows nothing.
 */
test("a send still on its way shows on the button, and an upload shows how far it has gone", async () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  const view = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
  const state = runtime.sessionView(selected.id);
  const first = new File([new Uint8Array(300)], "a.mp4");
  const second = new File([new Uint8Array(100)], "b.mp4");
  state.stagedAttachments = [
    { id: "a", file: first, name: "a.mp4", size: 300, isImage: false, previewUrl: null },
    { id: "b", file: second, name: "b.mp4", size: 100, isImage: false, previewUrl: null },
  ];
  const action = () => view.host.querySelector(".composer-action") as HTMLButtonElement;
  const sizes = () => [...view.host.querySelectorAll(".attachment-size")].map((el) => el.textContent);

  state.sending = true;
  flushSync();
  expect(action().getAttribute("aria-busy")).toBeNull();
  expect(action().querySelector(".send-spinner")).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 300));
  flushSync();
  expect(action().classList.contains("is-sending")).toBe(true);
  expect(action().getAttribute("aria-busy")).toBe("true");
  expect(action().getAttribute("aria-label")).toBe(t.composer.sending);
  expect(action().querySelector(".send-spinner")).not.toBeNull();

  // Three quarters of the first file, none of the second: they go out in order.
  state.upload = { files: [first, second], loaded: 225 };
  flushSync();
  expect(action().querySelector(".send-spinner")).toBeNull();
  const fill = action().querySelector(".send-progress-fill")!;
  const length = Number(fill.getAttribute("stroke-dasharray"));
  expect(Number(fill.getAttribute("stroke-dashoffset"))).toBeCloseTo(length * (1 - 225 / 400));
  expect(sizes()[0]).toContain(t.composer.uploaded(75));
  expect(sizes()[1]).toContain(t.composer.uploaded(0));

  state.sending = false;
  state.upload = null;
  flushSync();
  expect(action().classList.contains("is-sending")).toBe(false);
  expect(action().getAttribute("aria-label")).toBe(t.composer.send);
  expect(sizes()[0]).not.toContain("%");
  view.close();
});

/** A tree row somewhere else on screen, and the drag from it to wherever `under` says the pointer is. */
function treeRow(items: WorkspaceDragItem[]) {
  const el = document.createElement("button");
  document.body.append(el);
  el.addEventListener("pointerdown", (event) => pressWorkspacePaths(event, { items: () => items, label: () => "rows" }));
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "mouse" });
  return {
    press(under: () => Element | null) {
      document.elementFromPoint = under;
      el.dispatchEvent(pointer("pointerdown", 10, 10));
      window.dispatchEvent(pointer("pointermove", 200, 300));
      flushSync();
    },
    release() {
      window.dispatchEvent(pointer("pointerup", 200, 300));
      flushSync();
    },
    remove: () => el.remove(),
  };
}

test("files dragged in from the tree wait as references, and go out by path with nothing uploaded", async () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  runtime.draft = "";
  const thumbs: Array<[string, string | undefined]> = [];
  runtime.client = {
    getWorkspaceFileBlob: async (path: string, _progress: unknown, options?: { size?: string }) => {
      thumbs.push([path, options?.size]);
      return new Blob(["png"], { type: "image/png" });
    },
  } as never;
  const sent: Array<[File[], string[]]> = [];
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async (files: File[], paths: string[]) => {
      sent.push([files, paths]);
      return true;
    },
    onPickPrompt: () => {},
  });
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = (() => "blob:thumb") as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
  const elementFromPoint = document.elementFromPoint;
  const tree = treeRow([
    { path: "docs/brief.md", isDir: false },
    { path: "shots/a.png", isDir: false },
    { path: "shots", isDir: true },
  ]);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  };
  try {
    const card = view.host.querySelector(".composer-card") as HTMLElement;
    const action = view.host.querySelector(".composer-action") as HTMLButtonElement;
    expect(action.disabled).toBe(true);

    // On its way, the card says it would take it; under the pointer, it says what a drop does.
    tree.press(() => document.body);
    expect(card.classList.contains("is-drop-ready")).toBe(true);
    expect(card.classList.contains("is-drop-over")).toBe(false);
    tree.release();
    expect(card.classList.contains("is-drop-ready")).toBe(false);
    expect(view.host.querySelectorAll(".is-workspace-ref")).toHaveLength(0);

    tree.press(() => view.host.querySelector(".composer-input"));
    expect(card.classList.contains("is-drop-over")).toBe(true);
    expect(view.host.querySelector(".composer-drop-hint")?.textContent).toBe(t.composer.dropWorkspaceItems);
    tree.release();
    await settle();
    const chips = () => [...view.host.querySelectorAll<HTMLElement>(".is-workspace-ref")];
    expect(chips().map((chip) => [chip.querySelector(".attachment-name")?.textContent, chip.querySelector(".attachment-size")?.textContent])).toEqual([
      ["brief.md", "docs/brief.md"],
      ["a.png", "shots/a.png"],
      ["shots", "shots"],
    ]);
    // Only the picture asks the Mac for anything: its small copy.
    expect(thumbs).toEqual([["shots/a.png", "thumb"]]);
    expect(chips()[1]!.querySelector("img")?.getAttribute("src")).toBe("blob:thumb");
    expect(view.host.querySelector(".composer-drop-hint")).toBeNull();

    // The same rows again add nothing; one taken back stays out.
    tree.press(() => card);
    tree.release();
    // The click a release fires is the drag's; what comes after it is yours.
    await settle();
    expect(chips()).toHaveLength(3);
    (chips()[2]!.querySelector(".attachment-delete-btn") as HTMLButtonElement).click();
    flushSync();
    expect(chips()).toHaveLength(2);

    // No words needed: the references are something to send.
    expect(action.disabled).toBe(false);
    action.click();
    await settle();
    expect(sent).toEqual([[[], ["docs/brief.md", "shots/a.png"]]]);
    expect(chips()).toHaveLength(0);
    expect(revoked).toEqual(["blob:thumb"]);
  } finally {
    tree.remove();
    document.elementFromPoint = elementFromPoint;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    view.close();
  }
});

test("the file conversation, a locked composer and one already sending take nothing from the tree", () => {
  const fileDrop = aDirect({
    id: FILE_DROP_SESSION_ID,
    participants: [{ member: USER_MEMBER, joined_at: "2026-09-19T00:00:00.000Z", left_at: null }],
  });
  const botBot = aBotDirect();
  const direct = aDirect();
  const runtime = reactive(
    fakeRuntime({ bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })], sessions: [fileDrop, botBot, direct] }),
  );
  const elementFromPoint = document.elementFromPoint;
  const tree = treeRow([{ path: "docs/brief.md", isDir: false }]);
  try {
    for (const selected of [fileDrop, botBot, direct]) {
      runtime.selectedId = selected.id;
      if (selected === direct) runtime.sessionView(direct.id).sending = true;
      const view = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
      const card = view.host.querySelector(".composer-card") as HTMLElement;
      tree.press(() => card);
      expect(card.classList.contains("is-drop-ready")).toBe(false);
      expect(view.host.querySelector(".composer-drop-hint")).toBeNull();
      tree.release();
      expect(runtime.sessionView(selected.id).stagedPaths).toEqual([]);
      view.close();
    }
  } finally {
    tree.remove();
    document.elementFromPoint = elementFromPoint;
  }
});

test("a direct has one Stop, beside Send while its Bot works here: it stops that turn, with no menu to pick a scope from", async () => {
  // A drag test above leaves its release's click to be swallowed until the next macrotask.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const selected = aDirect();
  const turns = [aTurn({ id: "turn-7", session_id: selected.id, bot_id: "bot-1", task_id: "task-1" })];
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1", name: "视频导演" })], sessions: [selected], turns, holdsOn: true, turnInbox: true }));
  runtime.selectedId = selected.id;
  const { host, close } = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
  try {
    expect(host.querySelector(".stop-menu-trigger")).toBeNull();
    const stops = [...host.querySelectorAll<HTMLButtonElement>(".composer-action.stop")];
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("aria-label")).toBe(t.composer.stopGeneration);
    expect(host.querySelector(".composer-action.send")).not.toBeNull();
    click(stops[0]);
    expect(runtime.calls.filter((call) => call.name === "stopTurn").map((call) => call.args)).toEqual([[selected.id]]);
  } finally {
    close();
  }
});

test("a direct's Stop is never a second one: where Stop already replaces Send there is just that, and idle Bots show none", () => {
  const selected = aDirect();
  const working = [aTurn({ session_id: selected.id })];
  const replacing = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected], turns: working, holdsOn: true, turnInbox: false }));
  replacing.selectedId = selected.id;
  const one = render(Composer, { runtime: replacing, t, selected, onSend: async () => true, onPickPrompt: () => {} });
  expect(one.host.querySelectorAll(".composer-action.stop")).toHaveLength(1);
  expect(one.host.querySelector(".composer-action.send")).toBeNull();
  one.close();
  for (const turns of [[], [aTurn({ session_id: selected.id, status: "completed" })], [aTurn({ session_id: "elsewhere" })]]) {
    const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected], turns, holdsOn: true, turnInbox: true }));
    runtime.selectedId = selected.id;
    const none = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
    expect(none.host.querySelector(".composer-action.stop")).toBeNull();
    expect(none.host.querySelector(".stop-menu-trigger")).toBeNull();
    none.close();
  }
});

test("a group's stop menu sits beside Send while a Bot works in it, and stops the chosen scope from here, until your next line there", () => {
  const selected = aGroup();
  const turns = [aTurn({ session_id: selected.id, bot_id: "bot-1", task_id: "task-1" })];
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1", name: "视频导演" })], sessions: [selected], turns, holdsOn: true }));
  runtime.selectedId = selected.id;
  const { host, close } = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
  try {
    expect(host.querySelector(".composer-action.stop")).toBeNull();
    click(host.querySelector(".stop-menu-trigger"));
    expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["停下这个群里的工作", "停下视频导演的全部工作", "停下这件事", "停下所有 Bot"]);
    click(buttonByText(host, "停下这件事"));
    expect(runtime.calls.filter((call) => call.name === "stopScope").map((call) => call.args)).toEqual([["plan", "task-1", selected.id, { liftOnNext: true }]]);
  } finally {
    close();
  }
});

test("no group stop menu before the daemon has stops, nor while nobody in it is at work", () => {
  const selected = aGroup();
  for (const over of [{ turns: [aTurn({ session_id: selected.id })], holdsOn: false }, { turns: [], holdsOn: true }]) {
    const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected], ...over }));
    runtime.selectedId = selected.id;
    const { host, close } = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
    expect(host.querySelector(".stop-menu-trigger")).toBeNull();
    close();
  }
});

test("in a direct whose Bot works, or still reads your last line, the hint says it reads what you send next (ADR 0063)", () => {
  const selected = aDirect();
  const hint = (over: Parameters<typeof fakeRuntime>[0]) => {
    const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected], ...over }));
    runtime.selectedId = selected.id;
    const view = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
    const text = view.host.querySelector(".send-shortcut-hint")?.textContent ?? "";
    view.close();
    return text;
  };
  const working = [aTurn({ session_id: selected.id, bot_id: "bot-1" })];
  const reading = [{ id: "pj-1", session_id: selected.id, message_id: "m-1", bot_id: "bot-1", stage: "organizing" as const, created_at: "t" }];
  expect(hint({})).toBe(t.chat.sendHint);
  expect(hint({ turns: working, turnInbox: true, linesInOrder: true })).toBe(t.composer.workingHint);
  expect(hint({ pendingJudgements: reading, turnInbox: true, linesInOrder: true })).toBe(t.composer.workingHint);
  // Where Send really waits — an older daemon — it still says to wait.
  expect(hint({ pendingJudgements: reading, turnInbox: true })).toBe(t.composer.waitingHint);
  expect(hint({ turns: working })).toBe(t.composer.waitingHint);
});

test("↑ in an empty box opens your newest line for changing; with words in the box it is only a key", () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  let asked = 0;
  const view = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {}, onEditLast: () => { asked += 1; return true; } });
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  const up = () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    flushSync();
    return event.defaultPrevented;
  };
  expect(up()).toBe(true);
  expect(asked).toBe(1);
  runtime.draft = "还没发的话";
  flushSync();
  expect(up()).toBe(false);
  expect(asked).toBe(1);
  view.close();
});
