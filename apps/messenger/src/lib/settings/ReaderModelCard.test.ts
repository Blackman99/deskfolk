import { expect, test } from "bun:test";
import type { Provider, SettingsPatch } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import ReaderModelCard from "./ReaderModelCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const providers = [
  { id: "p1", name: "My CPA", models: ["grok-4.7-build-fast", "gemini-3.8-flash-high"] },
  { id: "p2", name: "阿里百炼", models: ["deepseek-v4.1-flash"] },
] as unknown as Provider[];

function fakePatch(opts: { fail?: boolean } = {}) {
  const sent: SettingsPatch[] = [];
  return { sent, patch: async (patch: SettingsPatch) => { sent.push(patch); return opts.fail ? { code: "conflict" } : null; } };
}

const trigger = (host: HTMLElement) => host.querySelector(".reader-pick .real-select-trigger")!;

test("following the default names the default model; every listed model can be chosen, and the choice is saved", async () => {
  const { sent, patch } = fakePatch();
  const view = render(ReaderModelCard, { providers, chosen: null, defaultModel: "grok-4.7-build-fast", patch, t });
  expect(trigger(view.host).textContent).toContain(t.readerModel.followDefault("grok-4.7-build-fast"));
  click(trigger(view.host));
  await sleep(0);
  const options = [...view.host.querySelectorAll(".real-select-option")];
  expect(options.map((el) => el.textContent?.trim())).toEqual([
    t.readerModel.followDefault("grok-4.7-build-fast"),
    "grok-4.7-build-fast · My CPA",
    "gemini-3.8-flash-high · My CPA",
    "deepseek-v4.1-flash · 阿里百炼",
  ]);
  click(options[3]!);
  await sleep(0);
  expect(sent).toEqual([{ reader_model: { provider_id: "p2", model: "deepseek-v4.1-flash" } }]);
  view.close();
});

test("a chosen model shows as chosen, and following the default again saves null", async () => {
  const { sent, patch } = fakePatch();
  const view = render(ReaderModelCard, { providers, chosen: { provider_id: "p2", model: "deepseek-v4.1-flash" }, defaultModel: "grok-4.7-build-fast", patch, t });
  expect(trigger(view.host).textContent).toContain("deepseek-v4.1-flash · 阿里百炼");
  click(trigger(view.host));
  await sleep(0);
  click(view.host.querySelectorAll(".real-select-option")[0]!);
  await sleep(0);
  expect(sent).toEqual([{ reader_model: null }]);
  view.close();
});

test("a choice that is not saved says so", async () => {
  const { patch } = fakePatch({ fail: true });
  const view = render(ReaderModelCard, { providers, chosen: null, defaultModel: null, patch, t });
  click(trigger(view.host));
  await sleep(0);
  click(view.host.querySelectorAll(".real-select-option")[1]!);
  await sleep(0);
  expect(view.host.querySelector(".reader-error")?.textContent).toBe(t.readerModel.failed);
  view.close();
});
