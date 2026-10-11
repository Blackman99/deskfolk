/**
 * One of the app's own calls changed where it is shown — a step's panel on the flow (ADR 0083) —
 * with its model and prompts as Roles has them, a prompt opening in the editor over the window.
 */
import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import CallEditor from "./CallEditor.svelte";
import { closeMessageText, holdBack, messageTextOpen } from "../chat/message-text-pages.ts";
import { noBuiltinModels } from "./builtin-models.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const promptRow = (id: string, role: string) => ({
  id, group: "call", role, title: { zh: `标题 ${id}`, en: `Title ${id}` }, summary: { zh: `说明 ${id}`, en: `About ${id}` },
  locales: [{ locale: "zh", state: "default", last_actor: null, last_bot_id: null, updated_at: null, parse_failures: null }],
});

function open() {
  const provider = aProvider({ models: ["gemini-3.8-flash", "grok-4.6"] });
  const runtime = fakeRuntime({
    providers: [provider],
    settings: {
      endpoint_default_model: provider.default_model,
      default_provider_id: provider.id,
      builtin_models: noBuiltinModels() as never,
      locale: "zh",
      wizard_complete: true,
    } as never,
  });
  runtime.client = {
    listPrompts: async () => [promptRow("call.organizer", "organizer"), promptRow("call.read_user_line", "reader"), promptRow("call.read_bot_line", "reader")],
    getPrompt: () => new Promise(() => {}),
    claudeCode: async () => { throw new Error("404"); },
    agents: async () => { throw new Error("404"); },
  } as never;
  return { ...render(CallEditor, { runtime, t, role: "reader" }), runtime };
}

test("a call's model and its own prompts, and a prompt opens over the window, Back closing it before the panel", async () => {
  // The step's panel holds Back already, as the flow does while it is open.
  let panelBack = 0;
  const releasePanel = holdBack(() => (panelBack += 1));
  const { host, close } = open();
  try {
    await sleep(10);
    flushSync();
    expect(host.querySelector('[data-routing-detail="reader"] [data-side-model="reader"]')).toBeTruthy();
    expect([...host.querySelectorAll("[data-prompt]")].map((el) => el.getAttribute("data-prompt"))).toEqual(["call.read_user_line", "call.read_bot_line"]);
    click(host.querySelector('[data-prompt="call.read_bot_line"]'));
    await sleep(10);
    flushSync();
    // Over the window, not inside the panel that scrolls and clips.
    const editor = document.querySelector(".prompt-editor-backdrop");
    expect(editor?.querySelector(".prompt-editor-modal h2")?.textContent).toBe("标题 call.read_bot_line");
    expect(host.contains(editor)).toBe(false);
    // The keyboard is in it, the text still on its way, so Escape is the editor's.
    expect(document.activeElement?.closest(".prompt-editor-backdrop")).toBe(editor);
    expect(closeMessageText()).toBe(true);
    await sleep(10);
    flushSync();
    expect(document.querySelector(".prompt-editor-backdrop")).toBeNull();
    expect(panelBack).toBe(0);
    // The next Back is the panel's.
    expect(messageTextOpen()).toBe(true);
    expect(closeMessageText()).toBe(true);
    expect(panelBack).toBe(1);
  } finally {
    releasePanel();
    close();
  }
});
