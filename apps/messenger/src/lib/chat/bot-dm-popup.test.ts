import { afterEach, expect, test } from "bun:test";
import type { RuntimeSnapshot, SessionSnapshot, SessionSummary } from "@real-bot/protocol";
import { MessengerRuntime } from "../runtime.svelte.ts";
import { emptySnapshot } from "../snapshot.ts";
import { aBot, aBotDirect, aDirect, aMessage } from "../test-fixtures.ts";
import { fakeSyncSocket, localApiFetch } from "../test-sync-harness.ts";

// ADR 0091: a Bot↔Bot direct is read in a popup over the conversation it came from. Every way to it
// goes through `selectSession`, which opens the popup instead of moving the selection.

const instance = "b".repeat(32);
const cursor = { event_instance_id: instance, watermark_seq: 0 };
const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
const Socket = fakeSyncSocket(cursor);
const runtimes: MessengerRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("runtime did not reach expected state");
}

const yours = aDirect({ id: "direct-1" });
const direct = aBotDirect({ id: "bb-1", origin_session_id: "direct-1", origin_message_id: "line-1" });

function detail(session: SessionSummary, body: string, id: string): SessionSnapshot {
  return {
    ...cursor,
    session: { ...session, messages: { items: [aMessage({ id, session_id: session.id, body })], next: null }, turns: [] },
    judgements: [],
  } as unknown as SessionSnapshot;
}

async function connected(): Promise<{ runtime: MessengerRuntime; reads: string[] }> {
  const initial: RuntimeSnapshot = { ...emptySnapshot(), ...cursor, bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2", name: "Helper" })], sessions: [yours, direct] };
  const reads: string[] = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = localApiFetch({
    snapshot: () => initial,
    handle: (path) => {
      if (path.includes("/v1/sessions/direct-1/snapshot")) { reads.push("direct-1"); return detail(yours, "share the notes with Helper", "line-1"); }
      if (path.includes("/v1/sessions/bb-1/snapshot")) { reads.push("bb-1"); return detail(direct, "the notes are in notes.md", "dm-1"); }
      return undefined;
    },
  });
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  runtime.start();
  await until(() => runtime.connection === "connected");
  return { runtime, reads };
}

test("a Bot↔Bot direct opens in its popup: the conversation on screen stays selected, and the direct's history loads beside it", async () => {
  const { runtime, reads } = await connected();
  await runtime.selectSession("direct-1");
  await runtime.selectSession("bb-1");
  expect(runtime.selectedId).toBe("direct-1");
  expect(runtime.botDmSessionId).toBe("bb-1");
  expect(reads).toEqual(["direct-1", "bb-1"]);
  expect(runtime.snapshot.messages.map((message) => message.id).sort()).toEqual(["dm-1", "line-1"]);
  expect(runtime.sessionView("bb-1").detailLoaded).toBe(true);
  // The selection's own view kept what it had.
  expect(runtime.sessionView("direct-1").detailLoaded).toBe(true);
});

test("going to any other conversation puts the popup away; closing it leaves the selection alone", async () => {
  const { runtime } = await connected();
  await runtime.selectSession("direct-1");
  await runtime.selectSession("bb-1");
  runtime.closeBotDm();
  expect(runtime.botDmSessionId).toBeNull();
  expect(runtime.selectedId).toBe("direct-1");
  await runtime.selectSession("bb-1");
  await runtime.selectSession("direct-1");
  expect(runtime.botDmSessionId).toBeNull();
  expect(runtime.selectedId).toBe("direct-1");
});

test("opened with nothing on screen, the conversation it came from goes under it, at the line it hangs under", async () => {
  const { runtime } = await connected();
  await runtime.selectSession("bb-1", { messageId: "dm-1" });
  expect(runtime.selectedId).toBe("direct-1");
  expect(runtime.botDmSessionId).toBe("bb-1");
  expect(runtime.sessionView("direct-1").highlightedMessageId).toBe("line-1");
  expect(runtime.sessionView("bb-1").highlightedMessageId).toBe("dm-1");
});
