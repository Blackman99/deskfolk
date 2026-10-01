import { expect, test } from "bun:test";
import { builtinTools, turnSystemPrompt } from "../prompts";

test("P4c tool and system contracts describe real delegation and nonterminal progress without legacy wake promises", () => {
  const names = builtinTools("en", 3).map((tool) => tool.function.name);
  expect(names).toContain("delegate");
  expect(names).not.toContain("create_direct");
  for (const locale of ["zh", "en"] as const) {
    const prompt = turnSystemPrompt({ locale, name: "Writer", duties: "write", boundaries: "none", interrupt: false, engineLevel: 3 });
    expect(prompt).toContain("delegate");
    expect(prompt).toContain("end_turn");
    expect(prompt).not.toContain("send_message ends this turn");
    expect(prompt).not.toContain("send_message 会结束本轮");
    expect(prompt).not.toContain("every line you post wakes the other Bot");
    expect(prompt).not.toContain("你发的每句话都会叫醒对方");
  }
});
