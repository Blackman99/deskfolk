import { expect, test } from "bun:test";
import { EventStream } from "./session-events";
import { COMMAND_STREAM_BYTES, StreamHub, type StreamRead } from "./streams";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (read: StreamRead) => new TextDecoder().decode(read.bytes);

test("a reader from the beginning gets everything, in order", () => {
  const hub = new StreamHub();
  hub.open("t", 1024);
  hub.push("t", bytes("one "));
  hub.push("t", bytes("two"));
  const read = hub.read("t");
  expect(text(read)).toBe("one two");
  expect(read.offset).toBe(0);
  expect(read.end).toBe(7);
  expect(read.skipped).toBe(0);
});

test("the cursor is a byte offset, so re-chunking does not shift it", () => {
  const hub = new StreamHub();
  hub.open("t", 1024);
  hub.push("t", bytes("abcdef"));
  expect(text(hub.read("t", 3))).toBe("def");
  hub.push("t", bytes("gh"));
  expect(text(hub.read("t", 6))).toBe("gh");
  expect(text(hub.read("t", 8))).toBe("");
});

test("the ring drops the oldest bytes and says how many it skipped", () => {
  const hub = new StreamHub();
  hub.open("t", 8);
  hub.push("t", bytes("12345"));
  hub.push("t", bytes("67890"));
  const read = hub.read("t", 0);
  expect(text(read)).toBe("34567890");
  expect(read.offset).toBe(2);
  expect(read.skipped).toBe(2);
  expect(read.end).toBe(10);
});

test("a subscriber gets its backlog and its live bytes without a gap between them", () => {
  const hub = new StreamHub();
  hub.open("t", 1024);
  hub.push("t", bytes("before"));
  const seen: string[] = [];
  hub.subscribe("t", 0, (read) => { seen.push(text(read)); });
  hub.push("t", bytes("after"));
  expect(seen).toEqual(["before", "after"]);
});

test("unsubscribing stops delivery", () => {
  const hub = new StreamHub();
  hub.open("t", 1024);
  const seen: string[] = [];
  const off = hub.subscribe("t", 0, (read) => { if (read.bytes.length) seen.push(text(read)); });
  hub.push("t", bytes("a"));
  off();
  hub.push("t", bytes("b"));
  expect(seen).toEqual(["a"]);
});

test("closing tells subscribers, and the bytes stay readable", () => {
  const hub = new StreamHub();
  hub.open("t", 1024);
  hub.push("t", bytes("done"));
  let closed = false;
  hub.subscribe("t", 0, (read) => { closed ||= read.closed; });
  hub.close("t");
  expect(closed).toBe(true);
  expect(text(hub.read("t"))).toBe("done");
  hub.push("t", bytes("ignored"));
  expect(text(hub.read("t"))).toBe("done");
});

test("subscribing to a closed stream reads the backlog and ends", () => {
  const hub = new StreamHub();
  hub.open("t", 1024);
  hub.push("t", bytes("tail"));
  hub.close("t");
  const seen: StreamRead[] = [];
  hub.subscribe("t", 0, (read) => seen.push(read));
  expect(text(seen[0]!)).toBe("tail");
  expect(seen.at(-1)!.closed).toBe(true);
});

test("a dropped stream reads empty rather than throwing", () => {
  const hub = new StreamHub();
  hub.open("t", 1024);
  hub.push("t", bytes("gone"));
  hub.drop("t");
  expect(hub.has("t")).toBe(false);
  expect(hub.read("t").closed).toBe(true);
  expect(hub.ids()).toEqual([]);
});

test("output never reaches the sequenced event ring", () => {
  // The rule this whole module exists for: 10 MiB of build output must not cost every client
  // a resnapshot. EventStream is 2000 frames / 16 MiB and overflowing it reseeds the cursor.
  const events = new EventStream();
  const before = events.cursor();
  const hub = new StreamHub();
  hub.open("t", COMMAND_STREAM_BYTES);
  const chunk = new Uint8Array(64 * 1024).fill(65);
  for (let i = 0; i < 160; i++) hub.push("t", chunk);
  const after = events.cursor();
  expect(after.watermark_seq).toBe(before.watermark_seq);
  expect(after.event_instance_id).toBe(before.event_instance_id);
  expect(hub.read("t").bytes.length).toBe(COMMAND_STREAM_BYTES);
  expect(hub.read("t").end).toBe(160 * 64 * 1024);
});
