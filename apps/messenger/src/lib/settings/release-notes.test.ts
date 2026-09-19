import { expect, test } from "bun:test";
import { localeSection, plainText, releaseNoteGroups } from "./release-notes.ts";

const BODY = `未签名的 macOS 快照，不是受支持的签名安装包。

### Daemon

- 本机接口同时听 \`127.0.0.1:17890\` 和 \`[::1]:17890\`。
- 选模型交给 **agent**，不再是正则加权重（见 [ADR 0019](docs/adr/0019-agent-routing-and-review.md)）。

### Messenger

- 新建群改成居中弹窗。

\`\`\`
pnpm install
pnpm dev
\`\`\`
`;

test("the body comes back as its headings and their bullets", () => {
  expect(releaseNoteGroups(BODY)).toEqual([
    {
      heading: "Daemon",
      items: [
        "本机接口同时听 127.0.0.1:17890 和 [::1]:17890。",
        "选模型交给 agent，不再是正则加权重（见 ADR 0019）。",
      ],
    },
    { heading: "Messenger", items: ["新建群改成居中弹窗。"] },
  ]);
});

test("prose and fenced commands are left on the release page", () => {
  const items = releaseNoteGroups(BODY).flatMap((group) => group.items);
  expect(items.some((item) => item.includes("未签名"))).toBe(false);
  expect(items.some((item) => item.includes("pnpm install"))).toBe(false);
});

test("a bullet that arrives before any heading still shows up", () => {
  expect(releaseNoteGroups("- 一条没有分组的说明。")).toEqual([
    { heading: null, items: ["一条没有分组的说明。"] },
  ]);
});

test("a wrapped bullet keeps its tail, on one line", () => {
  expect(releaseNoteGroups("- 第一句，\n  第二句。")).toEqual([
    { heading: null, items: ["第一句， 第二句。"] },
  ]);
});

test("a heading with nothing under it is not a group", () => {
  expect(releaseNoteGroups("### Desktop\n\n只有一段话。")).toEqual([]);
});

test("nothing at all comes back empty", () => {
  expect(releaseNoteGroups(null)).toEqual([]);
  expect(releaseNoteGroups("")).toEqual([]);
  expect(releaseNoteGroups("   \n\n  ")).toEqual([]);
});

test("plainText drops the markers a list cannot show", () => {
  expect(plainText("**粗**、`代码` 和 [链接](https://example.com)")).toBe("粗、代码 和 链接");
  expect(plainText("*斜体* 保留文字")).toBe("斜体 保留文字");
  expect(plainText("  多余   空白  ")).toBe("多余 空白");
});

const BILINGUAL = `<!-- lang:en -->

### Messenger

- the composer locks in a Bot-to-Bot direct.

<!-- lang:zh -->

### Messenger

- Bot↔Bot 私聊里输入框锁上。

<!-- lang:common -->

---

Unsigned macOS snapshot. This is not a supported signed installer.
`;

test("the card shows the section matching the app's locale", () => {
  expect(localeSection(BILINGUAL, "zh")).toContain("Bot↔Bot 私聊里输入框锁上。");
  expect(localeSection(BILINGUAL, "zh")).not.toContain("the composer locks");
  expect(localeSection(BILINGUAL, "en")).toContain("the composer locks");
  expect(localeSection(BILINGUAL, "en")).not.toContain("私聊里输入框锁上");
});

test("every locale gets the common tail", () => {
  for (const locale of ["zh", "en"]) {
    expect(localeSection(BILINGUAL, locale)).toContain("Unsigned macOS snapshot");
  }
});

/** A locale the release was never translated into still gets something to read. */
test("an untranslated locale falls back to english", () => {
  expect(localeSection(BILINGUAL, "fr")).toContain("the composer locks");
});

/**
 * rc.2 and everything before it went out as one untagged language. Those bodies have to keep
 * rendering exactly as they did, or an old release's card goes blank.
 */
test("a body published before the markers existed comes back whole", () => {
  expect(localeSection(BODY, "zh")).toBe(BODY);
  expect(localeSection(BODY, "en")).toBe(BODY);
  expect(releaseNoteGroups(localeSection(BODY, "zh"))).toEqual(releaseNoteGroups(BODY));
});

test("no body is no section", () => {
  expect(localeSection(null, "zh")).toBe("");
  expect(localeSection(undefined, "zh")).toBe("");
  expect(localeSection("", "zh")).toBe("");
});

/** The whole point: the card's groups come out in the locale, headings and all. */
test("the groups the card draws are the locale's", () => {
  const zh = releaseNoteGroups(localeSection(BILINGUAL, "zh"));
  expect(zh).toEqual([{ heading: "Messenger", items: ["Bot↔Bot 私聊里输入框锁上。"] }]);
  const en = releaseNoteGroups(localeSection(BILINGUAL, "en"));
  expect(en).toEqual([
    { heading: "Messenger", items: ["the composer locks in a Bot-to-Bot direct."] },
  ]);
});
