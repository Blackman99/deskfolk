import { expect, test } from "bun:test";
import { plainPreview } from "./preview-text.ts";

test("markdown comes off so the row reads as a sentence", () => {
  expect(plainPreview("# 🤖 今日 AI 行业重点简报")).toBe("🤖 今日 AI 行业重点简报");
  expect(plainPreview("已经提交并推到 `main` 了，工作区干净")).toBe("已经提交并推到 main 了，工作区干净");
  expect(plainPreview("- 提交：**dc0d12c** — *已核对*")).toBe("提交：dc0d12c — 已核对");
  expect(plainPreview("见 [站点](https://example.test/me/)")).toBe("见 站点");
  expect(plainPreview("> 引用一句")).toBe("引用一句");
  expect(plainPreview("![](shot.png) 看图")).toBe("[image] 看图");
});

test("a fenced block is named rather than pasted", () => {
  expect(plainPreview("看这段：\n```ts\nconst x = 1;\n```\n就是它")).toBe("看这段： [ts] 就是它");
  expect(plainPreview("```\nplain\n```")).toBe("[code]");
  // An unclosed fence is what a streaming reply looks like mid-sentence.
  expect(plainPreview("开始\n```js\nconst a = 1")).toBe("开始 [js]");
});

test("newlines collapse into one line and the line is bounded", () => {
  expect(plainPreview("第一行\n\n第二行")).toBe("第一行 第二行");
  expect(plainPreview("x".repeat(200)).length).toBe(90);
  expect(plainPreview("x".repeat(200), 10)).toBe("xxxxxxxxxx");
});
