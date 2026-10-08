/**
 * Changing a line of yours from the runtime (ADR 0063): the bubble's editor state lives on the
 * conversation's view; a save installs the line as it now reads and closes the editor, a refusal
 * stays under it with your words, and what the line said before is read once per change.
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

test("a save sends the new words, shows the line as it comes back, and closes the editor", async () => {
  const original = aMessage({ id: "msg-1", session_id: session, kind: "user", author: "user", body: "片长 30 秒" });
  const changed = { ...original, body: "片长 45 秒", edited_at: "2026-10-06T03:00:00.000Z" };
  const requests: unknown[] = [];
  const runtime = connected({ patch: async (path: string, body: unknown) => { requests.push([path, body]); return changed; } });
  runtime.snapshot.messages = [original];
  runtime.snapshot.sessions = [aDirect({ id: session, last_message: original })];
  runtime.startEdit(session, original);
  const view = runtime.sessionView(session);
  expect(view).toMatchObject({ editingMessageId: "msg-1", editDraft: "片长 30 秒" });
  view.editDraft = "片长 45 秒";
  expect(await runtime.saveEdit(session)).toBe(true);
  expect(requests).toEqual([["/v1/messages/msg-1", { body: "片长 45 秒" }]]);
  expect(runtime.snapshot.messages[0]).toEqual(changed);
  expect(view).toMatchObject({ editingMessageId: null, editDraft: "", editSaving: false, editError: null });
});

test("the same words close the editor with nothing sent; empty words are refused before any request", async () => {
  const original = aMessage({ id: "msg-1", session_id: session, kind: "user", author: "user", body: "片长 30 秒" });
  let sent = 0;
  const runtime = connected({ patch: async () => { sent += 1; return original; } });
  runtime.snapshot.messages = [original];
  runtime.startEdit(session, original);
  expect(await runtime.saveEdit(session)).toBe(true);
  expect(runtime.sessionView(session).editingMessageId).toBeNull();

  runtime.startEdit(session, original);
  runtime.sessionView(session).editDraft = "   ";
  expect(await runtime.saveEdit(session)).toBe(false);
  expect(runtime.sessionView(session)).toMatchObject({ editingMessageId: "msg-1", editError: "empty" });
  expect(sent).toBe(0);
});

test("a refusal or a dropped link is said under the editor, and the words you typed stay", async () => {
  const original = aMessage({ id: "msg-1", session_id: session, kind: "user", author: "user", body: "片长 30 秒" });
  const runtime = connected({ patch: async () => { throw new ApiError(422, "not_editable", "the app already carried this line out"); } });
  runtime.snapshot.messages = [original];
  runtime.startEdit(session, original);
  runtime.sessionView(session).editDraft = "片长 45 秒";
  expect(await runtime.saveEdit(session)).toBe(false);
  expect(runtime.sessionView(session)).toMatchObject({ editingMessageId: "msg-1", editDraft: "片长 45 秒", editError: "not_editable", editSaving: false });
  expect(runtime.snapshot.messages[0]).toEqual(original);

  runtime.connection = "disconnected";
  expect(await runtime.saveEdit(session)).toBe(false);
  expect(runtime.sessionView(session).editError).toBe("failed");
  runtime.cancelEdit(session);
  expect(runtime.sessionView(session)).toMatchObject({ editingMessageId: null, editDraft: "", editError: null });
});

test("what a line said before is read once per change of it", async () => {
  const paths: string[] = [];
  let versions = [{ body: "片长 30 秒", created_at: "t1" }];
  const runtime = connected({ get: async (path: string) => { paths.push(path); return { versions }; } });
  expect(await runtime.messageVersions("msg-1", "t2")).toEqual([{ body: "片长 30 秒", created_at: "t1" }]);
  expect(await runtime.messageVersions("msg-1", "t2")).toEqual([{ body: "片长 30 秒", created_at: "t1" }]);
  expect(paths).toEqual(["/v1/messages/msg-1/versions"]);
  versions = [...versions, { body: "片长 45 秒", created_at: "t2" }];
  expect(await runtime.messageVersions("msg-1", "t3")).toHaveLength(2);
  expect(paths).toHaveLength(2);
  Reflect.set(runtime, "api", fakeApi({ get: async () => { throw new Error("down"); } }));
  expect(await runtime.messageVersions("msg-2", "t1")).toBeNull();
});
