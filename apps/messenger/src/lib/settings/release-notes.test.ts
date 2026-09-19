import { expect, test } from "bun:test";
import { plainText, releaseNoteGroups } from "./release-notes.ts";

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
