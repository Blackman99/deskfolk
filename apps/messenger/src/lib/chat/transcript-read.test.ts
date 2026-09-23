import { expect, test } from "bun:test";
import ChatStage from "./ChatStage.svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";

const t = copyFor("zh");
const realSetTimeout = globalThis.setTimeout;
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 40));

/** The transcript holds a second before it counts as read; this test is about how often it sends. */
function hurryTimers(): () => void {
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(handler as () => void, ms && ms > 5 ? 5 : ms, ...rest)) as typeof setTimeout;
  return () => {
    globalThis.setTimeout = realSetTimeout;
  };
}

/**
 * The Mac answers a read with `session.upsert`, so the read comes back as a new snapshot that
 * says nothing new. Re-reading on the strength of it looped once a second for as long as the
 * conversation stayed on screen, and rebuilt the file tree beside it every time.
 */
test("a snapshot that brings no new message does not re-send the read", async () => {
  const session = aDirect();
  const messages = [aMessage({ id: "m1", session_id: session.id, body: "hi" })];
  const stubbed = fakeRuntime(
    { bots: [aBot()], sessions: [session], messages },
    { selectedId: session.id },
  );
  // The raw array, not the `$state` proxy of it: reading it through the proxy freezes what it saw.
  const calls = stubbed.calls;
  const reads = () => calls.filter((call) => call.name === "submitBoundedRead");
  const runtime = reactive(stubbed);
  const restoreTimers = hurryTimers();
  const { close } = render(ChatStage, {
    runtime,
    t,
    selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: () => {},
    onCreateBot: () => {},
  });
  try {
    await settle();
    expect(reads().length).toBe(1);

    runtime.snapshot = { ...runtime.snapshot, sessions: [...runtime.snapshot.sessions] };
    await settle();
    expect(reads().length).toBe(1);

    // A message that actually arrived is read: nothing here holds a real read back.
    runtime.snapshot = {
      ...runtime.snapshot,
      messages: [
        ...messages,
        aMessage({
          id: "m2",
          session_id: session.id,
          body: "and again",
          created_at: "2026-09-19T02:00:05.000Z",
        }),
      ],
    };
    await settle();
    expect(reads().length).toBe(2);
    expect(reads().at(-1)?.args).toEqual([session.id, "m2"]);
  } finally {
    restoreTimers();
    close();
  }
});

test("a pane that is on screen but not selected reads its own conversation", async () => {
  // Each visible pane times its own read. Gating on the selected conversation meant a pane you
  // were watching but had not clicked into never marked anything read.
  const session = aDirect();
  const messages = [aMessage({ id: "m1", session_id: session.id, body: "hi" })];
  const stubbed = fakeRuntime(
    { bots: [aBot()], sessions: [session, aDirect({ id: "elsewhere" })], messages },
    { selectedId: "elsewhere" },
  );
  const calls = stubbed.calls;
  const reads = () => calls.filter((call) => call.name === "submitBoundedRead");
  const runtime = reactive(stubbed);
  const restoreTimers = hurryTimers();
  const { close } = render(ChatStage, {
    runtime,
    t,
    selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: () => {},
    onCreateBot: () => {},
  });
  try {
    await settle();
    expect(reads().map((call) => call.args)).toEqual([[session.id, "m1"]]);
  } finally {
    restoreTimers();
    close();
  }
});
