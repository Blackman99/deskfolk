import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";
import { HISTORY_WINDOW_INITIAL } from "./history-window.ts";

const t = copyFor("en");
const session = aGroup({ id: "sess-1" });
const bot = aBot({ id: "bot-1", name: "Alpha" });

function history(count: number) {
  return Array.from({ length: count }, (_, i) =>
    aMessage({
      id: `m-${String(i).padStart(4, "0")}`,
      session_id: "sess-1",
      kind: i % 2 ? "bot" : "user",
      author: i % 2 ? "bot-1" : "you",
      body: `message ${i}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }),
  );
}

function stage(messages: ReturnType<typeof history>, extra: Record<string, unknown> = {}) {
  const runtime = reactive(
    fakeRuntime({ bots: [bot], sessions: [session], messages, turns: [] }, { selectedId: "sess-1", ...extra }),
  );
  const rendered = render(ChatStage, {
    runtime,
    t,
    selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: () => {},
    onCreateBot: () => {},
  } as never);
  return { ...rendered, runtime };
}

test("a long history mounts only its newest window", () => {
  const { host, close } = stage(history(300));
  const mounted = host.querySelectorAll("[data-message-id]");
  expect(mounted.length).toBe(HISTORY_WINDOW_INITIAL);
  // The newest message is the one that must be on screen; the oldest must not be.
  expect(host.querySelector('[data-message-id="m-0299"]')).not.toBeNull();
  expect(host.querySelector('[data-message-id="m-0000"]')).toBeNull();
  close();
});

test("a short history is mounted whole and offers nothing to load", () => {
  const { host, close } = stage(history(12));
  expect(host.querySelectorAll("[data-message-id]").length).toBe(12);
  expect(host.textContent).not.toContain("Load earlier messages");
  close();
});

test("a search hit older than the window is mounted so it can be scrolled to", () => {
  const { host, runtime, close } = stage(history(300));
  expect(host.querySelector('[data-message-id="m-0100"]')).toBeNull();
  runtime.highlightedMessageId = "m-0100";
  flushSync();
  expect(host.querySelector('[data-message-id="m-0100"]')).not.toBeNull();
  close();
});

test("with every loaded message on screen, the button asks the Mac for the page before it", () => {
  const { host, runtime, close } = stage(history(12), { hasOlderMessages: true });
  click(buttonByText(host, "Load earlier messages"));
  expect(runtime.calls.some((c) => c.name === "loadOlderMessages")).toBe(true);
  close();
});

test("all messages have clickable anchors and older Bot messages mount on jump", async () => {
  const { host, close } = stage(history(300));
  await tick();
  const entries = host.querySelectorAll<HTMLButtonElement>('[data-index-id]');
  expect(entries).toHaveLength(300);
  expect(host.querySelector('[data-message-id="m-0001"]')).toBeNull();
  expect(entries[1]!.getAttribute('aria-label')).toContain('Alpha');
  entries[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  await tick();
  expect(host.querySelector('[data-message-id="m-0001"]')).not.toBeNull();
  close();
});

test("Bot-only histories have an index", () => {
  const { host, close } = stage(history(5).map((message) => ({ ...message, kind: 'bot', author: 'bot-1' })));
  expect(host.querySelectorAll('[data-index-id]')).toHaveLength(5);
  close();
});

test("a phone hides the message index and a desktop window shows it", () => {
  const dom = (window as unknown as { happyDOM?: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM;
  dom?.setViewport({ width: 390, height: 844 });
  const phone = stage(history(8));
  const phoneRail = phone.host.querySelector(".message-index");
  expect(phoneRail).not.toBeNull();
  expect(getComputedStyle(phoneRail!).display).toBe("none");
  phone.close();

  dom?.setViewport({ width: 1180, height: 820 });
  const desktop = stage(history(8));
  const desktopRail = desktop.host.querySelector(".message-index");
  expect(desktopRail).not.toBeNull();
  expect(getComputedStyle(desktopRail!).display).not.toBe("none");
  desktop.close();
});

test("one message from the person is not enough for an index", () => {
  const { host, close } = stage(history(1));
  expect(host.querySelector(".message-index")).toBeNull();
  close();
});

test("the first page of a remote conversation says it is loading instead of looking empty", () => {
  const { host, close } = stage([], { historyLoading: true });
  expect(host.textContent).toContain("Loading this conversation…");
  expect(host.textContent).not.toContain("No messages yet.");
  close();
});
