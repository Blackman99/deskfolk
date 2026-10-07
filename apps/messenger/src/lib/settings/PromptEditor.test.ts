import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { PromptDetail, PutPromptRequest } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import PromptEditor from "./PromptEditor.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function detail(over: Partial<PromptDetail> = {}): PromptDetail {
  return {
    id: "call.scribe",
    group: "call",
    title: { zh: "书记员", en: "Scribe" },
    summary: { zh: "把你话里的要求记进需求台账。", en: "Scribe." },
    locales: [{ locale: "zh", state: "default", last_actor: null, last_bot_id: null, updated_at: null, parse_failures: { since_edit: null, last_7_days: 0 } }],
    locale: "zh",
    text: "你是书记员。\n\n{format}",
    format: "只输出一个 JSON 对象",
    default_text: "你是书记员。\n\n{format}",
    base_text: null,
    conflict_default: null,
    placeholders: [{ name: "format", meaning: { zh: "输出格式插在这里", en: "format" }, required: "once" }],
    no_brace: false,
    max_chars: 4000,
    head_revision_id: null,
    revisions: [],
    env: { level: 8, shell: "sh" },
    ...over,
  };
}

function open(client: Record<string, unknown>) {
  const runtime = fakeRuntime({}, { client });
  const view = render(PromptEditor, { runtime, t, id: "call.scribe", locale: "zh", onLocale: () => {}, onOpenMessage: () => {} });
  return { ...view, runtime };
}

test("what you type saves itself a moment later, against the change you saw, in one sitting", async () => {
  const puts: PutPromptRequest[] = [];
  let current = detail();
  const { host, close } = open({
    getPrompt: async () => current,
    putPrompt: async (_id: string, _locale: string, body: PutPromptRequest) => {
      puts.push(body);
      current = detail({ text: body.text, base_text: current.default_text, head_revision_id: "r1", locales: [{ ...current.locales[0]!, state: "edited", last_actor: "user" }] });
      return current;
    },
  });
  await sleep(10);
  flushSync();
  const box = host.querySelector<HTMLTextAreaElement>(".prompt-text")!;
  expect(box.value).toBe("你是书记员。\n\n{format}");
  // The fixed format is shown, read-only, apart from what you edit.
  expect(host.querySelector(".prompt-format pre")?.textContent).toBe("只输出一个 JSON 对象");
  fill(box, "只记用户的话。\n\n{format}");
  expect(puts).toHaveLength(0);
  await sleep(1100);
  flushSync();
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ text: "只记用户的话。\n\n{format}", if_revision: null });
  const session = puts[0]!.edit_session;
  expect(session).toBeTruthy();
  expect(host.querySelector(".prompt-save-state")?.textContent?.trim()).toBe(t.prompts.saved);
  fill(box, "只记用户自己的话。\n\n{format}");
  await sleep(1100);
  expect(puts[1]).toMatchObject({ if_revision: "r1", edit_session: session });
  close();
});

test("a refused save says why in words and stays unsaved", async () => {
  const { host, close } = open({
    getPrompt: async () => detail(),
    putPrompt: async () => {
      throw new ApiError(422, "prompt_placeholder_missing", "prompt_placeholder_missing:{format}");
    },
  });
  await sleep(10);
  flushSync();
  fill(host.querySelector(".prompt-text"), "只记用户的话。");
  await sleep(1100);
  flushSync();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("少了 {format}。");
  expect(host.querySelector(".prompt-save-state")?.textContent?.trim()).toBe(t.prompts.unsaved);
  close();
});

test("a save that lost to a newer change loads the newer one and keeps yours to copy", async () => {
  let loads = 0;
  const { host, close } = open({
    getPrompt: async () => {
      loads += 1;
      return loads === 1 ? detail() : detail({ text: "别人改的。\n\n{format}", head_revision_id: "r9", base_text: "你是书记员。\n\n{format}" });
    },
    putPrompt: async () => {
      throw new ApiError(409, "prompt_changed", "this prompt changed since you loaded it");
    },
  });
  await sleep(10);
  flushSync();
  fill(host.querySelector(".prompt-text"), "我的版本。\n\n{format}");
  await sleep(1100);
  flushSync();
  expect(host.querySelector<HTMLTextAreaElement>(".prompt-text")!.value).toBe("别人改的。\n\n{format}");
  expect(host.textContent).toContain(t.prompts.changedElsewhere);
  expect(buttonByText(host, t.prompts.copyMine)).toBeTruthy();
  close();
});

test("restoring the default asks first; the history offers Undo only on the latest change", async () => {
  const resets: unknown[] = [];
  const edited = detail({
    text: "我的。\n\n{format}",
    base_text: "你是书记员。\n\n{format}",
    head_revision_id: "r2",
    revisions: [
      { id: "r2", op: "edit", actor: "bot", bot_id: "b1", bot_name: "调优员", turn_id: "t", session_id: "s1", message_id: "m1", approval_id: "a", reason: "更短", before_text: null, after_text: "我的。\n\n{format}", created_at: "2026-10-06T08:00:00.000Z", undoable: true },
      { id: "r1", op: "edit", actor: "user", bot_id: null, bot_name: null, turn_id: null, session_id: null, message_id: null, approval_id: null, reason: null, before_text: null, after_text: "旧的。\n\n{format}", created_at: "2026-10-06T07:00:00.000Z", undoable: false },
    ],
  });
  const opened: Array<[string, string]> = [];
  const runtime = fakeRuntime({}, {
    client: {
      getPrompt: async () => edited,
      resetPrompt: async (...args: unknown[]) => {
        resets.push(args);
        return detail();
      },
    },
  });
  const { host, close } = render(PromptEditor, { runtime, t, id: "call.scribe", locale: "zh", onLocale: () => {}, onOpenMessage: (s: string, m: string) => opened.push([s, m]) });
  await sleep(10);
  flushSync();
  // The history is a view of its own, and its tab says how many changes there are.
  expect(host.querySelector(".prompt-revision")).toBeNull();
  const historyTab = host.querySelector('[data-view="history"]')!;
  expect(historyTab.textContent).toContain("2");
  click(historyTab);
  expect(historyTab.getAttribute("aria-selected")).toBe("true");
  const revisions = [...host.querySelectorAll(".prompt-revision")];
  expect(revisions[0]?.textContent).toContain("调优员 · 修改");
  expect(revisions[0]?.textContent).toContain("更短");
  expect([...revisions[0]!.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain(t.prompts.undo);
  expect([...revisions[1]!.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain(t.prompts.undo);
  click(buttonByText(revisions[0] as HTMLElement, t.prompts.openMessage));
  expect(opened).toEqual([["s1", "m1"]]);
  click(buttonByText(host, t.prompts.reset));
  expect(resets).toHaveLength(0);
  expect(host.textContent).toContain(t.prompts.resetConfirmTitle);
  click([...host.querySelectorAll<HTMLButtonElement>(".prompt-button.is-danger")][0]);
  await sleep(10);
  expect(resets).toEqual([["call.scribe", "zh", "r2"]]);
  close();
});

test("the views: the text stays put while you compare it with the default, and leaving it saves", async () => {
  const puts: PutPromptRequest[] = [];
  let current = detail();
  const { host, close } = open({
    getPrompt: async () => current,
    putPrompt: async (_id: string, _locale: string, body: PutPromptRequest) => {
      puts.push(body);
      current = detail({ text: body.text, base_text: current.default_text, head_revision_id: "r1" });
      return current;
    },
  });
  await sleep(10);
  flushSync();
  const box = host.querySelector<HTMLTextAreaElement>(".prompt-text")!;
  fill(box, "你是书记员。只记用户的话。\n\n{format}");
  click(host.querySelector('[data-view="compare"]'));
  // Leaving the text saved it at once rather than a second later.
  await sleep(10);
  expect(puts).toHaveLength(1);
  // The same textarea is still there, only hidden, so its own undo and scroll survive.
  expect(host.querySelector(".prompt-text")).toBe(box);
  expect(host.querySelector("#prompt-panel-text")?.hasAttribute("hidden")).toBe(true);
  const lines = [...host.querySelectorAll("#prompt-panel-compare li")].map((li) => [li.classList.contains("diff-del") ? "del" : li.classList.contains("diff-add") ? "add" : "same", li.textContent]);
  expect(lines).toContainEqual(["del", "你是书记员。"]);
  expect(lines).toContainEqual(["add", "你是书记员。只记用户的话。"]);
  click(host.querySelector('[data-view="text"]'));
  expect(host.querySelector("#prompt-panel-text")?.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector("#prompt-panel-compare")).toBeNull();
  close();
});

test("a prompt with one language says so in a word, and arrow keys walk the views", async () => {
  const { host, close } = open({ getPrompt: async () => detail() });
  await sleep(10);
  flushSync();
  const only = host.querySelector(".prompt-only")!;
  expect(only.textContent).toBe("只有中文版");
  expect(only.getAttribute("title")).toBe(t.prompts.onlyLanguage("中文"));
  const text = host.querySelector<HTMLButtonElement>('[data-view="text"]')!;
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await sleep(10);
  flushSync();
  expect(host.querySelector('[data-view="history"]')?.getAttribute("aria-selected")).toBe("true");
  expect(host.textContent).toContain(t.prompts.noHistory);
  close();
});

