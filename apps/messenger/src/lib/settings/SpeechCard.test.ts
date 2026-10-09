import { expect, test } from "bun:test";
import type { PatchSpeechRequest, SpeechSettings } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { click, fill, render } from "../test-render.ts";
import SpeechCard from "./SpeechCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const groq: SpeechSettings = {
  enabled: true,
  preset: "groq",
  format: "openai",
  base_url: "https://api.groq.com/openai/v1",
  model: "whisper-large-v3-turbo",
  language: null,
  key_set: false,
};

function fakePatch(opts: { fail?: boolean } = {}) {
  const sent: PatchSpeechRequest[] = [];
  return { sent, patch: async (patch: PatchSpeechRequest) => { sent.push(patch); return opts.fail ? { code: "conflict" } : null; } };
}

async function pick(host: HTMLElement, field: number, label: string): Promise<void> {
  click(host.querySelectorAll(".speech-field .real-select-trigger")[field]!);
  await sleep(0);
  const option = [...host.querySelectorAll(".real-select-option")].find((el) => el.textContent?.trim() === label);
  expect(option).toBeDefined();
  click(option!);
  await sleep(0);
}

test("before a service is picked only the service shows; picking one fills in its format, address and model", async () => {
  const { sent, patch } = fakePatch();
  const view = render(SpeechCard, { speech: null, patch, t });
  expect(view.host.querySelector("input")).toBeNull();
  expect(view.host.querySelector("[data-speech-status]")).toBeNull();
  await pick(view.host, 0, t.speech.presets.siliconflow);
  expect(sent).toEqual([{ preset: "siliconflow", format: "openai", base_url: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" }]);
  view.close();
});

test("what is still missing is named, and the key is saved when you leave its box, never shown", async () => {
  const { sent, patch } = fakePatch();
  const view = render(SpeechCard, { speech: groq, patch, t });
  expect(view.host.querySelector("[data-speech-status]")?.textContent).toBe(t.speech.missingKey);
  const key = view.host.querySelector<HTMLInputElement>('input[type="password"]')!;
  fill(key, "  gsk-new  ");
  key.dispatchEvent(new FocusEvent("blur"));
  await sleep(0);
  expect(sent).toEqual([{ api_key: "gsk-new" }]);
  flushSync();
  expect(key.value).toBe("");
  view.close();
});

test("a ready endpoint says so; clearing the key and switching off are saved", async () => {
  const { sent, patch } = fakePatch();
  const view = render(SpeechCard, { speech: { ...groq, key_set: true }, patch, t });
  expect(view.host.querySelector("[data-speech-status]")?.textContent).toBe(t.speech.ready);
  expect(view.host.querySelector<HTMLInputElement>('input[type="password"]')!.placeholder).toBe(t.speech.keySaved);
  click(view.host.querySelector(".speech-key-clear"));
  await sleep(0);
  flushSync();
  const toggle = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  click(toggle);
  await sleep(0);
  expect(sent).toEqual([{ api_key: "" }, { enabled: false }]);
  view.close();
});

test("the address and model save as you type; only a custom service shows the format", async () => {
  const { sent, patch } = fakePatch();
  const view = render(SpeechCard, { speech: groq, patch, t });
  expect(view.host.querySelectorAll(".speech-field .real-select-trigger")).toHaveLength(2);
  const [url, model] = [...view.host.querySelectorAll<HTMLInputElement>('input[type="text"]')];
  fill(url!, "http://127.0.0.1:8000/v1 ");
  url!.dispatchEvent(new Event("input"));
  fill(model!, "Systran/faster-whisper-small");
  model!.dispatchEvent(new Event("input"));
  await sleep(700);
  expect(sent).toEqual([{ base_url: "http://127.0.0.1:8000/v1", model: "Systran/faster-whisper-small" }]);
  view.close();

  const custom = render(SpeechCard, { speech: { ...groq, preset: "custom" }, patch, t });
  expect(custom.host.querySelectorAll(".speech-field .real-select-trigger")).toHaveLength(3);
  custom.close();
});

test("a language and a custom format are saved as picked", async () => {
  const { sent, patch } = fakePatch();
  const view = render(SpeechCard, { speech: { ...groq, preset: "custom" }, patch, t });
  await pick(view.host, 1, t.speech.formats.qwen_asr);
  await pick(view.host, 2, "中文");
  await pick(view.host, 2, t.speech.languageAuto);
  expect(sent).toEqual([{ format: "qwen_asr" }, { language: "zh" }, { language: null }]);
  view.close();
});

test("a save that fails says so", async () => {
  const { patch } = fakePatch({ fail: true });
  const view = render(SpeechCard, { speech: null, patch, t });
  await pick(view.host, 0, t.speech.presets.openai);
  flushSync();
  expect(view.host.querySelector(".speech-error")?.textContent).toBe(t.speech.failed);
  view.close();
});
