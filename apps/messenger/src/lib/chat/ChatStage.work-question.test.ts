import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import type { WorkAnswerResult, WorkQuestionControl } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aMessage, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const control: WorkQuestionControl = { kind: "work_question", work_item_id: "work-1", task_id: "plan-1", ticket_id: "ticket-1", question: "片长要多少？\n画幅呢？", offer: [] };
const body = "  ９０ 秒 🦊\n画幅 9:16\n ";
function stage(locale: "zh" | "en", session = aGroup(), refusal?: ApiError, empty = false) {
  const message = aMessage({ id: "work-question", session_id: session.id, kind: "system", author: "bot-1", turn_id: "ended-turn", body: "工作卡住了", control });
  const runtime = reactive(fakeRuntime({ bots: [aBot({ name: "视频导演" })], sessions: [session], messages: empty ? [] : [message],
    turns: [aTurn({ id: "ended-turn", session_id: session.id, status: "completed", pending_ask_id: null })],
  }, { selectedId: session.id, answerWorkQuestion: async (_id: string, answerBody: string) => {
    runtime.calls.push({ name: "answerWorkQuestion", args: [_id, answerBody] });
    if (refusal) return refusal;
    const saved = { ...message, control: { ...control, answer: { body: answerBody, at: "2026-10-01T02:00:00.000Z", user_action_id: "answer-1", inbox_seq: 7 } } };
    runtime.snapshot = { ...runtime.snapshot, messages: [saved] };
    return { message: saved, work_item_id: "work-1", inbox_state: "held", answered: true } satisfies WorkAnswerResult;
  } }));
  runtime.attributionPlans = { [session.id]: [{ id: "plan-1", title: "预告片", tickets: [{ id: "ticket-1", title: "竖屏剪辑" }] }] };
  const t = copyFor(locale);
  const view = render(ChatStage, { runtime, t, selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  return { ...view, runtime, t };
}

test("actual ChatStage shows a dedicated ended-work question with real bot/plan/ticket context and explicit exact-text submit", async () => {
  const h = stage("zh");
  try {
    const row = h.host.querySelector<HTMLElement>('[data-message-id="work-question"]')!;
    const card = row.querySelector<HTMLElement>(".work-question-card");
    expect(card).not.toBeNull();
    expect(row.querySelector(".app-avatar")).not.toBeNull();
    expect(row.querySelector(".control-actions")).toBeNull();
    expect(card?.textContent).toContain("视频导演");
    expect(card?.textContent).toContain("预告片");
    expect(card?.textContent).toContain("竖屏剪辑");
    expect(card?.querySelector(".work-question-text")?.textContent).toBe(control.question);
    expect(row.textContent).not.toContain("工作卡住了");
    expect(row.querySelector(".ask-card")).toBeNull();
    const field = card!.querySelector("textarea")!;
    fill(field, body); press(field, "Enter");
    expect(h.runtime.calls.filter((call) => call.name === "answerWorkQuestion")).toEqual([]);
    click(buttonByText(card!, "保存回答")); await tick(); flushSync();
    expect(h.runtime.calls.filter((call) => call.name === "answerWorkQuestion").map((call) => call.args)).toEqual([["work-question", body]]);
    expect(h.runtime.calls.filter((call) => ["sendAsk", "send", "liftHold", "continueInterrupt", "controlAction"].includes(call.name))).toEqual([]);
    expect(card!.querySelector(".work-question-answer")?.textContent).toBe(body);
    expect(card!.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T02:00:00.000Z");
    expect(card!.textContent).toContain("回答已保存；工作仍处于叫停状态");
    expect(card!.querySelector("textarea")).toBeNull();
    expect(card!.querySelector("button")).toBeNull();
  } finally { h.close(); }
});

for (const locale of ["zh", "en"] as const) {
  for (const reason of ["bot_archived", "plan_deleted", "work_closed"] as const) {
    test(`actual ChatStage keeps the draft and shows a ${locale} refusal when ${reason}`, async () => {
      const h = stage(locale, aDirect(), new ApiError(409, reason, "Refused"));
      try {
        const card = h.host.querySelector<HTMLElement>(".work-question-card")!;
        fill(card.querySelector("textarea"), body);
        click(buttonByText(card, h.t.workQuestion.submit)); await tick(); flushSync();
        expect(card.querySelector("textarea")?.value).toBe(body);
        expect(card.querySelector('[role="alert"]')?.textContent).toBe(h.t.workQuestion.failed);
        expect(card.querySelector(".work-question-answer")).toBeNull();
        expect(buttonByText(card, h.t.workQuestion.submit).disabled).toBe(false);
      } finally { h.close(); }
    });
  }
}

test("persisted answer renders readonly after remount, and a Bot-only thread never offers an answer", () => {
  const h = stage("en", aDirect());
  try {
    const message = h.runtime.snapshot.messages[0]!;
    h.runtime.snapshot = { ...h.runtime.snapshot, turns: [], messages: [{ ...message, control: { ...control, answer: { body, at: "2026-10-01T02:00:00.000Z", user_action_id: "saved", inbox_seq: 3 } } }] }; flushSync();
    const card = h.host.querySelector<HTMLElement>(".work-question-card")!;
    expect(card.querySelector(".work-question-answer")?.textContent).toBe(body);
    expect(card.textContent).toContain("Answer saved");
    expect(card.querySelector("textarea")).toBeNull();
    expect(card.querySelector("button")).toBeNull();
    expect(card.textContent).not.toContain("remains stopped");
  } finally { h.close(); }
  const thread = stage("en", aBotDirect());
  try {
    expect(thread.host.querySelector(".work-question-card textarea")).toBeNull();
    expect(thread.host.querySelector(".work-question-card button")).toBeNull();
    expect(thread.host.querySelector(".work-question-card")?.textContent).toContain(thread.t.workQuestion.readOnly);
  } finally { thread.close(); }
});

test("an ended-work card is never a legacy Continue note even if its body matches an interruption marker", () => {
  const h = stage("en", aDirect());
  try {
    const message = h.runtime.snapshot.messages[0]!;
    h.runtime.snapshot = { ...h.runtime.snapshot, messages: [{ ...message, body: "中断", control: { ...control, answer: { body, at: "2026-10-01T02:00:00Z", user_action_id: "saved", inbox_seq: 9 } } }], turns: [aTurn({ id: "ended-turn", status: "interrupted" })] }; flushSync();
    const row = h.host.querySelector('[data-message-id="work-question"]')!;
    expect(row.querySelector(".btn-continue-turn")).toBeNull();
    expect(row.querySelector("button")).toBeNull();
  } finally { h.close(); }
});

test("a work question arriving after the conversation opened requests its real context", async () => {
  const h = stage("en", aDirect());
  try {
    const message = h.runtime.snapshot.messages[0]!;
    h.runtime.snapshot = { ...h.runtime.snapshot, messages: [] }; flushSync();
    h.runtime.snapshot = { ...h.runtime.snapshot, messages: [message] }; flushSync(); await tick();
    // Read only after the change: reading the recorded calls earlier would freeze them (test-reactive proxy).
    const loads = h.runtime.calls.filter((call) => call.name === "loadAttributionPlans").map((call) => call.args);
    // With no line to load from, nothing is asked; the question, once it is there, is what is asked about.
    expect(loads.at(-1)).toEqual([message.session_id, message.id]);
    expect(loads.some((args) => args[1] === undefined && loads.indexOf(args) > 0)).toBe(false);
  } finally { h.close(); }
});

test("archived user-present groups share the conversation write lock for durable answers", () => {
  const h = stage("en", aGroup({ archived_at: "2026-10-01T02:00:00Z" }));
  try {
    expect(h.host.querySelector(".work-question-card textarea")).toBeNull();
    expect(h.host.querySelector(".work-question-card button")).toBeNull();
    expect(h.runtime.calls.filter((call) => call.name === "answerWorkQuestion")).toEqual([]);
  } finally { h.close(); }
});

test("work question uses honest bound IDs when context is missing; offline and whitespace do not submit", () => {
  const h = stage("en", aDirect());
  try {
    h.runtime.attributionPlans = {}; flushSync();
    const card = h.host.querySelector<HTMLElement>(".work-question-card")!;
    expect(card.textContent).toContain("plan-1");
    expect(card.textContent).toContain("ticket-1");
    fill(card.querySelector("textarea"), " \n\t");
    expect(buttonByText(card, h.t.workQuestion.submit).disabled).toBe(true);
    h.runtime.connection = "disconnected"; flushSync();
    expect(card.querySelector("textarea")?.disabled).toBe(true);
    expect(h.runtime.calls.filter((call) => call.name === "answerWorkQuestion")).toEqual([]);
  } finally { h.close(); }
});
