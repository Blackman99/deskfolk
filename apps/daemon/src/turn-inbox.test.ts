import { describe, expect, test } from "bun:test";
import { heardNote, redirectCarryNote } from "./turn-inbox";

describe("what a heard line says about itself", () => {
  test("a line from another job or session names both; a plain one and a check-back keep their shape", () => {
    const note = heardNote("zh", [
      { author: "Researcher", body: "@Writer 接口好了", checkBack: false },
      { author: "user", body: "标题别太长", checkBack: false, tag: "〔规划「周报」· 任务 02〕", where: "用户和Writer的私聊", label: "U2" },
      { author: "", body: "看看 Reviewer 回了没", checkBack: true, tag: "〔任务 03〕" },
    ]);
    expect(note).toContain("收件 3 条（这一段没有被打断）");
    expect(note).toContain("\n【Researcher】@Writer 接口好了\n");
    expect(note).toContain("\n[U2 user，在用户和Writer的私聊里] 〔规划「周报」· 任务 02〕标题别太长\n");
    expect(note).toContain("\n【你约的回看】〔任务 03〕看看 Reviewer 回了没\n");
    expect(note).toContain("写进 end_turn 的 inbox");
  });

  test("English says where in its own words", () => {
    const note = heardNote("en", [
      { author: "user", body: "keep the title short", checkBack: false, tag: '〔plan "report"〕', where: "your direct with the user" },
    ]);
    expect(note).toContain('\n【user, in your direct with the user】〔plan "report"〕keep the title short\n');
    expect(note).toContain("1 line came in");
    expect(note).toContain("end_turn's inbox");
  });

  // ADR 0040 P1: heardNote used to tell the Bot to carry on and not stop working to
  // reply; pinned here so a later edit cannot quietly bring either clause back.
  test("never tells the Bot to carry on or to not stop for a reply", () => {
    const zh = heardNote("zh", [{ author: "Researcher", body: "接口好了", checkBack: false }]);
    for (const phrase of ["接着干", "不要为了回复停下"]) expect(zh).not.toContain(phrase);
    const en = heardNote("en", [{ author: "Researcher", body: "the API is ready", checkBack: false }]);
    expect(en.toLowerCase()).not.toContain("carry on");
    expect(en).not.toContain("do not stop the work in hand");
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
