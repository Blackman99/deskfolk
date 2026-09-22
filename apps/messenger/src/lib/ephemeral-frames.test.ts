import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventSync } from "./event-sync.ts";
import { isEphemeralFrame, parseStreamFrame, parseToolFrame } from "./ephemeral-frames.ts";

const stream = { type: "stream", id: "T:call_1", offset: 0, data: "aGk=" };
const tool = { type: "tool", turn_id: "T", id: "call_1", name: "shell", phase: "started", command: "pnpm build" };

test("a stream frame is recognised, with its optional parts", () => {
  expect(parseStreamFrame(stream)?.id).toBe("T:call_1");
  expect(parseStreamFrame({ ...stream, skipped: 12, closed: true })?.skipped).toBe(12);
  expect(parseStreamFrame({ ...stream, data: "not base64!" })).toBeNull();
  expect(parseStreamFrame({ ...stream, offset: -1 })).toBeNull();
  expect(parseStreamFrame(null)).toBeNull();
});

test("a tool frame is recognised, and an unknown phase is not", () => {
  expect(parseToolFrame(tool)?.command).toBe("pnpm build");
  expect(parseToolFrame({ ...tool, phase: "announced" })).toBeNull();
  expect(parseToolFrame({ ...tool, exit_code: "0" })).toBeNull();
  expect(parseToolFrame({ type: "event", payload: {} })).toBeNull();
});

test("a sequenced event is not ephemeral", () => {
  const event = { type: "event", event_instance_id: "a".repeat(32), seq: 3, payload: { event: "bot.upsert" } };
  expect(isEphemeralFrame(event)).toBe(false);
  expect(isEphemeralFrame({ type: "ready", event_instance_id: "a".repeat(32), watermark_seq: 0 })).toBe(false);
});

/**
 * The regression this module exists for. A phone reads events over the relay, where terminal
 * bytes arrive on the same channel; one of them reaching `EventSync` reads as a cursor mismatch,
 * closes the reader and shows "the host is unreachable" — which is what opening a terminal on a
 * phone used to do, every time.
 */
test("an ephemeral frame handed to the sequenced reader would drop the connection", () => {
  const sync = new EventSync();
  const instance = "a".repeat(32);
  expect(sync.install({ event_instance_id: instance, watermark_seq: 0 })).toEqual([]);
  // Proof the reader cannot survive one, which is why both sockets take them out first.
  expect(sync.receive(stream as never)).toBeNull();

  const fresh = new EventSync();
  expect(fresh.install({ event_instance_id: instance, watermark_seq: 0 })).toEqual([]);
  expect(fresh.receive(tool as never)).toBeNull();

  // And the guard both readers use catches exactly those two.
  expect(isEphemeralFrame(stream)).toBe(true);
  expect(isEphemeralFrame(tool)).toBe(true);
});

/**
 * Both readers, not one.
 *
 * The rule was written once for the local WebSocket and forgotten for the relay, and the bug
 * that caused was invisible on a desktop: opening a terminal on a phone dropped the link every
 * time, reported as "the host is unreachable". The remote listener is built inside
 * `connectRemote` with no seam to inject, so this reads the source instead — crude, but it is
 * the thing that actually went wrong, and a second reader added later will trip it.
 */
test("every reader of the event channel routes ephemeral frames out first", () => {
  const source = readFileSync(new URL("./runtime.svelte.ts", import.meta.url), "utf8");
  const readers = [...source.matchAll(/sync\.receive\(/g)];
  // The two live readers, plus the one-shot `ready` frame each of them starts from.
  expect(readers.length).toBeGreaterThanOrEqual(2);
  for (const reader of readers) {
    const before = source.slice(Math.max(0, reader.index - 1200), reader.index);
    const isLiveReader = /addEventListener\("message"|api\.connect\(/.test(before);
    if (!isLiveReader) continue;
    expect(before).toContain("acceptEphemeral");
  }
});
