/**
 * Taking back a line of yours no Bot has read, and having one read now, from the runtime (ADR 0069):
 * the line shows as it comes back; taken back, its words wait in an empty box; what came of a press
 * that did nothing is said under the line.
 */
import { afterEach, expect, test } from "bun:test";
import { ApiError } from "./api.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { fakeApi } from "./test-mocks.ts";
import { aDirect, aMessage } from "./test-fixtures.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.destroy(); });

function connected(api: object): MessengerRuntime {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  Reflect.set(runtime, "api", fakeApi(api));
  runtime.connection = "connected";
  return runtime;
}

const session = "sess-1";
const queued = () => aMessage({ id: "msg-1", session_id: session, kind: "user", author: "user", body: "换成竖版", parent_id: "bot-line",
  delivery: { bot_id: "bot-1", state: "queued", hop: null, note: null } });

test("taken back, the line shows so at once, and its words and the line it quoted wait in the empty box", async () => {
  const line = queued();
  const taken = { ...line, withdrawn_at: "2026-10-08T04:00:00.000Z", delivery: { ...line.delivery!, state: "withdrawn" as const } };
  const requests: unknown[] = [];
  const runtime = connected({ post: async (path: string, body: unknown) => { requests.push([path, body]); return taken; } });
  runtime.snapshot.messages = [line];
  runtime.snapshot.sessions = [aDirect({ id: session, last_message: line })];
  expect(await runtime.withdrawLine(session, line)).toBe(true);
  expect(requests).toEqual([["/v1/messages/msg-1/withdraw", {}]]);
  expect(runtime.snapshot.messages[0]).toEqual(taken);
  expect(runtime.sessionView(session)).toMatchObject({ draft: "换成竖版", replyingToId: "bot-line", lineAction: null, lineNote: null });
});

test("whatever you typed meanwhile stays: taking it back leaves the box alone, 重新编辑 adds the words after", async () => {
  const line = queued();
  const runtime = connected({ post: async () => ({ ...line, withdrawn_at: "t" }) });
  runtime.snapshot.messages = [line];
  runtime.sessionView(session).draft = "另一句";
  await runtime.withdrawLine(session, line);
  expect(runtime.sessionView(session).draft).toBe("另一句");
  expect(runtime.refillLine(session, line, { append: true })).toBe(true);
  expect(runtime.sessionView(session).draft).toBe("另一句\n换成竖版");
  // Pressed again, or right after taking it back: the words are in the box already.
  expect(runtime.refillLine(session, line, { append: true })).toBe(false);
  expect(runtime.sessionView(session).draft).toBe("另一句\n换成竖版");
});

test("a line a Bot read meanwhile cannot be taken back, and that is said under it", async () => {
  const line = queued();
  const runtime = connected({ post: async () => { throw new ApiError(409, "already_read", "a Bot has already read this line"); } });
  runtime.snapshot.messages = [line];
  expect(await runtime.withdrawLine(session, line)).toBe(false);
  expect(runtime.sessionView(session)).toMatchObject({ lineNote: { id: "msg-1", code: "already_read" }, lineAction: null, draft: "" });

  runtime.connection = "disconnected";
  expect(await runtime.withdrawLine(session, line)).toBe(false);
  expect(runtime.sessionView(session).lineNote).toEqual({ id: "msg-1", code: "failed" });
});

test("read now: nothing to say when a step was cut, and a note when none could be", async () => {
  const line = queued();
  let inserted = 1;
  const paths: string[] = [];
  const runtime = connected({ post: async (path: string) => { paths.push(path); return { message: line, inserted }; } });
  runtime.snapshot.messages = [line];
  expect(await runtime.insertLine(session, line)).toBe(true);
  expect(paths).toEqual(["/v1/messages/msg-1/insert"]);
  expect(runtime.sessionView(session).lineNote).toBeNull();
  inserted = 0;
  expect(await runtime.insertLine(session, line)).toBe(false);
  expect(runtime.sessionView(session).lineNote).toEqual({ id: "msg-1", code: "not_now" });
});
