import { expect, test } from "bun:test";
import type { AllowRule } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import AllowRulesCard from "./AllowRulesCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rule = (id: string, kind_key: string, scope: string): AllowRule => ({ id, kind_key, scope, created_at: "2026-10-12T00:00:00.000Z" });

test("each Always allow reads as what it lets Bots do and where; Remove takes it back (ADR 0087)", async () => {
  const removed: string[] = [];
  const view = render(AllowRulesCard, {
    rules: [rule("r1", "outside-write", "/Users/me/my-projects/sveltepress"), rule("r2", "unconstrained-shell", "*")],
    t,
    onRemove: async (id: string) => { removed.push(id); },
  });
  const rows = [...view.host.querySelectorAll("[data-testid='allow-rules'] li")];
  expect(rows.map((row) => row.querySelector(".allow-rule-kind")?.textContent)).toEqual([t.settings.allowRuleKinds["outside-write"], t.settings.allowRuleKinds["unconstrained-shell"]]);
  expect(rows.map((row) => row.querySelector(".allow-rule-scope")?.textContent)).toEqual(["/Users/me/my-projects/sveltepress", t.settings.allowRuleAnywhere]);
  click(view.host.querySelector("[data-testid='allow-rule-remove-r1']"));
  await sleep(0);
  expect(removed).toEqual(["r1"]);
  view.close();
});

test("a removal that did not go through says so on its row; no rules reads as how one gets here", async () => {
  const view = render(AllowRulesCard, { rules: [rule("r1", "outside-read", "/data")], t, onRemove: async () => { throw new Error("offline"); } });
  click(view.host.querySelector("[data-testid='allow-rule-remove-r1']"));
  await sleep(0);
  expect(view.host.querySelector("li .field-error")?.textContent).toBe(t.settings.allowRuleRemoveFailed);
  view.close();
  const empty = render(AllowRulesCard, { rules: [], t, onRemove: async () => {} });
  expect(empty.host.textContent).toContain(t.settings.allowRulesEmpty);
  empty.close();
});
