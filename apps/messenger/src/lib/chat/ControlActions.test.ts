import { expect, test } from "bun:test";
import type { ControlOffer, MessageControl } from "@real-bot/protocol";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aHold } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, render } from "../test-render.ts";
import ControlActions from "./ControlActions.svelte";

const t = copyFor("zh");
const receipt: MessageControl = {
  kind: "receipt",
  verb: "stop",
  hold_ids: ["hold-1"],
  offer: ["undo", "stop_all"],
  scopes: [{ scope: "bot", id: "bot-1" }],
  plans: [{ offer: "only_plan", task_id: "task-1", title: "EP01" }],
};

function mount(result: unknown = null, control: MessageControl = receipt) {
  const pressed: Array<{ action: ControlOffer; taskId?: string }> = [];
  const props = reactive({
    control,
    holds: [aHold()],
    botName: () => "视频导演",
    t,
    onAct: async (action: ControlOffer, taskId?: string) => {
      pressed.push({ action, taskId });
      return result;
    },
  });
  const view = render(ControlActions, props);
  return { ...view, props, pressed };
}

test("a press sends the button and the plan it names, and the row waits for the line to say it was done", async () => {
  const { host, pressed, close } = mount();
  click(buttonByText(host, "只停《EP01》"));
  await tick();
  flushSync();
  expect(pressed).toEqual([{ action: "only_plan", taskId: "task-1" }]);
  // Nothing here remembers the press: the daemon's `acted` on the line does.
  expect(host.querySelector(".control-error")).toBeNull();
  click(buttonByText(host, "撤销"));
  expect(pressed.at(-1)).toEqual({ action: "undo", taskId: undefined });
  close();
});

test("a refusal leaves the row to press again, and says it did not work", async () => {
  const { host, close } = mount({ status: 422 });
  click(buttonByText(host, "撤销"));
  await tick();
  flushSync();
  expect(host.querySelector(".control-error")?.textContent).toBe("没做成，再试一次");
  expect(buttonByText(host, "撤销").disabled).toBe(false);
  close();
});

test("a line already pressed on shows what was done, with no buttons", () => {
  const { host, close } = mount(null, { ...receipt, acted: ["stop_all"] });
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.querySelector(".control-done")?.textContent).toBe("已停下所有 Bot");
  close();
});

test("继续 on a restart notice that a stop kept from some turns says how many went on, until the stops change", async () => {
  const notice: MessageControl = { kind: "restart", cause: "crash", notes: ["note-1", "note-2"], offer: ["resume", "leave"] };
  const { host, props, close } = mount({ partial: { continued: 1, held: 1 } }, notice);
  click(buttonByText(host, "继续"));
  await tick();
  flushSync();
  expect(host.querySelector(".control-error")).toBeNull();
  expect(host.querySelector(".control-note")?.textContent).toBe("1 轮接着做了，1 轮还被叫停扣着，解除后再按「继续」");
  // Still unanswered: 继续 stays to take the rest after the lift.
  expect(buttonByText(host, "继续").disabled).toBe(false);
  // The stop is lifted: the count would no longer be true.
  props.holds = [];
  flushSync();
  expect(host.querySelector(".control-note")).toBeNull();
  close();
});
