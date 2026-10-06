import { expect, test } from "bun:test";
import type { Message } from "@real-bot/protocol";
import { canEditMessage, lastEditableLine } from "./message-edit.ts";

function line(partial: Partial<Message> = {}): Message {
  return {
    id: "m1", session_id: "s1", turn_id: null, parent_id: null, kind: "user", author: "user", body: "片长 30 秒",
    source_turn_id: null, created_at: "t1", attachments: [], reactions: [], ...partial,
  };
}

const can = { messageEdits: true, connected: true, lockedComposer: false, annotated: false };

test("only a plain line of yours, while the daemon can take a change and you can write here, offers 编辑", () => {
  expect(canEditMessage(line(), can)).toBe(true);
  expect(canEditMessage(line({ kind: "bot", author: "writer" }), can)).toBe(false);
  expect(canEditMessage(line({ kind: "system" }), can)).toBe(false);
  expect(canEditMessage(line({ taken_as: "app" }), can)).toBe(false);
  expect(canEditMessage(line({ taken_as: "answer" }), can)).toBe(false);
  expect(canEditMessage(line({ annotation_source_message_id: "m0" }), can)).toBe(false);
  expect(canEditMessage(line(), { ...can, annotated: true })).toBe(false);
  expect(canEditMessage(line(), { ...can, messageEdits: false })).toBe(false);
  expect(canEditMessage(line(), { ...can, connected: false })).toBe(false);
  expect(canEditMessage(line(), { ...can, lockedComposer: true })).toBe(false);
});

test("↑ opens your newest line that can be changed, passing over what cannot", () => {
  const lines = [
    line({ id: "a" }),
    line({ id: "b" }),
    line({ id: "reply", kind: "bot", author: "writer" }),
    line({ id: "stop", taken_as: "app" }),
  ];
  const editable = (message: Message) => canEditMessage(message, can);
  expect(lastEditableLine(lines, editable)?.id).toBe("b");
  expect(lastEditableLine([line({ id: "stop", taken_as: "app" })], editable)).toBeNull();
  expect(lastEditableLine([], editable)).toBeNull();
});
