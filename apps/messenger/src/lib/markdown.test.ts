import { expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

test("complete markdown turns emphasis and a fenced block into HTML", () => {
  const html = renderMarkdown("**hello** from `Writer`\n\n```js\nconst x = 1\n```");
  expect(html).toContain("<strong>hello</strong>");
  expect(html).toContain("<code>Writer</code>");
  expect(html).toContain("<pre>");
  expect(html).toContain("const x = 1");
  expect(html).not.toContain("**hello**");
});

test("streaming heals unclosed bold and an unclosed fence so the bubble does not flash raw markers", () => {
  const bold = renderMarkdown("**hel", { streaming: true });
  expect(bold).toContain("<strong>hel</strong>");
  expect(bold).not.toContain("**hel");

  const fence = renderMarkdown("```ts\nconst x = 1", { streaming: true });
  expect(fence).toContain("<pre>");
  expect(fence).toContain("const x = 1");
});

test("finished text is not healed, so leftover markers stay leftover", () => {
  const html = renderMarkdown("**hel");
  expect(html).not.toContain("<strong>");
  expect(html).toContain("**hel");
});

test("script tags and javascript links do not survive sanitizing", () => {
  const script = renderMarkdown("<script>alert(1)</script>ok");
  expect(script).not.toContain("<script>");
  expect(script).toContain("ok");

  const link = renderMarkdown("[click](javascript:alert(1))");
  expect(link).not.toContain("javascript:");
});

test("workspace-relative markdown links become artifact hrefs", () => {
  const html = renderMarkdown("稿在 [mock](out/mock.png) 和 [spec](https://example.com/spec)");
  expect(html).toContain('href="artifact:out%2Fmock.png"');
  expect(html).toContain('href="https://example.com/spec"');
});

test("backticks and extraPaths become clickable artifact links", () => {
  const html = renderMarkdown("写了 `report.md` 和 notes/a.txt", { extraPaths: ["notes/a.txt"] });
  expect(html).toContain('href="artifact:report.md"');
  expect(html).toContain('href="artifact:notes%2Fa.txt"');
});

test("fenced code is not turned into artifact links", () => {
  const html = renderMarkdown("```\nreport.md\n```", { extraPaths: ["report.md"] });
  expect(html).toContain("<pre>");
  expect(html).not.toContain('href="artifact:report.md"');
});

test("roster mentions become avatar chips that link to the bot", () => {
  const html = renderMarkdown("@产品经理 把需求写进 PRD，并 @everyone", {
    mentionBots: [
      { id: "pm-1", name: "产品经理", avatar: null },
      { id: "des-1", name: "设计专家", avatar: null },
    ],
  });
  expect(html).toContain('class="md-mention-chip"');
  expect(html).toContain('href="bot:pm-1"');
  expect(html).toContain("@产品经理");
  expect(html).toContain("chip-avatar-letter");
  expect(html).toContain('class="md-mention-chip is-everyone"');
  expect(html).toContain("@everyone");
  expect(html).not.toContain('href="bot:everyone"');
});

test("mentions inside code are left as text", () => {
  const html = renderMarkdown("看 `@产品经理` 和\n\n```\n@产品经理\n```", {
    mentionBots: [{ id: "pm-1", name: "产品经理", avatar: null }],
  });
  expect(html).toContain("<code>");
  expect(html).toContain("@产品经理");
  expect(html).not.toContain('href="bot:pm-1"');
  expect(html).not.toContain("md-mention-chip");
});

test("unknown @tokens stay plain text", () => {
  const html = renderMarkdown("邮箱 user@host.com，以及 @路人", {
    mentionBots: [{ id: "pm-1", name: "产品经理", avatar: null }],
  });
  expect(html).toContain("@host.com");
  expect(html).toContain("@路人");
  expect(html).not.toContain("md-mention-chip");
});
