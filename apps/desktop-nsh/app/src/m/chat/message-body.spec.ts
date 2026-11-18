import { expect, test } from "bun:test";
import { messageDisplayBody } from "./message-body.ts";
import { linkifyWorkspacePaths } from "../overlays/artifacts.ts";

const paths = ["work/审片/a.jpg", "work/审片/b.jpg"];
const inventory = paths.map((path) => `[${path}](${path})`).join("\n");

test("old trailing inventories are represented by attachment entries", () => {
  const prose = "仍在核验。\n\n审片参考：[a.jpg](work/审片/a.jpg)\n\n以正式报告为准。";
  expect(messageDisplayBody(`${prose}\n\n${inventory}`, paths)).toBe(prose);
  expect(messageDisplayBody(inventory, paths)).toBe("");
  expect(messageDisplayBody(`${inventory}\n\n`, paths)).toBe("");
});

test("keeps contextual links, described lists, tables and uncovered paths", () => {
  for (const body of [
    inventory,
    `[审片拼版](${paths[0]})`,
    `- [${paths[0]}](${paths[0]})：仍在核验`,
    `| [${paths[0]}](${paths[0]}) | 待检查 |`,
    `${inventory}\n\n这里的顺序是审片顺序。`,
  ]) {
    expect(messageDisplayBody(body, body === inventory ? [] : paths)).toBe(body);
  }
  const uncovered = "[work/other.jpg](work/other.jpg)";
  expect(messageDisplayBody(`${uncovered}\n${inventory}`, paths)).toBe(uncovered);
});

test("keeps path lists inside closed and unfinished code fences", () => {
  for (const marker of ["```", "~~~~"]) {
    for (const suffix of ["", `\n${marker}`]) {
      const body = `${marker}text\n${inventory}${suffix}`;
      expect(messageDisplayBody(body, paths)).toBe(body);
    }
  }
});

test("attachment declarations still become entries and do not return through markdown", () => {
  const body = `完成。\n附件：${paths[0]}\n附件：${paths[1]}`;
  const display = messageDisplayBody(body, []);
  expect(display).toBe("完成。");
  expect(linkifyWorkspacePaths(display, paths)).toBe("完成。");
  expect(linkifyWorkspacePaths("", paths)).toBe("");
  expect(linkifyWorkspacePaths(`查看 ${paths[0]}`, paths)).toBe(`查看 [${paths[0]}](${paths[0]})`);
});

const job = "work/2026-09-24-日报-jgmb";
const delivered = [`${job}/art_crispr_1.jpg`, `${job}/AI_Daily_News.png`, `${job}/template/daily_poster.html`];

test("a path the Bot named from its shell's cwd opens the attachment it handed over", () => {
  // What older messages stored: the Bot's shell ran in the work dir, so from there it was just the name.
  const body = [
    "- **海报**：[AI_Daily_News.png](AI_Daily_News.png)（2.4 MB）",
    "- **底图**：`art_crispr_1.jpg`",
    "- **模板**：[template/daily_poster.html](./template/daily_poster.html)",
  ].join("\n");
  expect(messageDisplayBody(body, delivered)).toBe(
    [
      `- **海报**：[${job}/AI_Daily_News.png](${job}/AI_Daily_News.png)（2.4 MB）`,
      `- **底图**：\`${job}/art_crispr_1.jpg\``,
      `- **模板**：[${job}/template/daily_poster.html](${job}/template/daily_poster.html)`,
    ].join("\n"),
  );
});

test("a cited path stays as written when it is an attachment, matches none, or could be either of two", () => {
  const twins = [`${job}/a/cover.png`, `${job}/b/cover.png`];
  for (const [body, attached] of [
    [`见 [${delivered[0]}](${delivered[0]})`, delivered],
    ["见 [brief.md](brief.md)", delivered],
    ["见 [cover.png](cover.png)", twins],
    // `daily_poster.html` is the tail of a longer path, not a path segment of its own.
    ["见 [poster.html](poster.html)", delivered],
  ] as const) {
    expect(messageDisplayBody(body, attached)).toBe(body);
  }
});

test("a code fence keeps the name it showed", () => {
  const body = "```sh\nopen art_crispr_1.jpg\n```";
  expect(messageDisplayBody(body, delivered)).toBe(body);
});
