import { expect, test } from "bun:test";
import type { ControlOffer, MessageControl } from "@real-bot/protocol";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, render } from "../test-render.ts";
import ControlActions from "./ControlActions.svelte";

const card: MessageControl = { kind: "plan_opened", task_id: "new-job", turn_id: "turn", quote_message_id: "quote",
  merge_targets: [{ task_id: "ep01", title: "EP01" }], offer: ["undo_plan", "merge_plan"] };

function mount(control: MessageControl = card, failure: unknown = null) {
  const pressed: Array<{ action: ControlOffer; taskId?: string }> = [];
  const props = reactive({ control, holds: [], botName: () => "Writer", t: copyFor("zh"), onAct: async (action: ControlOffer, taskId?: string) => {
    pressed.push({ action, taskId }); return failure;
  } });
  return { ...render(ControlActions, props), pressed, props };
}

test("new-plan Undo is visible but requires confirmation and never uses hold-lifting undo", async () => {
  const h = mount();
  click(buttonByText(h.host, "撤销"));
  flushSync();
  expect(h.pressed).toEqual([]);
  expect(h.host.textContent).toContain("保留文件、原话和需求");
  click(buttonByText(h.host, "确认撤销"));
  await tick(); flushSync();
  expect(h.pressed).toEqual([{ action: "undo_plan", taskId: undefined }]);
  h.close();
});

test("Merge chooses an existing job then explicitly confirms only the quoted-message correction", async () => {
  const h = mount();
  click(buttonByText(h.host, "并入…")); flushSync();
  expect(h.host.textContent).toContain("只改归引用的这句原话");
  expect(buttonByText(h.host, "确认并入").disabled).toBe(true);
  const select = h.host.querySelector("select")!;
  select.value = "ep01"; select.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
  expect(h.pressed).toEqual([]);
  click(buttonByText(h.host, "确认并入")); await tick(); flushSync();
  expect(h.pressed).toEqual([{ action: "merge_plan", taskId: "ep01" }]);
  h.props.control = { ...card, acted: ["merge_plan"], merged_into: "ep01", retained_effects: ["shell"] };
  flushSync();
  expect(h.host.querySelectorAll("button")).toHaveLength(0);
  expect(h.host.textContent).toContain("已开始的操作没有撤回");
  h.close();
});

test("refusal keeps the confirmation retryable and Back performs no action", async () => {
  const h = mount(card, { status: 409 });
  click(buttonByText(h.host, "撤销")); flushSync();
  click(buttonByText(h.host, "返回")); flushSync();
  expect(h.pressed).toEqual([]);
  click(buttonByText(h.host, "撤销")); flushSync();
  click(buttonByText(h.host, "确认撤销")); await tick(); flushSync();
  expect(h.host.textContent).toContain("没做成，再试一次");
  expect(buttonByText(h.host, "确认撤销").disabled).toBe(false);
  h.close();
});

test("no same-project jobs disables Merge and a replayed acted card has no controls", () => {
  const h = mount({ ...card, merge_targets: [] });
  expect(buttonByText(h.host, "并入…").disabled).toBe(true);
  expect(h.host.textContent).toContain("没有可并入的同项目规划");
  h.props.control = { ...card, acted: ["undo_plan"] }; flushSync();
  expect(h.host.querySelectorAll("button")).toHaveLength(0);
  expect(h.host.textContent).toContain("已停下并作废");
  h.close();
});
