import { expect, test } from "bun:test";
import type { Bot } from "@real-bot/protocol";
import {
  decorateMentionChips,
  deleteLastMentionOrChar,
  extractActiveMentionChips,
  isBotMentionedInDraft,
  lenientMatch,
  linkifyRosterMentions,
  mentionHref,
  mentionToken,
  parseMentionHref,
  removeMentionFromDraft,
  type MentionableBot,
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
  expect(isBotMentionedInDraft("Researcher", "hello @Researcher!")).toBe(true);
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

test("linkifyRosterMentions leaves empty roster alone and marks unknown names unresolved without a members option", () => {
  expect(linkifyRosterMentions("@Nope hello", [bot1])).toBe(
    `[@Nope](${mentionHref("unresolved:Nope")}) hello`,
  );
  expect(linkifyRosterMentions("@Researcher hello", [])).toBe("@Researcher hello");
});

test("mentionToken mirrors the daemon: stops at whitespace or a delimiter", () => {
  expect(mentionToken("分镜，请出图")).toBe("分镜");
  expect(mentionToken("Researcher hello")).toBe("Researcher");
  expect(mentionToken("")).toBe("");
});

test("lenientMatch mirrors the daemon: unambiguous prefix/suffix, case-insensitive, min two code points", () => {
  expect(lenientMatch("分镜", ["分镜师", "导演"])).toBe("分镜师");
  expect(lenientMatch("镜师", ["分镜师", "导演"])).toBe("分镜师");
  expect(lenientMatch("师", ["分镜师"])).toBeNull();
  expect(lenientMatch("分", ["分镜师", "分析师"])).toBeNull();
  expect(lenientMatch("researcher", ["Writer", "Researcher"])).toBe("Researcher");
});

test("linkifyRosterMentions resolves a lenient prefix match to the full member name", () => {
  const storyboard: MentionableBot = { id: "storyboard-1", name: "分镜师" };
  const director: MentionableBot = { id: "director-1", name: "导演" };
  const linked = linkifyRosterMentions("@分镜 请出图", [storyboard, director], {
    members: [storyboard, director],
  });
  expect(linked).toContain(`[@分镜师](${mentionHref(storyboard.id)})`);
  expect(linked).toContain(" 请出图");
});

test("linkifyRosterMentions resolves a lenient suffix match, case-insensitively", () => {
  const planner: MentionableBot = { id: "planner-1", name: "选题策划" };
  const researcher: MentionableBot = { id: "researcher-1", name: "Researcher" };

  const linkedSuffix = linkifyRosterMentions("@策划 看一下", [planner], { members: [planner] });
  expect(linkedSuffix).toContain(`[@选题策划](${mentionHref(planner.id)})`);

  const linkedCase = linkifyRosterMentions("@researcher 看一下", [researcher], {
    members: [researcher],
  });
  expect(linkedCase).toContain(`[@Researcher](${mentionHref(researcher.id)})`);
});

test("linkifyRosterMentions leaves an ambiguous or too-short token unresolved", () => {
  const storyboard: MentionableBot = { id: "storyboard-1", name: "分镜师" };
  const analyst: MentionableBot = { id: "analyst-1", name: "分析师" };
  const linked = linkifyRosterMentions("@分 看", [storyboard, analyst], {
    members: [storyboard, analyst],
  });
  expect(linked).toContain(`[@分](${mentionHref("unresolved:分")})`);
  expect(linked).not.toContain(`(${mentionHref(storyboard.id)})`);
  expect(linked).not.toContain(`(${mentionHref(analyst.id)})`);
});

test("linkifyRosterMentions stops the token at CJK punctuation and preserves the rest", () => {
  const storyboard: MentionableBot = { id: "storyboard-1", name: "分镜师" };
  // No `members` option: nothing to lenient-match against, so the token surfaces as a marker.
  const linked = linkifyRosterMentions("@分镜，请", [storyboard]);
  expect(linked).toContain(`[@分镜](${mentionHref("unresolved:分镜")})`);
  expect(linked).toContain("，请");
});

test("linkifyRosterMentions leaves an @ before a number, frame or time as plain text instead of an unresolved marker", () => {
  const reviewer: MentionableBot = { id: "reviewer-1", name: "审片" };
  const linked = linkifyRosterMentions(
    "全局峰值 −1.0 dB @37.79s，落掌 @f96、@t37，会议 @14:30，版本 @2026-09-18 发布，@审片 请复核",
    [reviewer],
    { members: [reviewer] },
  );
  expect(linked).toBe(
    `全局峰值 −1.0 dB @37.79s，落掌 @f96、@t37，会议 @14:30，版本 @2026-09-18 发布，[@审片](${mentionHref(reviewer.id)}) 请复核`,
  );
  expect(linked).not.toContain("unresolved:");
});

test("decorateMentionChips renders an unresolved marker span, with or without a title", () => {
  const html = decorateMentionChips(
    `<a href="${mentionHref("unresolved:Nope")}">@Nope</a>`,
    [],
    { unresolvedTitle: "这个 @ 没有匹配到群成员" },
  );
  expect(html).toBe(
    '<span class="md-mention-unresolved" title="这个 @ 没有匹配到群成员">@Nope</span>',
  );

  const htmlNoTitle = decorateMentionChips(`<a href="${mentionHref("unresolved:Nope")}">@Nope</a>`, []);
  expect(htmlNoTitle).toBe('<span class="md-mention-unresolved">@Nope</span>');
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

test("linkifyRosterMentions leaves emails and npm scopes untouched", () => {
  const text = "mail user@host.com and run @sveltejs/kit, then @Researcher";
  const linked = linkifyRosterMentions(text, [bot1], { members: [bot1] });
  expect(linked).toBe(`mail user@host.com and run @sveltejs/kit, then [@Researcher](${mentionHref("bot-1")})`);
});
