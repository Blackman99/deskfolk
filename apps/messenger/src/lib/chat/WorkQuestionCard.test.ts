import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import type { WorkAnswerResult, WorkQuestionControl } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { aMessage } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import WorkQuestionCard from "./WorkQuestionCard.svelte";

const control: WorkQuestionControl = { kind: "work_question", work_item_id: "work-1", task_id: "plan-1", ticket_id: null, question: "选哪版？", offer: [] };
const t = copyFor("en");

test("dedicated card prevents concurrent presses and waits for authoritative message rather than displaying the submitted draft as saved", async () => {
  let resolve!: (value: WorkAnswerResult) => void;
  const pending = new Promise<WorkAnswerResult>((done) => { resolve = done; });
  const calls: string[] = [];
  const props = reactive({ control, botName: "Director", planName: "Trailer", ticketName: null, t,
    onAnswer: async (body: string) => { calls.push(body); return pending; } });
  const h = render(WorkQuestionCard, props);
  try {
    fill(h.host.querySelector("textarea"), " exact\n🦊 ");
    click(buttonByText(h.host, t.workQuestion.submit));
    expect(buttonByText(h.host, t.workQuestion.saving).disabled).toBe(true);
    click(buttonByText(h.host, t.workQuestion.saving));
    expect(calls).toEqual([" exact\n🦊 "]);
    expect(h.host.querySelector("textarea")?.disabled).toBe(true);
    const saved: WorkQuestionControl = { ...control, answer: { body: "Different device's actual answer\n✅", at: "2026-10-01T02:00:00Z", user_action_id: "other", inbox_seq: 9 } };
    resolve({ message: aMessage({ control: saved }), work_item_id: "work-1", inbox_state: "queued", answered: false });
    await tick(); flushSync();
    // The request receipt alone is not a second source of message truth.
    expect(h.host.querySelector(".work-question-answer")).toBeNull();
    props.control = saved; flushSync();
    expect(h.host.querySelector(".work-question-answer")?.textContent).toBe("Different device's actual answer\n✅");
    expect(h.host.querySelector("button")).toBeNull();
  } finally { h.close(); }
});

test("unconfirmed receipt retains the exact draft and requires an explicit retry", async () => {
  const calls: string[] = [];
  const h = render(WorkQuestionCard, { control, botName: "Director", planName: "Trailer", ticketName: null, t,
    onAnswer: async (body: string) => { calls.push(body); return new ApiError(503, "request_unknown", "Lost response"); } });
  try {
    fill(h.host.querySelector("textarea"), " exact\n🦊 ");
    click(buttonByText(h.host, t.workQuestion.submit)); await tick(); flushSync();
    expect(h.host.querySelector('[role="alert"]')?.textContent).toBe(t.workQuestion.unknown);
    expect(h.host.querySelector("textarea")?.value).toBe(" exact\n🦊 ");
    expect(calls).toHaveLength(1);
    click(buttonByText(h.host, t.workQuestion.submit)); await tick(); flushSync();
    expect(calls).toEqual([" exact\n🦊 ", " exact\n🦊 "]);
  } finally { h.close(); }
});
