import { expect, test } from "bun:test";
import { aBot, aBotDirect, aDirect, aMessage, aTurn } from "../test-fixtures.ts";
import { indexBotDmsByOrigin } from "./bot-dm-entries.ts";

const withMessage = (over = {}) => aBotDirect({ last_message: aMessage(), ...over });

test("directs opened from the same message bucket together, oldest first", () => {
  const index = indexBotDmsByOrigin(
    [
      withMessage({ id: "later", created_at: "2026-09-19T03:00:00.000Z" }),
      withMessage({ id: "earlier", created_at: "2026-09-19T01:00:00.000Z" }),
    ],
    "sess-1",
  );
  expect(index.get("msg-1")?.map((s) => s.id)).toEqual(["earlier", "later"]);
});

test("a direct opened from another session is left out", () => {
  const index = indexBotDmsByOrigin([withMessage({ origin_session_id: "sess-2" })], "sess-1");
  expect(index.size).toBe(0);
});

/** Opened before sessions recorded a source: there is no message to hang it under. */
test("a direct with no source is left out", () => {
  const index = indexBotDmsByOrigin(
    [withMessage({ origin_session_id: null, origin_message_id: null })],
    "sess-1",
  );
  expect(index.size).toBe(0);
});

test("an archived direct is left out", () => {
  const index = indexBotDmsByOrigin(
    [withMessage({ archived_at: "2026-09-19T04:00:00.000Z" })],
    "sess-1",
  );
  expect(index.size).toBe(0);
});

test("a you-Bot direct carrying a source is left out", () => {
  const index = indexBotDmsByOrigin(
    [aDirect({ last_message: aMessage(), origin_session_id: "sess-1", origin_message_id: "msg-1" })],
    "sess-1",
  );
  expect(index.size).toBe(0);
});

/** A create_direct that went nowhere should not leave a permanent mark in the transcript. */
test("a direct with nothing to show yet is left out until it has a message or a live turn", () => {
  const empty = aBotDirect({ last_message: null });
  expect(indexBotDmsByOrigin([empty], "sess-1").size).toBe(0);

  const live = indexBotDmsByOrigin([empty], "sess-1", [aTurn({ session_id: "botbot-1" })]);
  expect(live.get("msg-1")?.map((s) => s.id)).toEqual(["botbot-1"]);
});

/**
 * Only the session's own archived_at hides it. An archived bot hides a you-Bot direct, whose
 * peer is you, but a Bot-Bot direct has no such peer and stays readable — the record of what
 * they said does not disappear because one of them was archived afterwards.
 */
test("an archived bot member does not hide the direct", () => {
  const bots = new Map([["bot-1", aBot({ id: "bot-1", archived_at: "2026-09-19T00:00:00.000Z" })]]);
  expect(indexBotDmsByOrigin([withMessage()], "sess-1", [], bots).size).toBe(1);
});

test("no origin session means nothing to index", () => {
  expect(indexBotDmsByOrigin([withMessage()], null).size).toBe(0);
  expect(indexBotDmsByOrigin([], "sess-1").size).toBe(0);
  expect(indexBotDmsByOrigin([withMessage()], "sess-1").get("nope")).toBeUndefined();
});
