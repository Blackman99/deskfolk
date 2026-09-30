import { expect, test } from "bun:test";
import type { MessageControl } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aHold } from "../test-fixtures.ts";
import { controlBar } from "./control-actions.ts";

const t = copyFor("zh").control;
const names = { bot: (id: string) => ({ "bot-1": "视频导演", "bot-2": "审片员" })[id] ?? "?" };

const receipt: MessageControl = {
  kind: "receipt",
  verb: "stop",
  hold_ids: ["hold-1"],
  offer: ["undo", "stop_all"],
  scopes: [{ scope: "bot", id: "bot-1" }],
  plans: [
    { offer: "stop_plan", task_id: "task-2", title: "回响纪元" },
    { offer: "only_plan", task_id: "task-1", title: "EP01" },
  ],
};

test("a stop's receipt offers undo, widening and narrowing while its stop stands", () => {
  const bar = controlBar(receipt, [aHold()], names, t);
  expect(bar).toEqual({
    state: "ask",
    prompt: null,
    buttons: [
      { action: "undo", label: "撤销", primary: false },
      { action: "stop_all", label: "扩大到所有 Bot", primary: false },
      { action: "stop_plan", taskId: "task-2", label: "一起停下《回响纪元》", primary: false },
      { action: "only_plan", taskId: "task-1", label: "只停《EP01》", primary: false },
    ],
  });
});

test("leaves out what the present already did: everything stopped, the plan stopped, the Bot stop narrowed", () => {
  const everything = aHold({ id: "hold-9", scope: "global", scope_id: null });
  const plan = aHold({ id: "hold-8", scope: "plan", scope_id: "task-2" });
  const narrowed = aHold({ scope: "bot_plan", scope_id: "bot-1:task-1" });
  const bar = controlBar(receipt, [narrowed, everything, plan], names, t);
  expect(bar.state === "ask" ? bar.buttons.map((button) => button.action) : bar).toEqual(["undo"]);
});

test("a receipt whose stops were lifted some other way says so and offers nothing", () => {
  expect(controlBar(receipt, [], names, t)).toEqual({ state: "done", note: "已解除" });
});

test("once pressed, the row says what was done instead of asking again", () => {
  expect(controlBar({ ...receipt, acted: ["undo"] }, [aHold()], names, t)).toEqual({ state: "done", note: "已撤销" });
});

test("your line that might have meant a stop asks, naming the Bot", () => {
  const line: MessageControl = { kind: "possible_control", offer: ["stop"], scopes: [{ scope: "bot", id: "bot-1" }] };
  expect(controlBar(line, [], names, t)).toEqual({
    state: "ask",
    prompt: "这句像是要停下视频导演：",
    buttons: [{ action: "stop", label: "停下视频导演", primary: true }],
  });
  const either: MessageControl = { kind: "possible_control", offer: ["stop", "continue"], scopes: [] };
  expect(controlBar(either, [], names, t)).toMatchObject({ prompt: "这句像是在说停下或继续：" });
  const abandon: MessageControl = { kind: "possible_control", offer: ["stop", "cancel"], scopes: [{ scope: "bot", id: "bot-1" }] };
  expect(controlBar(abandon, [], names, t)).toMatchObject({
    prompt: "要停下，还是作废这件事？",
    buttons: [
      { action: "stop", primary: true },
      { action: "cancel", label: "作废这件事", primary: false },
    ],
  });
});

test("a go on held back by a wider stop offers its two buttons only while that stop stands", () => {
  const status: MessageControl = {
    kind: "status",
    hold_ids: ["hold-9"],
    offer: ["continue_only", "continue_all"],
    scopes: [{ scope: "bot", id: "bot-1" }],
  };
  const wide = aHold({ id: "hold-9", scope: "global", scope_id: null });
  expect(controlBar(status, [wide], names, t)).toMatchObject({
    buttons: [
      { action: "continue_only", label: "只让视频导演继续" },
      { action: "continue_all", label: "全部继续" },
    ],
  });
  expect(controlBar(status, [], names, t)).toEqual({ state: "none" });
  const goOn: MessageControl = { kind: "receipt", verb: "continue", hold_ids: ["hold-1"], held_ids: ["hold-9"], offer: ["continue_only", "continue_all"], scopes: [] };
  expect(controlBar(goOn, [wide], names, t)).toMatchObject({ buttons: [{ label: "只让这里继续" }, { label: "全部继续" }] });
});

test("a restart notice offers to go on or leave it, whatever stops are in force, and says which was pressed", () => {
  const notice: MessageControl = { kind: "restart", cause: "crash", notes: ["cut-1"], offer: ["resume", "leave"] };
  const bar = {
    state: "ask",
    prompt: null,
    buttons: [
      { action: "resume", label: "继续", primary: true },
      { action: "leave", label: "不续", primary: false },
    ],
  };
  expect(controlBar(notice, [], names, t)).toEqual(bar);
  expect(controlBar(notice, [aHold({ scope: "global", scope_id: null })], names, t)).toEqual(bar);
  expect(controlBar({ ...notice, acted: ["resume"] }, [], names, t)).toEqual({ state: "done", note: "已继续" });
  expect(controlBar({ ...notice, acted: ["leave"] }, [], names, t)).toEqual({ state: "done", note: "先放着" });
});
