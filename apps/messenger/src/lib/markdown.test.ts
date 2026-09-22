import { expect, test } from "bun:test";
import { parseArtifactHref } from "./overlays/artifacts.ts";
import { renderMarkdown } from "./markdown.ts";

test("complete markdown turns emphasis and a fenced block into HTML", () => {
  const html = renderMarkdown("**hello** from `Writer`\n\n```js\nconst x = 1\n```");
  expect(html).toContain("<strong>hello</strong>");
  expect(html).toContain("<code>Writer</code>");
  expect(html).toContain("<pre>");
  expect(html).toContain("const x = 1");
  expect(html).not.toContain("**hello**");
});

test("a GFM table becomes table markup with header and body cells", () => {
  const html = renderMarkdown("| 镜号 | 判 |\n| --- | --- |\n| 1A | 通过 |");
  expect(html).toContain("<table>");
  expect(html).toContain("<th>");
  expect(html).toContain("镜号");
  expect(html).toContain("<td>");
  expect(html).toContain("1A");
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

test("CJK workspace links round-trip through marked encoding", () => {
  const path = "inbox/制片交接-转审片-v5.md";
  const html = renderMarkdown(`见 [${path}](${path})`);
  const href = html.match(/href="([^"]+)"/)?.[1];
  expect(href).toBeTruthy();
  expect(parseArtifactHref(href ?? "")).toBe(path);
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

test("unknown @tokens become unresolved markers, not chips, without a members option", () => {
  const html = renderMarkdown("邮箱 user@host.com，以及 @路人", {
    mentionBots: [{ id: "pm-1", name: "产品经理", avatar: null }],
  });
  expect(html).toContain("user@host.com");
  expect(html).not.toContain("@host</span>");
  expect(html).toContain('<span class="md-mention-unresolved">@路人</span>');
  expect(html).not.toContain("md-mention-chip");
});

test("unresolved @tokens carry the configured title, and lenient members resolve to their full name", () => {
  const storyboard = { id: "storyboard-1", name: "分镜师", avatar: null };
  const html = renderMarkdown("@分镜 请出图，@路人 你好", {
    mentionBots: [storyboard],
    mentionMembers: [storyboard],
    unresolvedMentionTitle: "这个 @ 没有匹配到群成员",
  });
  expect(html).toContain('class="md-mention-chip"');
  expect(html).toContain('href="bot:storyboard-1"');
  expect(html).toContain("@分镜师");
  expect(html).toContain(
    '<span class="md-mention-unresolved" title="这个 @ 没有匹配到群成员">@路人</span>',
  );
});

test("the same text under a different roster is rendered again, not served from the cache", () => {
  const source = "@分镜师 看一下";
  const storyboard = { id: "storyboard-1", name: "分镜师" };
  const plain = renderMarkdown(source, { mentionBots: [] });
  const mentioned = renderMarkdown(source, { mentionBots: [storyboard], mentionMembers: [storyboard] });
  expect(plain).not.toContain("md-mention-chip");
  expect(mentioned).toContain('href="bot:storyboard-1"');
  // A repeat of either one is the same HTML; the cache keys on what reached the renderer.
  expect(renderMarkdown(source, { mentionBots: [] })).toBe(plain);
  expect(renderMarkdown(source, { mentionBots: [storyboard], mentionMembers: [storyboard] })).toBe(mentioned);
  // A rename is a different roster, so the chip label follows it.
  const renamed = renderMarkdown(source, {
    mentionBots: [{ id: "storyboard-1", name: "分镜" }],
    mentionMembers: [{ id: "storyboard-1", name: "分镜" }],
  });
  expect(renamed).not.toBe(mentioned);
});

test("external links render with external link marker and class, distinguishing internal file links", () => {
  const html = renderMarkdown("查看 [官网](https://example.com/docs) 和代码 [entry](src/index.ts)");
  expect(html).toContain('class="md-external-link"');
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain('class="md-external-icon"');
  expect(html).toContain("<svg");

  expect(html).toContain('class="md-artifact-link"');
  expect(html).toContain('href="artifact:src%2Findex.ts"');
  expect(html).not.toContain('class="md-artifact-link"><span class="md-external-icon"');
});

test("autolinked plain URLs also gain the external link class and marker", () => {
  const html = renderMarkdown("访问 https://x.com/realbot 获取更多信息");
  expect(html).toContain('class="md-external-link"');
  expect(html).toContain('href="https://x.com/realbot"');
  expect(html).toContain('class="md-external-icon"');
});
