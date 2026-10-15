import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aGroup, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import BotDmDialog from "./BotDmDialog.svelte";

const t = copyFor("zh");

function open(direct = aBotDirect({ id: "bb-1", origin_session_id: "sess-1", origin_message_id: "msg-1" }), extra: ReturnType<typeof aBotDirect>[] = []) {
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
    sessions: [aGroup({ id: "sess-1", name: "视频组" }), direct, ...extra],
    messages: [aMessage({ id: "dm-1", session_id: direct.id, author: "bot-1", body: "the notes are in notes.md" })],
  }, { selectedId: "sess-1" }));
  let closed = 0;
  const view = render(BotDmDialog, {
    runtime, t, session: direct,
    onClose: () => { closed += 1; },
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  flushSync();
  return { ...view, runtime, closed: () => closed };
}

test("the popup is the direct's own conversation, titled with its two Bots and where it came from", () => {
  const { host, close } = open();
  try {
    expect(host.querySelector("#bot-dm-title")?.textContent?.trim()).toBe("Writer ↔ Researcher");
    expect(host.querySelector(".bot-dm-source-text")?.textContent).toBe(t.sidebar.botBotSource("视频组"));
    expect(host.querySelector(".bot-dm-dialog .stream")?.textContent).toContain("the notes are in notes.md");
    // Read-only, as a Bot↔Bot direct always is.
    expect(host.textContent).toContain(t.chat.botBotLockedNotice);
  } finally { close(); }
});

test("its source line goes back to the line it hangs under", () => {
  const { host, runtime, close } = open();
  try {
    click(host.querySelector("button.bot-dm-source"));
    expect(runtime.calls.filter((call) => call.name === "selectSession").map((call) => call.args)).toEqual([["sess-1", { messageId: "msg-1" }]]);
  } finally { close(); }
});

test("a direct opened from another direct goes back to that one", () => {
  const parent = aBotDirect({ id: "bb-0", origin_session_id: "sess-1", origin_message_id: "msg-1" });
  const child = aBotDirect({ id: "bb-1", origin_session_id: "bb-0", origin_message_id: "dm-0" });
  const { host, runtime, close } = open(child, [parent]);
  try {
    expect(host.querySelector("button.bot-dm-source")?.getAttribute("title")).toBe(t.sidebar.botBotSourceRoot("Writer ↔ Researcher", "视频组"));
    click(host.querySelector("button.bot-dm-source"));
    expect(runtime.calls.filter((call) => call.name === "selectSession").map((call) => call.args)).toEqual([["bb-0", { messageId: "dm-0" }]]);
  } finally { close(); }
});

test("Escape and ✕ close it; an Escape a menu inside already took does not", () => {
  const { host, closed, close } = open();
  try {
    const dialog = host.querySelector<HTMLElement>(".bot-dm-backdrop")!;
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    dialog.dispatchEvent(taken);
    expect(closed()).toBe(0);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closed()).toBe(1);
    click(host.querySelector(".modal-close"));
    expect(closed()).toBe(2);
    // A message's menu open in it takes the Escape (it listens on the window, after the popup).
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closed()).toBe(2);
    menu.remove();
  } finally { close(); }
});

test("a direct whose source is gone says so instead of offering a dead link", () => {
  const { host, close } = open(aBotDirect({ id: "bb-1", origin_session_id: "deleted", origin_message_id: "msg-1" }));
  try {
    expect(host.querySelector("button.bot-dm-source")).toBeNull();
    expect(host.querySelector(".bot-dm-source.is-static")?.textContent?.trim()).toBe(t.sidebar.botBotSourceMissing);
  } finally { close(); }
});
