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

const items = [item("turn.system", "turn", "edited"), item("tool.shell", "tool"), item("tool.send_message", "tool"), item("call.scribe", "call", "edited", 3)];

test("prompts list by group, tool descriptions folded, edits and unreadable answers marked", () => {
  const runtime = fakeRuntime({ bots: [{ id: "b1", name: "调优员" } as never] });
  const { host, close } = render(PromptsSettings, { runtime, t, items });
  const groups = [...host.querySelectorAll("[data-prompt-group]")].map((el) => el.getAttribute("data-prompt-group"));
  expect(groups).toEqual(["turn", "tool", "call"]);
  // Tool descriptions are folded until you open them.
  expect(host.querySelector('[data-prompt="tool.shell"]')).toBeNull();
  click(host.querySelector(".prompts-group-toggle"));
  expect(host.querySelector('[data-prompt="tool.shell"]')).toBeTruthy();
  const scribe = host.querySelector('[data-prompt="call.scribe"]')!;
  expect(scribe.textContent).toContain("已改 · 调优员改的");
  expect(scribe.textContent).toContain("读不懂 3 次");
  // A search opens every group it matches.
  click(host.querySelector(".prompts-group-toggle"));
  fill(host.querySelector(".prompts-search"), "send_message");
  expect([...host.querySelectorAll("[data-prompt]")].map((el) => el.getAttribute("data-prompt"))).toEqual(["tool.send_message"]);
  fill(host.querySelector(".prompts-search"), "nothing like it");
  expect(host.textContent).toContain(t.prompts.noMatch);
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
  expect((app as unknown as { backFromEditor: () => boolean }).backFromEditor()).toBe(true);
  await sleep(10);
  flushSync();
  expect(document.querySelector(".prompt-editor-modal")).toBeNull();
  close();
});
