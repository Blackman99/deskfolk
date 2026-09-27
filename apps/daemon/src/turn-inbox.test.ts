import { describe, expect, test } from "bun:test";
import { heardNote, redirectCarryNote } from "./turn-inbox";

describe("what a heard line says about itself", () => {
  test("a line from another job or session names both; a plain one and a check-back keep their shape", () => {
    const note = heardNote("zh", [
      { author: "Researcher", body: "@Writer 接口好了", checkBack: false },
      { author: "user", body: "标题别太长", checkBack: false, tag: "〔规划「周报」· 任务 02〕", where: "用户和Writer的私聊" },
      { author: "", body: "看看 Reviewer 回了没", checkBack: true, tag: "〔任务 03〕" },
    ]);
    expect(note).toContain("\n【Researcher】@Writer 接口好了\n");
    expect(note).toContain("\n【user，在用户和Writer的私聊里】〔规划「周报」· 任务 02〕标题别太长\n");
    expect(note).toContain("\n【你约的回看】〔任务 03〕看看 Reviewer 回了没\n");
  });

  test("English says where in its own words", () => {
    const note = heardNote("en", [
      { author: "user", body: "keep the title short", checkBack: false, tag: '〔plan "report"〕', where: "your direct with the user" },
    ]);
    expect(note).toContain('\n【user, in your direct with the user】〔plan "report"〕keep the title short\n');
  });

  test("a redirect says which job the old turn was on, and unread lines keep their tags", () => {
    const zh = redirectCarryNote("zh", {
      written: ["draft.md"],
      recent: [],
      unread: [{ author: "Reviewer", body: "第二段再看看", checkBack: false, tag: "〔任务 02〕" }],
      previous: "〔规划「周报」· 任务 01〕",
    })!;
    expect(zh).toContain("它在做的是〔规划「周报」· 任务 01〕。");
    expect(zh).toContain("还没读到的——【Reviewer】〔任务 02〕第二段再看看");
    const en = redirectCarryNote("en", { written: ["draft.md"], recent: [], unread: [], previous: '〔plan "report"〕' })!;
    expect(en).toContain('It was working on 〔plan "report"〕.');
    // Nothing done and nothing unread: a plan alone is no reason for a note.
    expect(redirectCarryNote("zh", { written: [], recent: [], unread: [], previous: "〔规划「周报」〕" })).toBeNull();
  });
});
