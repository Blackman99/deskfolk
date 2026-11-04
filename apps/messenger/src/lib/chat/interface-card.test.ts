import { expect, test } from "bun:test";
import { parseInterfaceCard } from "./interface-card.ts";

test("reads head, reason, change lines and the patch", () => {
  const card = parseInterfaceCard(["改界面", "理由：太亮了", "- 暗色 --bg → #111", "- 专注模式 开", "@@patch", '{"behaviour":{"focus_mode":true}}'].join("\n"));
  expect(card.head).toBe("改界面");
  expect(card.reason).toBe("理由：太亮了");
  expect(card.changes).toEqual(["暗色 --bg → #111", "专注模式 开"]);
  expect(card.patch).toEqual({ behaviour: { focus_mode: true } });
  expect(card.restore).toBeNull();
});

test("a restore card names the revision", () => {
  const card = parseInterfaceCard(["Change the interface", "Reason: back", "- x", "@@patch", '{"restore":"r1"}'].join("\n"));
  expect(card.restore).toBe("r1");
  expect(card.patch).toBeNull();
});

test("no marker or bad JSON leaves the patch null", () => {
  expect(parseInterfaceCard("改界面\n理由：x\n- a").patch).toBeNull();
  expect(parseInterfaceCard("改界面\n@@patch\n{oops").patch).toBeNull();
  expect(parseInterfaceCard("改界面\n@@patch\n[1]").patch).toBeNull();
  expect(parseInterfaceCard("").head).toBe("");
});
