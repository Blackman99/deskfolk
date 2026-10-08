import { expect, test } from "bun:test";
import type { Message, Turn } from "@real-bot/protocol";
import { queuedLine } from "./queued-line.ts";
import { canEditMessage } from "./message-edit.ts";

function line(partial: Partial<Message> = {}): Message {
  return {
    id: "m1", session_id: "s1", turn_id: null, parent_id: null, kind: "user", author: "user", body: "换成竖版",
    source_turn_id: null, created_at: "t1", attachments: [], reactions: [],
    delivery: { bot_id: "b1", state: "queued", hop: null, note: null }, ...partial,
  };
}

function turn(partial: Partial<Turn> = {}): Turn {
  return { id: "t1", session_id: "s1", bot_id: "b1", status: "running", trigger_message_id: "m0", created_at: "t0", ...partial } as Turn;
}

const here = { queuedLineActions: true, connected: true, lockedComposer: false, turnsHere: [turn()] };

test("a line waiting for its working Bot's next step can be read now or taken back", () => {
  expect(queuedLine(line(), here)).toEqual({ wait: "next_step", canInsert: true, canWithdraw: true });
});

test("waiting for the Bot's next turn, or held by a stop, it can only be taken back", () => {
  expect(queuedLine(line(), { ...here, turnsHere: [] })).toEqual({ wait: "its_turn", canInsert: false, canWithdraw: true });
  // A read-only answer, or a turn waiting on you, has no step to cut for it; nor has another Bot's.
  for (const other of [turn({ mode: "readonly" }), turn({ status: "waiting_approval" }), turn({ bot_id: "b2" })]) {
    expect(queuedLine(line(), { ...here, turnsHere: [other] })?.canInsert).toBe(false);
  }
  const held = line({ delivery: { bot_id: "b1", state: "held", hop: null, note: null } });
  expect(queuedLine(held, here)).toEqual({ wait: "held", canInsert: false, canWithdraw: true });
});

test("a line read, taken back, carried out by the app, or not yours shows no row", () => {
  for (const state of ["delivered", "adopted", "unacked", "withdrawn"] as const) {
    expect(queuedLine(line({ delivery: { bot_id: "b1", state, hop: 2, note: null } }), here)).toBeNull();
  }
  expect(queuedLine(line({ delivery: undefined }), here)).toBeNull();
  expect(queuedLine(line({ withdrawn_at: "t2" }), here)).toBeNull();
  expect(queuedLine(line({ taken_as: "app" }), here)).toBeNull();
  expect(queuedLine(line({ kind: "bot", author: "b1" }), here)).toBeNull();
  // An older daemon can do neither.
  expect(queuedLine(line(), { ...here, queuedLineActions: false })).toBeNull();
});

test("offline, or where you cannot write, the row stays but its buttons do not", () => {
  expect(queuedLine(line(), { ...here, connected: false })).toEqual({ wait: "next_step", canInsert: false, canWithdraw: false });
  expect(queuedLine(line(), { ...here, lockedComposer: true })).toEqual({ wait: "next_step", canInsert: false, canWithdraw: false });
});

test("a line you took back is no longer offered for changing: you send it again instead", () => {
  expect(canEditMessage(line({ withdrawn_at: "t2" }), { messageEdits: true, connected: true, lockedComposer: false, annotated: false })).toBe(false);
});
