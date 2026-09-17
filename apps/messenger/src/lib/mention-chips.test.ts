import { expect, test } from "bun:test";
import type { Bot } from "@real-bot/protocol";
import {
  deleteLastMentionOrChar,
  extractActiveMentionChips,
  isBotMentionedInDraft,
  linkifyRosterMentions,
  mentionHref,
  parseMentionHref,
  removeMentionFromDraft,
} from "./mention-chips.ts";

const bot1: Bot = {
  id: "bot-1",
  name: "Researcher",
  duties: "Research topics",
  boundaries: "Stay focused",
  avatar: null,
  model: null,
  provider_id: null,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const bot2: Bot = {
  id: "bot-2",
  name: "Writer",
  duties: "Write text",
  boundaries: "Stay focused",
  avatar: null,
  model: null,
  provider_id: null,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const botsById = new Map<string, Bot>([
  ["bot-1", bot1],
  ["bot-2", bot2],
]);

test("isBotMentionedInDraft detects exact @bot mentions", () => {
  expect(isBotMentionedInDraft("Researcher", "@Researcher please help")).toBe(true);
  expect(isBotMentionedInDraft("Researcher", "hello @Researcher")).toBe(true);
  expect(isBotMentionedInDraft("Researcher", "hello @Researcher!")).toBe(false);
  expect(isBotMentionedInDraft("Researcher", "Researcher without at")).toBe(false);
  expect(isBotMentionedInDraft("Researcher", "email@Researcher.com")).toBe(false);
});

test("extractActiveMentionChips extracts bots and everyone", () => {
  const chips1 = extractActiveMentionChips("@Researcher hello", ["bot-1", "bot-2"], botsById);
  expect(chips1.length).toBe(1);
  expect(chips1[0]!.name).toBe("Researcher");
  expect(chips1[0]!.id).toBe("bot-1");

  const chips2 = extractActiveMentionChips("@everyone @Writer please look", ["bot-1", "bot-2"], botsById);
  expect(chips2.length).toBe(2);
  expect(chips2[0]!.name).toBe("everyone");
  expect(chips2[1]!.name).toBe("Writer");

  const chipsNone = extractActiveMentionChips("no mentions here", ["bot-1", "bot-2"], botsById);
  expect(chipsNone.length).toBe(0);
});

test("removeMentionFromDraft removes mention and preserves remaining text", () => {
  expect(removeMentionFromDraft("@Researcher hello there", "Researcher")).toBe("hello there");
  expect(removeMentionFromDraft("hello @Researcher there", "Researcher")).toBe("hello there");
  expect(removeMentionFromDraft("@everyone please join", "everyone")).toBe("please join");
  expect(removeMentionFromDraft("@Researcher @Writer done", "Researcher")).toBe("@Writer done");
});

test("deleteLastMentionOrChar deletes mention as an atomic whole when cursor is after mention with space", () => {
  const r1 = deleteLastMentionOrChar("@Researcher ", 13, ["Researcher", "Writer"]);
  expect(r1.deletedMention).toBe(true);
  expect(r1.nextText).toBe("");
  expect(r1.nextCursor).toBe(0);

  const r2 = deleteLastMentionOrChar("hello @Researcher ", 18, ["Researcher", "Writer"]);
  expect(r2.deletedMention).toBe(true);
  expect(r2.nextText).toBe("hello ");
  expect(r2.nextCursor).toBe(6);

  const r3 = deleteLastMentionOrChar("@everyone ", 10, ["Researcher", "Writer"]);
  expect(r3.deletedMention).toBe(true);
  expect(r3.nextText).toBe("");
  expect(r3.nextCursor).toBe(0);
});

test("deleteLastMentionOrChar deletes mention as an atomic whole when cursor is after mention without space", () => {
  const r1 = deleteLastMentionOrChar("@Researcher", 11, ["Researcher", "Writer"]);
  expect(r1.deletedMention).toBe(true);
  expect(r1.nextText).toBe("");
  expect(r1.nextCursor).toBe(0);

  const r2 = deleteLastMentionOrChar("hello @Writer", 13, ["Researcher", "Writer"]);
  expect(r2.deletedMention).toBe(true);
  expect(r2.nextText).toBe("hello ");
  expect(r2.nextCursor).toBe(6);
});

test("mention href round-trips a bot id", () => {
  const href = mentionHref("bot-1");
  expect(href).toBe("bot:bot-1");
  expect(parseMentionHref(href)).toBe("bot-1");
  expect(parseMentionHref("https://example.com")).toBeNull();
});

test("linkifyRosterMentions turns roster names and everyone into bot links", () => {
  const bots = [bot1, bot2];
  const linked = linkifyRosterMentions("@Researcher 请看，再 @everyone", bots);
  expect(linked).toContain(`[@Researcher](${mentionHref("bot-1")})`);
  expect(linked).toContain("[@everyone](bot:everyone)");
  expect(linked).toContain("请看，再");
});

test("linkifyRosterMentions uses the longest roster name and skips code", () => {
  const writerBot = { ...bot2, name: "Writer" };
  const writerBotLong = { ...bot1, id: "bot-long", name: "WriterBot" };
  const linked = linkifyRosterMentions("hi @WriterBot and @Writer and `@Writer`", [writerBot, writerBotLong]);
  expect(linked).toContain(`[@WriterBot](${mentionHref("bot-long")})`);
  expect(linked).toContain(`[@Writer](${mentionHref("bot-2")})`);
  expect(linked).toContain("`@Writer`");
});

test("linkifyRosterMentions leaves unknown names and empty roster alone", () => {
  expect(linkifyRosterMentions("@Nope hello", [bot1])).toBe("@Nope hello");
  expect(linkifyRosterMentions("@Researcher hello", [])).toBe("@Researcher hello");
});

test("deleteLastMentionOrChar deletes single char when cursor is in normal text", () => {
  const r1 = deleteLastMentionOrChar("hello", 5, ["Researcher", "Writer"]);
  expect(r1.deletedMention).toBe(false);
  expect(r1.nextText).toBe("hell");
  expect(r1.nextCursor).toBe(4);

  const r2 = deleteLastMentionOrChar("hello @Researcher world", 23, ["Researcher", "Writer"]);
  expect(r2.deletedMention).toBe(false);
  expect(r2.nextText).toBe("hello @Researcher worl");
  expect(r2.nextCursor).toBe(22);
});

