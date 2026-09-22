import { expect, test } from "bun:test";
import { isNonReceiptPath } from "./index.ts";

/**
 * Both ends read this. If a client ever treats a terminal write as an ordinary mutation it will
 * hold a slot per `METHOD path` and refuse the second keystroke while the first is in flight —
 * which shows up as a terminal that silently drops every other character.
 */
test("terminal writes and model probes carry no receipt", () => {
  expect(isNonReceiptPath("/v1/models/probe")).toBe(true);
  expect(isNonReceiptPath("/v1/notification-presence")).toBe(true);
  expect(isNonReceiptPath("/v1/terminals")).toBe(true);
  expect(isNonReceiptPath("/v1/terminals/01J0000000000000000000000B/input")).toBe(true);
  expect(isNonReceiptPath("/v1/terminals/01J0000000000000000000000B/scrollback?from=42")).toBe(true);
});

test("everything that writes a durable row still does", () => {
  for (const path of [
    "/v1/sessions/01J0000000000000000000000B/messages",
    "/v1/bots",
    "/v1/settings",
    "/v1/workspace/file",
    "/v1/terminalsomething",
  ]) {
    expect(isNonReceiptPath(path)).toBe(false);
  }
});
