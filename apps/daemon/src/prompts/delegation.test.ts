import { expect, test } from "bun:test";
import { builtinTools, turnSystemPrompt } from "../prompts";

test("P4c tool and system contracts describe real delegation and nonterminal progress without legacy wake promises", () => {
  const names = builtinTools("en", 3).map((tool) => tool.function.name);
  expect(names).toContain("delegate");
  // Back from ADR 0091: a direct a Bot opens itself, to tell or talk something over.
  expect(names).toContain("create_direct");
  for (const locale of ["zh", "en"] as const) {
    const prompt = turnSystemPrompt({ locale, name: "Writer", duties: "write", boundaries: "none", interrupt: false, engineLevel: 3 });
    expect(prompt).toContain("delegate");
    expect(prompt).toContain("end_turn");
    expect(prompt).not.toContain("send_message ends this turn");
    expect(prompt).not.toContain("send_message 会结束本轮");
    // Every line wakes only in a direct opened with create_direct; a delegation thread's words never do.
    expect(prompt).not.toContain("In a Bot↔Bot direct every line you post wakes the other Bot");
    expect(prompt).not.toContain("Bot↔Bot 私聊里你发的每句话都会叫醒对方");
    expect(prompt).toContain(locale === "en"
      ? "Plain words in a Bot pair's delegation thread never wake the other Bot. In a direct you opened with create_direct every line you post wakes the other Bot:"
      : "委派线程里普通发言从不叫醒对方；你用 create_direct 开的私聊里，你发的每句话都会叫醒对方：");
  }
});

test("create_direct says when to use it instead of delegate or a group", () => {
  for (const locale of ["zh", "en"] as const) {
    const description = builtinTools(locale, 8).find((tool) => tool.function.name === "create_direct")!.function.description;
    expect(description).toContain("delegate");
    expect(description).toContain("create_group");
  }
});

test("blocked is described as a question to the user, and waiting on another Bot as delegate or nothing_new", () => {
  for (const locale of ["zh", "en"] as const) {
    const endTurn = builtinTools(locale, 3).find((tool) => tool.function.name === "end_turn")!.function.description;
    const prompt = turnSystemPrompt({ locale, name: "Writer", duties: "write", boundaries: "none", interrupt: false, engineLevel: 3 });
    for (const text of [endTurn, prompt]) {
      expect(text).toContain(locale === "en" ? "blocked is only for what the user alone can give" : "blocked 只用于只有用户能给的东西");
      expect(text).toContain(locale === "en" ? "Waiting on another Bot is not blocked" : "等别的 Bot 不算 blocked");
    }
  }
});
