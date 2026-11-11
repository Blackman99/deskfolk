/** The annotator's Markdown blocks, read off the engine thread, are the top-level blocks with their lines. */
import { expect, test } from "nsh/test";
import { markdownBlocksOffThread } from "./markdown-blocks";

test("each top-level block with its own source lines", async () => {
  const source = "# Head\r\n\r\npara one\r\nstill one\r\n\r\n- a\r\n\r\n- b\r\n\r\n```js\r\nx\r\n\r\ny\r\n```\r\n";
  const blocks = await markdownBlocksOffThread(source);
  expect(blocks.map((b) => [b.start, b.end])).toEqual([[1, 1], [3, 4], [6, 8], [10, 14]]);
  expect(blocks[1]!.raw).toBe("para one\nstill one");
  expect(blocks[3]!.raw).toBe("```js\nx\n\ny\n```");
});

test("an empty file has no blocks", async () => {
  expect(await markdownBlocksOffThread("")).toEqual([]);
});

test("a long report is read without holding the engine", async () => {
  const section = "## 第 1 节\n\nthe quick brown fox 风沙 客栈 戏台 `code` **bold**\n\n- 列表 1\n- `code` **bold**\n\n";
  const started = Date.now();
  const blocks = await markdownBlocksOffThread(section.repeat(3000));
  expect(blocks.length).toBe(9000);
  expect(Date.now() - started).toBeLessThan(5000);
});
