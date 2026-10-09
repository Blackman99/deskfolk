import { expect, test } from "bun:test";
import type { Provider, SettingsPatch } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import OrganizerModelCard from "./OrganizerModelCard.svelte";

const t = copyFor("zh");
const en = copyFor("en");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const providers = [
  { id: "p1", name: "My CPA", models: ["grok-4.7-build-fast", "claude-opus-5"] },
  { id: "p2", name: "阿里百炼", models: ["deepseek-v4.1-flash"] },
] as unknown as Provider[];

function fakePatch(opts: { fail?: boolean } = {}) {
  const sent: SettingsPatch[] = [];
  return { sent, patch: async (patch: SettingsPatch) => { sent.push(patch); return opts.fail ? { code: "conflict" } : null; } };
}

const trigger = (host: HTMLElement) => host.querySelector(".side-model-pick .real-select-trigger")!;
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();

test("it follows the default by default, lists every endpoint model, and saves the one chosen as the organizing model", async () => {
  const { sent, patch } = fakePatch();
  const view = render(OrganizerModelCard, { providers, chosen: null, defaultModel: "grok-4.7-build-fast", patch, t });
  expect(view.host.querySelector('[data-side-model="organizer"]')).toBeTruthy();
  expect(view.host.querySelector('[data-side-model="reader"]')).toBeNull();
  expect(trigger(view.host).textContent).toContain(t.organizerModel.followDefault("grok-4.7-build-fast"));
  click(trigger(view.host));
  await sleep(0);
  const options = [...view.host.querySelectorAll(".real-select-option")];
  expect(options.map(text)).toEqual([
    t.organizerModel.followDefault("grok-4.7-build-fast"),
    "grok-4.7-build-fast My CPA",
    "claude-opus-5 My CPA",
    "deepseek-v4.1-flash 阿里百炼",
  ]);
  click(options[2]!);
  await sleep(0);
  expect(sent).toEqual([{ organizer_model: { provider_id: "p1", model: "claude-opus-5" } }]);
  view.close();
});

test("a chosen model shows as chosen, and following the default again saves null", async () => {
  const { sent, patch } = fakePatch();
  const view = render(OrganizerModelCard, { providers, chosen: { provider_id: "p1", model: "claude-opus-5" }, defaultModel: "grok-4.7-build-fast", patch, t });
  expect(text(trigger(view.host))).toBe("claude-opus-5 My CPA");
  click(trigger(view.host));
  await sleep(0);
  click(view.host.querySelectorAll(".real-select-option")[0]!);
  await sleep(0);
  expect(sent).toEqual([{ organizer_model: null }]);
  view.close();
});

test("a choice that is not saved says so", async () => {
  const { patch } = fakePatch({ fail: true });
  const view = render(OrganizerModelCard, { providers, chosen: null, defaultModel: null, patch, t });
  click(trigger(view.host));
  await sleep(0);
  click(view.host.querySelectorAll(".real-select-option")[1]!);
  await sleep(0);
  expect(view.host.querySelector(".side-model-error")?.textContent).toBe(t.organizerModel.failed);
  view.close();
});

test("no Claude models are offered: no group, no account select, no note", async () => {
  const view = render(OrganizerModelCard, { providers, chosen: null, defaultModel: null, patch: fakePatch().patch, t });
  await sleep(0);
  click(trigger(view.host));
  await sleep(0);
  expect(view.host.querySelector(".real-select-group")).toBeNull();
  expect(view.host.querySelector("[data-side-model-claude-note]")).toBeNull();
  expect(view.host.querySelector("[data-side-model-account]")).toBeNull();
  view.close();
});

test("the copy says what the model is for, in both languages, and names the Claude-less choice only as the default", () => {
  expect(t.organizerModel.title).toBe("整理模型");
  expect(en.organizerModel.title).toBe("Organizing model");
  expect(t.organizerModel.hint).toContain("整理器、书记员");
  expect(t.organizerModel.hint).toContain("输入 20k、输出 6k token");
  expect(en.organizerModel.hint).toContain("the organizer, the scribe");
  expect(en.organizerModel.hint).toContain("20k tokens in and 6k out");
  expect(en.organizerModel.followDefault("m")).toBe("Follow the default model (m)");
});
