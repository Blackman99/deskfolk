import { expect, test } from "bun:test";
import type { PatchSpeechRequest, Provider, SpeechSettings } from "@real-bot/protocol";
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
  key_provider_id: null,
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

const tokenPlan = {
  id: "p-tp", name: "阿里百炼", base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api_format: "openai",
  key_set: true, models: ["qwen3.6-plus"], model_catalog: [], available_models: [], default_model: null, created_at: "", updated_at: "",
} as Provider;

test("a Bailian Token Plan endpoint is offered as a shortcut: one press points speech at it, with its key", async () => {
  const { sent, patch } = fakePatch();
  const view = render(SpeechCard, { speech: null, providers: [tokenPlan], patch, t });
  const offer = view.host.querySelector("[data-speech-shortcut='p-tp']");
  expect(offer?.textContent).toContain(t.speech.shortcut(t.speech.shortcutVendor.qwen, "阿里百炼", t.connectors.plan["qwen:token-plan"]));
  click(offer?.querySelector("button"));
  await sleep(0);
  expect(sent).toEqual([{
    enabled: true, preset: "bailian_token_plan", format: "dashscope",
    base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com", model: "qwen-audio-3.0-asr-flash", key_provider_id: "p-tp",
  }]);
  view.close();
});

test("a Xiaomi MiMo endpoint is offered too, and MiMo's language picker has only Chinese and English", async () => {
  const { sent, patch } = fakePatch();
  const mimo = { ...tokenPlan, id: "p-mimo", name: "小米", base_url: "https://token-plan-cn.xiaomimimo.com/v1" } as Provider;
  const view = render(SpeechCard, { speech: null, providers: [mimo], patch, t });
  const offer = view.host.querySelector("[data-speech-shortcut='p-mimo']");
  expect(offer?.textContent).toContain(t.speech.shortcut(t.speech.shortcutVendor.xiaomi, "小米", t.connectors.plan["xiaomi:token-plan-cn"]));
  click(offer?.querySelector("button"));
  await sleep(0);
  expect(sent).toEqual([{
    enabled: true, preset: "xiaomi", format: "mimo", base_url: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.5-asr", key_provider_id: "p-mimo",
  }]);
  view.close();

  const japanese = render(SpeechCard, { speech: { ...groq, language: "ja" }, providers: [mimo], patch, t });
  click(japanese.host.querySelector("[data-speech-shortcut='p-mimo'] button"));
  await sleep(0);
  expect(sent.at(-1)).toMatchObject({ preset: "xiaomi", language: null });
  japanese.close();

  const linked: SpeechSettings = { ...groq, preset: "xiaomi", format: "mimo", base_url: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.5-asr", key_provider_id: "p-mimo", key_set: true };
  const card = render(SpeechCard, { speech: linked, providers: [mimo], patch, t });
  click(card.host.querySelectorAll(".speech-field .real-select-trigger")[1]!);
  await sleep(0);
  expect([...card.host.querySelectorAll(".real-select-option")].map((el) => el.textContent?.trim())).toEqual([t.speech.languageAuto, "中文", "English"]);
  card.close();
});

test("speech taking an endpoint's key says whose, offers no shortcut to itself, and can stop taking it", async () => {
  const { sent, patch } = fakePatch();
  const linked: SpeechSettings = { ...groq, preset: "bailian_token_plan", format: "dashscope", base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com", model: "qwen-audio-3.0-asr-flash", key_provider_id: "p-tp", key_set: true };
  const view = render(SpeechCard, { speech: linked, providers: [tokenPlan], patch, t });
  expect(view.host.querySelector("[data-speech-shortcut]")).toBeNull();
  expect(view.host.querySelector('input[type="password"]')).toBeNull();
  const row = view.host.querySelector("[data-speech-key-linked]");
  expect(row?.textContent).toContain(t.speech.keyLinked("阿里百炼"));
  expect(view.host.querySelector("[data-speech-status]")?.textContent).toBe(t.speech.ready);
  click(row?.querySelector("button"));
  await sleep(0);
  expect(sent).toEqual([{ key_provider_id: null }]);
  view.close();
});

test("no Bailian endpoint, or one without a key, offers nothing", () => {
  const { patch } = fakePatch();
  const view = render(SpeechCard, { speech: groq, providers: [{ ...tokenPlan, key_set: false }, { ...tokenPlan, id: "x", base_url: "https://api.openai.com/v1" }], patch, t });
  expect(view.host.querySelector("[data-speech-shortcut]")).toBeNull();
  view.close();
});

test("DashScope's own API shows the host hint and no language, which it ignores", () => {
  const { patch } = fakePatch();
  const view = render(SpeechCard, { speech: { ...groq, preset: "bailian_token_plan", format: "dashscope", base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com", model: "qwen-audio-3.0-asr-flash" }, patch, t });
  expect(view.host.querySelector(".speech-note")?.textContent).toBe(t.speech.baseUrlHintDashscope);
  expect([...view.host.querySelectorAll(".speech-label")].map((el) => el.textContent)).not.toContain(t.speech.language);
  view.close();
});

test("each service wears its vendor's logo, in the menu and on the closed picker; Bailian's are Qwen's", async () => {
  const { patch } = fakePatch();
  const view = render(SpeechCard, { speech: groq, patch, t });
  const trigger = view.host.querySelector(".speech-field .real-select-trigger")!;
  expect(trigger.querySelector("[data-model-source]")?.getAttribute("data-model-source")).toBe("groq");
  click(trigger);
  await sleep(0);
  const rows = [...view.host.querySelectorAll(".real-select-option")];
  expect(rows.map((row) => row.querySelector("[data-model-source]")?.getAttribute("data-model-source"))).toEqual([
    "openai", "groq", "siliconflow", "qwen", "qwen", "xiaomi", "deepgram", "elevenlabs", "custom",
  ]);
  expect(rows.map((row) => row.textContent?.trim())).toEqual(Object.values(t.speech.presets));
  view.close();
});
