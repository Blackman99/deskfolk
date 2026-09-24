import { expect, test } from "bun:test";
import type { StreamRead } from "../streams";
import { StreamOutbox } from "./stream-outbox";

const bytes = (length: number, fill = 0x61) => new Uint8Array(length).fill(fill);
const read = (offset: number, data: Uint8Array, over: Partial<StreamRead> = {}): StreamRead =>
  ({ offset, bytes: data, skipped: 0, end: offset + data.length, closed: false, ...over });

/** Every frame the outbox gives, as the link would take them one window at a time. */
function drain(outbox: StreamOutbox, max: number) {
  const frames = [];
  for (let frame = outbox.take(max); frame; frame = outbox.take(max)) frames.push(frame);
  return frames;
}

test("a burst past one frame goes out whole over the windows after, each frame where the last ended", () => {
  // A full-screen program redrawing a few times in one window: this used to lose all but 8 KiB.
  const outbox = new StreamOutbox(128 * 1024);
  outbox.push(read(1000, bytes(12_000)));
  outbox.push(read(13_000, bytes(9_000, 0x62)));
  const frames = drain(outbox, 8192);
  expect(frames.map((frame) => [frame.offset, frame.bytes.length, frame.skipped])).toEqual([
    [1000, 8192, 0],
    [9192, 8192, 0],
    [17_384, 4616, 0],
  ]);
  const all = Buffer.concat(frames.map((frame) => frame.bytes));
  expect(all.length).toBe(21_000);
  expect(all[11_999]).toBe(0x61);
  expect(all[12_000]).toBe(0x62);
  expect(outbox.pending).toBe(false);
});

test("output that outruns the backlog loses its oldest bytes, and the frame says how many", () => {
  const outbox = new StreamOutbox(10_000);
  outbox.push(read(0, bytes(6000)));
  outbox.push(read(6000, bytes(6000, 0x62)));
  const first = outbox.take(8192);
  // 12 000 in, 10 000 kept: the first 2000 went, and the frame starts where what is left does.
  expect(first).toMatchObject({ offset: 2000, skipped: 2000 });
  expect(first!.bytes.length).toBe(8192);
  const second = outbox.take(8192);
  expect(second).toMatchObject({ offset: 10_192, skipped: 0 });
  expect(second!.bytes.length).toBe(1808);
});

test("a read that repeats what was already taken is cut to what is new, sent or not", () => {
  // The backlog a second watcher is handed covers bytes this device already has.
  const outbox = new StreamOutbox(128 * 1024);
  outbox.push(read(0, bytes(100)));
  drain(outbox, 8192);
  outbox.push(read(0, bytes(150)));
  const [frame] = drain(outbox, 8192);
  expect(frame).toMatchObject({ offset: 100, skipped: 0 });
  expect(frame!.bytes.length).toBe(50);
  outbox.push(read(20, bytes(30)));
  expect(outbox.pending).toBe(false);
});

test("a hole is reported as skipped, with what was held before it", () => {
  const outbox = new StreamOutbox(128 * 1024);
  outbox.push(read(0, bytes(100)));
  drain(outbox, 8192);
  outbox.push(read(100, bytes(40)));
  // The ring moved on while this device was away: the next read starts past what it has.
  outbox.push(read(500, bytes(10)));
  const [frame] = drain(outbox, 8192);
  expect(frame).toMatchObject({ offset: 500, skipped: 400 });
  expect(frame!.bytes.length).toBe(10);
});

test("the first read keeps what the ring had already dropped before it", () => {
  const outbox = new StreamOutbox(128 * 1024);
  outbox.push(read(4096, bytes(10), { skipped: 4096 }));
  expect(drain(outbox, 8192)).toMatchObject([{ offset: 4096, skipped: 4096 }]);
});

test("the end rides with the last bytes, and nothing comes after it", () => {
  const outbox = new StreamOutbox(128 * 1024);
  outbox.push(read(0, bytes(9000)));
  outbox.push(read(9000, new Uint8Array(0), { closed: true }));
  const frames = drain(outbox, 8192);
  expect(frames.map((frame) => frame.closed)).toEqual([false, true]);
  expect(outbox.done).toBe(true);
  outbox.push(read(9000, bytes(5)));
  expect(outbox.pending).toBe(false);
});

test("an end with nothing left to send is a frame of its own", () => {
  const outbox = new StreamOutbox(128 * 1024);
  outbox.push(read(0, bytes(10)));
  drain(outbox, 8192);
  outbox.push(read(10, new Uint8Array(0), { closed: true }));
  const [frame] = drain(outbox, 8192);
  expect(frame).toMatchObject({ offset: 10, skipped: 0, closed: true });
  expect(frame!.bytes.length).toBe(0);
});
