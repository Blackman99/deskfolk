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

test("the supervisor's line about a job it stopped moving offers nothing to press", () => {
  const line: MessageControl = { kind: "supervisor", code: "stalled", task_id: "task-1", ticket_id: "ticket-1", work_item_id: "work-1", offer: [] };
  expect(controlBar(line, [], names, t)).toEqual({ state: "none" });
  expect(controlBar({ ...line, code: "unknown_effect" }, [aHold({ scope: "global", scope_id: null })], names, t)).toEqual({ state: "none" });
});

test("the app's line offering a check from your words: 确认 / 改 / 不要, and for a replacement 用新的 / 留原来的", () => {
  const offer: MessageControl = {
    kind: "check",
    event: "proposed",
    check_ids: ["check-1"],
    offer: ["confirm_check", "edit_check", "remove_check"],
    replacing: null,
    edit_draft: "片长改成 ",
  };
  expect(controlBar(offer, [], names, t)).toEqual({
    state: "ask",
    prompt: null,
    buttons: [
      { action: "confirm_check", label: "确认", primary: true },
      { action: "edit_check", label: "改", primary: false },
      { action: "remove_check", label: "不要", primary: false },
    ],
  });
  expect(controlBar({ ...offer, replacing: "check-0" }, [], names, t)).toMatchObject({
    buttons: [{ label: "用新的" }, { label: "改" }, { label: "留原来的" }],
  });
  expect(controlBar(offer, [], names, copyFor("en").control)).toMatchObject({ buttons: [{ label: "Confirm" }, { label: "Change" }, { label: "No" }] });
  // No words to start a line with, no 改.
  expect(controlBar({ ...offer, edit_draft: undefined }, [], names, t)).toMatchObject({ buttons: [{ label: "确认" }, { label: "不要" }] });
  expect(controlBar({ ...offer, acted: ["confirm_check"] }, [], names, t)).toEqual({ state: "done", note: "已确认" });
  expect(controlBar({ ...offer, acted: ["remove_check"] }, [], names, t)).toEqual({ state: "done", note: "已删掉" });
});

test("the app's line about checks in force offers to remove them, and says so once pressed", () => {
  const line: MessageControl = { kind: "check", event: "active", check_ids: ["check-1", "check-2"], offer: ["remove_check"] };
  expect(controlBar(line, [], names, t)).toEqual({ state: "ask", prompt: null, buttons: [{ action: "remove_check", label: "删掉这 2 条检查", primary: false }] });
  expect(controlBar({ ...line, check_ids: ["check-1"] }, [], names, copyFor("en").control)).toMatchObject({ buttons: [{ label: "Remove this check" }] });
  expect(controlBar({ ...line, acted: ["remove_check"] }, [], names, t)).toEqual({ state: "done", note: "已删掉" });
});

test("the app's lines about the requirements ledger: 都是 / 逐条看 for old rules, 升为常设 / 不用 for a standing suggestion", () => {
  const legacy: MessageControl = {
    kind: "requirement",
    event: "legacy",
    requirement_ids: ["r1", "r2"],
    task_id: "task-1",
    offer: ["confirm_requirements", "review_requirements"],
  };
  expect(controlBar(legacy, [], names, t)).toEqual({
    state: "ask",
    prompt: null,
    buttons: [
      { action: "confirm_requirements", label: "都是", primary: true },
      { action: "review_requirements", label: "逐条看", primary: false },
    ],
  });
  expect(controlBar({ ...legacy, acted: ["confirm_requirements"] }, [], names, t)).toEqual({ state: "done", note: "已确认都是你说的" });
  const standing: MessageControl = {
    kind: "requirement",
    event: "standing",
    requirement_ids: ["r3"],
    task_id: "task-1",
    category: "背景连贯",
    domain: "video",
    offer: ["make_standing", "keep_project"],
  };
  expect(controlBar(standing, [], names, copyFor("en").control)).toMatchObject({ buttons: [{ label: "Make it standing" }, { label: "Not now" }] });
  expect(controlBar({ ...standing, acted: ["keep_project"] }, [], names, t)).toEqual({ state: "done", note: "先不升" });
  expect(controlBar({ ...standing, requirement_ids: [] }, [], names, t)).toEqual({ state: "none" });
});

test("a card about a hand-over waiting on you: confirm the check, count it as met, or no longer require it; once pressed it says so, and a let-go card offers nothing", () => {
  const card: MessageControl = {
    kind: "review_item",
    submission_id: "sub-1",
    task_id: "task-1",
    ticket_id: "ticket-1",
    requirement_ids: ["r1"],
    check_ids: ["check-1"],
    offer: ["confirm_check", "confirm_item", "remove_item"],
  };
  expect(controlBar(card, [], names, t)).toEqual({
    state: "ask",
    prompt: null,
    buttons: [
      { action: "confirm_check", label: "确认这条检查", primary: true },
      { action: "confirm_item", label: "算它做到了", primary: false },
      { action: "remove_item", label: "不再要这条", primary: false },
    ],
  });
  expect(controlBar({ ...card, check_ids: [], offer: ["confirm_item", "remove_item"] }, [], names, copyFor("en").control)).toMatchObject({
    buttons: [{ label: "Count it as met", primary: true }, { label: "No longer require it", primary: false }],
  });
  expect(controlBar({ ...card, acted: ["confirm_item"] }, [], names, t)).toEqual({ state: "done", note: "已认可做到了" });
  expect(controlBar({ ...card, offer: [], acted: [] }, [], names, t)).toEqual({ state: "none" });
});

test("ADR 0042: a misread proposal that PASSES puts 确认这条检查 last, with no button primary", () => {
  const card: MessageControl = {
    kind: "review_item",
    submission_id: "sub-1",
    task_id: "task-1",
    ticket_id: "ticket-1",
    requirement_ids: ["r1"],
    check_ids: ["check-1"],
    checks_passing: true,
    offer: ["confirm_check", "confirm_item", "remove_item"],
  };
  expect(controlBar(card, [], names, t)).toEqual({
    state: "ask",
    prompt: null,
    buttons: [
      { action: "confirm_item", label: "算它做到了", primary: false },
      { action: "remove_item", label: "不再要这条", primary: false },
      { action: "confirm_check", label: "确认这条检查", primary: false },
    ],
  });
  // A proposal that has not (yet) passed reads as usual: 确认这条检查 first and primary.
  expect(controlBar({ ...card, checks_passing: false }, [], names, t)).toEqual({
    state: "ask",
    prompt: null,
    buttons: [
      { action: "confirm_check", label: "确认这条检查", primary: true },
      { action: "confirm_item", label: "算它做到了", primary: false },
      { action: "remove_item", label: "不再要这条", primary: false },
    ],
  });
});

test("a hand-over with no reviewer and nothing required waits on an approve/reject card (ADR 0046)", () => {
  const card: MessageControl = {
    kind: "review_item",
    submission_id: "sub-2",
    task_id: "task-1",
    ticket_id: "ticket-1",
    requirement_ids: [],
    check_ids: [],
    offer: ["approve", "reject"],
  };
  expect(controlBar(card, [], names, t)).toEqual({
    state: "ask",
    prompt: null,
    buttons: [
      { action: "approve", label: "放行", primary: true },
      { action: "reject", label: "退回", primary: false },
    ],
  });
  expect(controlBar({ ...card, acted: ["reject"] }, [], names, t)).toEqual({ state: "done", note: "已退回" });
  expect(controlBar({ ...card, acted: ["approve"] }, [], names, copyFor("en").control)).toEqual({ state: "done", note: "Approved" });
});

test("pressing 放行 while a gate had not run yet shows what actually happened, not a bare 已放行 (ADR 0046)", () => {
  const card: MessageControl = {
    kind: "review_item",
    submission_id: "sub-3",
    task_id: "task-1",
    ticket_id: "ticket-1",
    requirement_ids: [],
    check_ids: [],
    offer: [],
    acted: ["reject"],
    result: "检查没过，已退回：「选题文件存在」：不通过",
  };
  expect(controlBar(card, [], names, t)).toEqual({ state: "done", note: "检查没过，已退回：「选题文件存在」：不通过" });
  // It actually approved: the card carries no override, so the generic 已放行 label shows.
  expect(controlBar({ ...card, acted: ["approve"], result: undefined }, [], names, t)).toEqual({ state: "done", note: "已放行" });
});

test("an approve/reject card waiting on a check shows why beside 退回; one taken over shows why with no buttons (ADR 0046)", () => {
  const card: MessageControl = {
    kind: "review_item",
    submission_id: "sub-4",
    task_id: "task-1",
    ticket_id: "ticket-1",
    requirement_ids: [],
    check_ids: [],
    offer: ["reject"],
    result: "等检查跑完再放行…",
  };
  expect(controlBar(card, [], names, t)).toEqual({ state: "ask", prompt: "等检查跑完再放行…", buttons: [{ action: "reject", label: t.sendBack, primary: false }] });
  expect(controlBar({ ...card, offer: [], result: "已被新的交付取代。" }, [], names, t)).toEqual({ state: "done", note: "已被新的交付取代。" });
  // Nothing to press and nothing said: no row at all.
  expect(controlBar({ ...card, offer: [], result: undefined }, [], names, t)).toEqual({ state: "none" });
});

test("a rework card asks first, then offers undo beside what it did (ADR 0046)", () => {
  const card: MessageControl = { kind: "rework", task_id: "task-1", ticket_id: "ticket-1", part_keys: ["C07"], message_id: "m-1", offer: ["rework", "dismiss"] };
  expect(controlBar(card, [], names, t)).toEqual({ state: "ask", prompt: null, buttons: [
    { action: "rework", label: t.sendBackToRework, primary: true },
    { action: "dismiss", label: t.leaveIt, primary: false },
  ] });
  const sent: MessageControl = { ...card, offer: ["undo"], result: "已转回返工。" };
  expect(controlBar(sent, [], names, t)).toEqual({ state: "ask", prompt: "已转回返工。", buttons: [{ action: "undo", label: t.undo, primary: false }] });
  expect(controlBar({ ...card, acted: ["dismiss"] }, [], names, t)).toEqual({ state: "done", note: t.acted.dismiss });
  expect(controlBar({ ...card, offer: [], result: "这句话后来改归别处了。" }, [], names, t)).toEqual({ state: "done", note: "这句话后来改归别处了。" });
  expect(controlBar({ ...sent, acted: ["undo"], result: undefined }, [], names, t)).toEqual({ state: "done", note: t.acted.undo });
});
