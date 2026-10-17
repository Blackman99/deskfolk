import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
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

function measure(el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(el, key, { configurable: true, get: () => value, set: () => {} });
  }
}

test("with every loaded message on screen, scrolling to the top asks the Mac for the page before it", () => {
  const { host, runtime, close } = stage(history(12), { hasOlderMessages: true });
  expect(host.textContent).not.toContain("Load earlier messages");
  const stream = host.querySelector<HTMLElement>(".stream")!;
  measure(stream, { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 });
  stream.dispatchEvent(new Event("scroll"));
  measure(stream, { scrollHeight: 2000, clientHeight: 600, scrollTop: 100 });
  stream.dispatchEvent(new Event("scroll"));
  expect(runtime.calls.filter((c) => c.name === "loadOlderMessages").length).toBe(1);
  close();
});

test("a transcript shorter than its pane pages back on its own", () => {
  const { host, runtime, close } = stage(history(12), { hasOlderMessages: true });
  const stream = host.querySelector<HTMLElement>(".stream")!;
  measure(stream, { scrollHeight: 400, clientHeight: 600, scrollTop: 0 });
  window.dispatchEvent(new Event("resize"));
  expect(runtime.calls.filter((c) => c.name === "loadOlderMessages").length).toBe(1);
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
