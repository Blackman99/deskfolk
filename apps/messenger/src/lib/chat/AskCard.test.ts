import { expect, test } from "bun:test";
import type { AskAnswer, AskSpec } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import type { AskDraftRecord } from "../notifications/types.ts";
import { aMessage } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, fill, press, render } from "../test-render.ts";
import AskCard from "./AskCard.svelte";

const t = copyFor("zh");

const sections: AskSpec = {
  options: [
    { label: "摘要（推荐）", description: "开头一段" },
    { label: "数据" },
    { label: "风险" },
  ],
  multi_select: true,
};

function card(opts: { ask?: AskSpec | null; answer?: AskAnswer | null; answerable?: boolean; sending?: boolean } = {}) {
  const submitted: Array<{ selected: string[]; body: string }> = [];
  const props = reactive({
    message: aMessage({ id: "ask-1", kind: "ask", author: "bot-1", body: "报告要哪些部分？", ask: opts.ask ?? null, ask_answer: opts.answer ?? null }),
    answerable: opts.answerable ?? true,
    draft: undefined as AskDraftRecord | undefined,
    sending: opts.sending ?? false,
    t,
    onDraft: (body: string) => {
      props.draft = { askId: "ask-1", body, selected: props.draft?.selected ?? [], version: (props.draft?.version ?? 0) + 1, error: null, ended: false };
    },
    onSelect: (selected: string[]) => {
      props.draft = { askId: "ask-1", body: props.draft?.body ?? "", selected, version: (props.draft?.version ?? 0) + 1, error: null, ended: false };
    },
    onSubmit: () => submitted.push({ selected: props.draft?.selected ?? [], body: props.draft?.body ?? "" }),
  });
  const view = render(AskCard, props);
  const option = (label: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>(".ask-option")].find((b) => b.querySelector(".ask-option-label")?.textContent === label)!;
  const checked = () =>
    [...view.host.querySelectorAll(".ask-option")].filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.querySelector(".ask-option-label")?.textContent);
  return { ...view, props, submitted, option, checked };
}

test("multi-select ticks several choices and sends them with a note", () => {
  const { host, option, checked, submitted, close } = card({ ask: sections });
  expect(host.querySelector(".ask-mode")?.textContent).toBe(t.stream.askPickAny);
  expect(host.querySelector(".ask-options")?.getAttribute("role")).toBe("group");
  expect(option("数据").getAttribute("role")).toBe("checkbox");
  expect(option("摘要（推荐）").querySelector(".ask-option-desc")?.textContent).toBe("开头一段");
  const send = host.querySelector<HTMLButtonElement>(".ask-send")!;
  expect(send.disabled).toBe(true);

  click(option("风险"));
  click(option("摘要（推荐）"));
  expect(checked()).toEqual(["摘要（推荐）", "风险"]);
  click(option("风险"));
  expect(checked()).toEqual(["摘要（推荐）"]);
  expect(send.disabled).toBe(false);

  const input = host.querySelector<HTMLInputElement>(".ask-reply input")!;
  expect(input.placeholder).toBe(t.stream.askWriteOwn);
  fill(input, "尽量短");
  press(input, "Enter");
  expect(submitted).toEqual([{ selected: ["摘要（推荐）"], body: "尽量短" }]);
  close();
});

test("single-select swaps its one choice; text alone is an answer too", () => {
  const { host, option, checked, submitted, close } = card({ ask: { ...sections, multi_select: false } });
  expect(host.querySelector(".ask-mode")?.textContent).toBe(t.stream.askPickOne);
  expect(host.querySelector(".ask-options")?.getAttribute("role")).toBe("radiogroup");
  expect(option("数据").getAttribute("role")).toBe("radio");
  click(option("数据"));
  click(option("风险"));
  expect(checked()).toEqual(["风险"]);
  click(option("风险"));
  expect(checked()).toEqual([]);

  fill(host.querySelector(".ask-reply input"), "都不要，只要结论");
  click(host.querySelector(".ask-send"));
  expect(submitted).toEqual([{ selected: [], body: "都不要，只要结论" }]);
  close();
});

test("Enter while an IME is composing does not send", () => {
  const { host, option, submitted, close } = card({ ask: sections });
  click(option("数据"));
  const input = host.querySelector<HTMLInputElement>(".ask-reply input")!;
  press(input, "Enter", { isComposing: true });
  expect(submitted).toEqual([]);
  close();
});

test("a plain question keeps the one reply line", () => {
  const { host, submitted, close } = card();
  expect(host.querySelector(".ask-options")).toBeNull();
  const input = host.querySelector<HTMLInputElement>(".ask-reply input")!;
  expect(input.placeholder).toBe(t.stream.reply);
  press(input, "Enter");
  expect(submitted).toEqual([]);
  fill(input, "正式一点");
  press(input, "Enter");
  expect(submitted).toEqual([{ selected: [], body: "正式一点" }]);
  close();
});

test("an answered question keeps what you chose and wrote on the card, with nothing left to fill", () => {
  const { host, option, checked, close } = card({
    ask: sections,
    answer: { selected: ["摘要（推荐）", "风险"], custom: "尽量短", answered_at: "2026-09-19T02:05:00.000Z" },
  });
  expect(host.querySelector(".ask-card")?.classList.contains("is-answered")).toBe(true);
  expect(checked()).toEqual(["摘要（推荐）", "风险"]);
  expect(option("数据").disabled).toBe(true);
  expect(host.querySelector(".ask-own-text")?.textContent).toBe("尽量短");
  expect(host.querySelector(".ask-answered")?.textContent).toContain(t.stream.askAnswered);
  expect(host.querySelector(".ask-reply")).toBeNull();
  expect(host.querySelector(".ask-mode")).toBeNull();
  close();
});

test("an answer arriving turns an open card over", () => {
  const { host, props, close } = card({ ask: sections });
  expect(host.querySelector(".ask-reply")).toBeTruthy();
  props.message = { ...props.message, ask_answer: { selected: ["数据"], custom: null, answered_at: "2026-09-19T02:05:00.000Z" } };
  props.answerable = false;
  flushSync();
  expect(host.querySelector(".ask-reply")).toBeNull();
  expect(host.querySelector(".ask-own-text")).toBeNull();
  expect(host.querySelector(".ask-answered")).toBeTruthy();
  close();
});

test("a question that ended unanswered says so and offers nothing to click", () => {
  const { host, option, close } = card({ ask: sections, answerable: false });
  expect(host.querySelector(".ask-ended")?.textContent).toBe(t.notifications.askEndedReadOnly);
  expect(option("数据").disabled).toBe(true);
  expect(host.querySelector(".ask-reply")).toBeNull();
  close();
});
