import { expect, test } from "bun:test";
import { maskSecrets, plainPreview } from "./preview-text.ts";

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

test("a pasted key keeps its first characters and loses the rest", () => {
  expect(plainPreview("qoder API： pt-lsbP9Y1wElgsCLay3Y4JqWeRtYuI")).toBe("qoder API： pt-l••••");
  expect(maskSecrets("用这个 sk-ant-api03-abcdefghijklmnopqrstuv 试试")).toBe("用这个 sk-a•••• 试试");
  expect(maskSecrets("token=abcdefghijklmnopqrstuvwxyz0123")).toBe("token=abcd••••");
  expect(maskSecrets("密钥：Zx81kLmN0pQrStUvWxYz")).toBe("密钥：Zx81••••");
});

test("ordinary text that merely looks technical is left alone", () => {
  expect(maskSecrets("pt-BR 和 sk-learn 都不是密钥")).toBe("pt-BR 和 sk-learn 都不是密钥");
  expect(maskSecrets("commit dc0d12c4a9f1 已推送")).toBe("commit dc0d12c4a9f1 已推送");
  expect(maskSecrets("password: short")).toBe("password: short");
});
