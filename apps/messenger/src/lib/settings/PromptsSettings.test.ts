import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { PromptSummary } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { click, fill, render } from "../test-render.ts";
import PromptsSettings from "./PromptsSettings.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function item(id: string, group: PromptSummary["group"], state: "default" | "edited" | "conflict" = "default", failures = 0): PromptSummary {
  return {
    id, group,
    title: { zh: `标题 ${id}`, en: `Title ${id}` },
    summary: { zh: `说明 ${id}`, en: `About ${id}` },
    locales: [{ locale: "zh", state, last_actor: state === "default" ? null : "bot", last_bot_id: state === "default" ? null : "b1", updated_at: null, parse_failures: group === "call" ? { since_edit: state === "default" ? null : failures, last_7_days: failures } : null }],
  };
}

const items = [item("turn.system", "turn", "edited"), item("turn.memory", "turn"), item("tool.shell", "tool"), item("tool.send_message", "tool"), item("call.scribe", "call", "edited", 3)];

const shown = (host: HTMLElement) => [...host.querySelectorAll("[data-prompt]")].map((el) => el.getAttribute("data-prompt"));

const tabs = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.section-tabs [role="tab"]')];
const tab = (host: HTMLElement, group: string) => host.querySelector<HTMLButtonElement>(`.section-tabs [data-section="${group}"]`);

test("prompts show one group a tab, the tools last as a grid of names; only edits and unreadable answers are marked", () => {
  const runtime = fakeRuntime({ bots: [{ id: "b1", name: "调优员" } as never] });
  const { host, close } = render(PromptsSettings, { runtime, t, items });
  // Groups with no prompt have no tab; the first one is open.
  expect(tabs(host).map((el) => el.dataset.section)).toEqual(["turn", "call", "tool"]);
  // Each counts what you edited in it, and a group with nothing edited shows no number.
  expect(tabs(host).map((el) => el.querySelector(".section-tab-count")?.textContent ?? null)).toEqual(["1", "1", null]);
  expect(tab(host, "turn")?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("prompts-tab-turn");
  expect(shown(host)).toEqual(["turn.system", "turn.memory"]);
  // The tab names the group, so its page has no heading of its own.
  expect(host.querySelector(".prompts-group-head")).toBeNull();
  // A default says nothing about being one.
  expect(host.querySelector('[data-prompt="turn.memory"] .prompts-chip')).toBeNull();
  expect(host.textContent).not.toContain(t.prompts.state.default);
  click(tab(host, "call"));
  expect(shown(host)).toEqual(["call.scribe"]);
  const scribe = host.querySelector('[data-prompt="call.scribe"]')!;
  expect(scribe.textContent).toContain("已改 · 调优员改的");
  expect(scribe.textContent).toContain("读不懂 3 次");
  // The tools are open on their own tab: what every tool's text is, said once, then their names.
  click(tab(host, "tool"));
  expect(shown(host)).toEqual(["tool.shell", "tool.send_message"]);
  expect(host.querySelectorAll(".prompts-group-note")).toHaveLength(1);
  expect(host.querySelector('[data-prompt="tool.shell"]')!.textContent?.trim()).toBe("标题 tool.shell");
  // A search looks through every group, and shows what it keeps by group in one list.
  fill(host.querySelector(".prompts-search"), "turn.");
  expect(host.querySelector(".section-tabs")).toBeNull();
  expect([...host.querySelectorAll(".prompts-group-title")].map((el) => el.textContent)).toEqual([t.prompts.groups.turn]);
  expect(shown(host)).toEqual(["turn.system", "turn.memory"]);
  fill(host.querySelector(".prompts-search"), "send_message");
  expect(shown(host)).toEqual(["tool.send_message"]);
  fill(host.querySelector(".prompts-search"), "nothing like it");
  expect(host.textContent).toContain(t.prompts.noMatch);
  // Cleared, the tabs are back on the group you were reading.
  fill(host.querySelector(".prompts-search"), "");
  expect(tab(host, "tool")?.getAttribute("aria-selected")).toBe("true");
  close();
});

test("the edited filter keeps only what changed, tools included, and is gone when nothing is edited", () => {
  const runtime = fakeRuntime({ bots: [{ id: "b1", name: "调优员" } as never] });
  const withTool = [...items.slice(0, 3), item("tool.send_message", "tool", "conflict"), items[4]!];
  const { host, close } = render(PromptsSettings, { runtime, t, items: withTool });
  // Each tab counts what changed in its group; a newer default in conflict counts in the warning colour.
  expect(tab(host, "tool")?.querySelector(".section-tab-count")?.textContent).toBe("1");
  expect(tab(host, "tool")?.querySelector(".section-tab-count.is-warn")).toBeTruthy();
  expect(tab(host, "turn")?.querySelector(".section-tab-count.is-warn")).toBeNull();
  const edited = host.querySelector<HTMLButtonElement>('[data-prompts-filter="edited"]')!;
  expect(edited.textContent).toContain("3");
  click(edited);
  expect(edited.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".section-tabs")).toBeNull();
  expect(shown(host)).toEqual(["turn.system", "call.scribe", "tool.send_message"]);
  // An edited tool is marked in the grid, and says how in words for a screen reader.
  expect(host.querySelector('[data-prompt="tool.send_message"] .prompts-dot.is-conflict')).toBeTruthy();
  expect(host.querySelector('[data-prompt="tool.send_message"]')?.textContent).toContain(t.prompts.state.conflict);
  click(host.querySelector(".prompts-filter-btn"));
  expect(tab(host, "turn")?.getAttribute("aria-selected")).toBe("true");
  expect(shown(host)).toEqual(["turn.system", "turn.memory"]);
  close();

  const plain = render(PromptsSettings, { runtime, t, items: [item("turn.memory", "turn"), item("tool.shell", "tool")] });
  expect(plain.host.querySelector(".prompts-filter")).toBeNull();
  plain.close();
});

test("a lone group needs no tabs", () => {
  const { host, close } = render(PromptsSettings, { runtime: fakeRuntime(), t, items: [item("turn.memory", "turn")] });
  expect(host.querySelector(".section-tabs")).toBeNull();
  expect(host.querySelector(".prompts-group-title")?.textContent).toBe(t.prompts.groups.turn);
  expect(shown(host)).toEqual(["turn.memory"]);
  close();
});

test("a row opens its editor as a subpage, and back closes it", async () => {
  const runtime = fakeRuntime({}, {
    client: {
      getPrompt: async () => ({
        id: "turn.system", group: "turn", title: items[0]!.title, summary: items[0]!.summary, locales: items[0]!.locales, locale: "zh",
        text: "守则。", format: null, default_text: "守则。", base_text: null, conflict_default: null, placeholders: [], no_brace: false,
        max_chars: 2000, head_revision_id: null, revisions: [], env: { level: 8, shell: "sh" },
      }),
    },
  });
  const { host, app, close } = render(PromptsSettings, { runtime, t, items });
  click(host.querySelector('[data-prompt="turn.system"]'));
  await sleep(10);
  flushSync();
  const editor = document.querySelector(".prompt-editor-modal");
  expect(editor?.classList.contains("settings-subpage")).toBe(true);
  expect(editor?.querySelector("h2")?.textContent).toBe("标题 turn.system");
  expect(editor?.querySelector(".prompt-editor-id")?.textContent).toBe("turn.system");
  expect((app as unknown as { backFromEditor: () => boolean }).backFromEditor()).toBe(true);
  await sleep(10);
  flushSync();
  expect(document.querySelector(".prompt-editor-modal")).toBeNull();
  close();
});

test("switching the language keeps the editor on the view you were reading", async () => {
  const both = item("turn.skills", "turn");
  both.locales = [both.locales[0]!, { ...both.locales[0]!, locale: "en" }];
  const asked: string[] = [];
  const runtime = fakeRuntime({}, {
    client: {
      getPrompt: async (id: string, locale: "zh" | "en") => {
        asked.push(locale);
        return {
          id, group: "turn", title: both.title, summary: both.summary, locales: both.locales, locale,
          text: "技能。", format: null, default_text: "技能。", base_text: null, conflict_default: null, placeholders: [], no_brace: false,
          max_chars: 2000, head_revision_id: null, revisions: [], env: { level: 8, shell: "sh" },
        };
      },
    },
  });
  const { host, close } = render(PromptsSettings, { runtime, t, items: [both] });
  click(host.querySelector('[data-prompt="turn.skills"]'));
  await sleep(10);
  flushSync();
  click(document.querySelector('.prompt-editor-modal [data-view="history"]'));
  const english = [...document.querySelectorAll<HTMLButtonElement>(".prompt-editor-modal .prompt-locale")].find((b) => b.textContent?.startsWith("English"));
  click(english);
  await sleep(10);
  flushSync();
  expect(asked).toEqual(["zh", "en"]);
  expect(document.querySelector('.prompt-editor-modal [data-view="history"]')?.getAttribute("aria-selected")).toBe("true");
  // A prompt opened afresh starts on its text.
  click(document.querySelector(".prompt-editor-modal .modal-close"));
  await sleep(10);
  flushSync();
  click(host.querySelector('[data-prompt="turn.skills"]'));
  await sleep(10);
  flushSync();
  expect(document.querySelector('.prompt-editor-modal [data-view="text"]')?.getAttribute("aria-selected")).toBe("true");
  close();
});

test("sent from a card, the prompt opens at its history with that change open, and the request is taken", async () => {
  const runtime = fakeRuntime({}, {
    promptsTarget: { prompt: { id: "call.scribe", locale: "zh", revisionId: "r7" } },
    client: {
      getPrompt: async () => ({
        id: "call.scribe", group: "call", title: items[4]!.title, summary: items[4]!.summary, locales: items[4]!.locales, locale: "zh",
        text: "记下来。", format: null, default_text: "记。", base_text: "记。", conflict_default: null, placeholders: [], no_brace: false,
        max_chars: 2000, head_revision_id: "r7", env: { level: 8, shell: "sh" },
        revisions: [{ id: "r7", op: "edit", actor: "bot", bot_id: "b1", bot_name: "调优员", turn_id: "t", session_id: "s1", message_id: "m1", approval_id: "a1", reason: "更清楚", before_text: null, after_text: "记下来。", created_at: "2026-10-07T08:00:00.000Z", undoable: true }],
      }),
    },
  });
  const { host, close } = render(PromptsSettings, { runtime, t, items });
  await sleep(10);
  flushSync();
  expect(runtime.promptsTarget).toBeNull();
  // Under it, its group's tab: where closing the editor lands.
  expect(tab(host, "call")?.getAttribute("aria-selected")).toBe("true");
  const editor = document.querySelector(".prompt-editor-modal")!;
  expect(editor.querySelector("h2")?.textContent).toBe("标题 call.scribe");
  expect(editor.querySelector('[data-view="history"]')?.getAttribute("aria-selected")).toBe("true");
  expect(editor.querySelector('[data-revision="r7"] .prompt-diff .diff-add')?.textContent).toBe("记下来。");
  // Keyboard focus came along from the card, so Escape closes this editor.
  expect(document.activeElement?.classList.contains("prompt-editor-backdrop")).toBe(true);
  close();
});
