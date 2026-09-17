import { expect, test } from "bun:test";
import { canQuoteReply, draftWithQuoteMention, quotedBotName, quotePreview } from "./quote-reply.ts";

test("only main user and bot lines can be quoted", () => {
  expect(canQuoteReply({ kind: "bot", parent_id: null })).toBe(true);
  expect(canQuoteReply({ kind: "user", parent_id: null })).toBe(true);
  expect(canQuoteReply({ kind: "bot", parent_id: "m1" })).toBe(false);
  expect(canQuoteReply({ kind: "system", parent_id: null })).toBe(false);
  expect(canQuoteReply({ kind: "ask", parent_id: null })).toBe(false);
});

test("quotePreview collapses whitespace and ellipsizes", () => {
  expect(quotePreview("hello   world")).toBe("hello world");
  expect(quotePreview("a".repeat(90)).endsWith("…")).toBe(true);
  expect([...quotePreview("a".repeat(90))].length).toBe(81);
});

test("quotedBotName is the roster name, never user", () => {
  const bots = new Map([["w1", { name: "Writer" }]]);
  expect(quotedBotName({ author: "w1" }, bots)).toBe("Writer");
  expect(quotedBotName({ author: "user" }, bots)).toBeNull();
  expect(quotedBotName({ author: "gone" }, bots)).toBeNull();
});

test("draftWithQuoteMention prepends @Name once", () => {
  expect(draftWithQuoteMention("", "Writer")).toBe("@Writer ");
  expect(draftWithQuoteMention("please revise", "Writer")).toBe("@Writer please revise");
  expect(draftWithQuoteMention("@Writer already", "Writer")).toBe("@Writer already");
});
