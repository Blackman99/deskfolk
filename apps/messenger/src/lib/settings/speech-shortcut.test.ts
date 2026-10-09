import { expect, test } from "bun:test";
import type { Provider, SpeechSettings } from "@real-bot/protocol";
import { offeredShortcuts, speechShortcuts } from "./speech-shortcut.ts";

function provider(over: Partial<Provider>): Provider {
  return {
    id: "p1", name: "阿里百炼", base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api_format: "openai",
    key_set: true, models: [], model_catalog: [], available_models: [], default_model: null, created_at: "", updated_at: "", ...over,
  } as Provider;
}

test("a Token Plan endpoint points speech at DashScope's own API on its host, with its key", () => {
  expect(speechShortcuts([provider({})])).toEqual([{
    provider: provider({}),
    planKey: "qwen:token-plan",
    patch: {
      enabled: true, preset: "bailian_token_plan", format: "dashscope",
      base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com", model: "qwen-audio-3.0-asr-flash", key_provider_id: "p1",
    },
  }]);
});

test("a pay-as-you-go endpoint takes Qwen ASR at its compatible-mode address", () => {
  const [only] = speechShortcuts([provider({ id: "p2", base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" })]);
  expect(only!.planKey).toBe("qwen:payg-intl");
  expect(only!.patch).toMatchObject({ preset: "bailian", format: "qwen_asr", base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen3-asr-flash", key_provider_id: "p2" });
});

test("other vendors, endpoints without a key and Anthropic-format Bailian addresses are not offered", () => {
  expect(speechShortcuts([
    provider({ id: "a", base_url: "https://api.anthropic.com", api_format: "anthropic" }),
    provider({ id: "b", key_set: false }),
    provider({ id: "c", base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", api_format: "anthropic" }),
    provider({ id: "d", base_url: "https://cpa.example.com/v1" }),
  ])).toEqual([]);
});

test("one already in use is not offered again", () => {
  const speech: SpeechSettings = { enabled: true, preset: "bailian_token_plan", format: "dashscope", base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com", model: "qwen-audio-3.0-asr-flash", language: null, key_provider_id: "p1", key_set: true };
  expect(offeredShortcuts([provider({})], speech)).toEqual([]);
  expect(offeredShortcuts([provider({})], { ...speech, enabled: false })).toHaveLength(1);
  expect(offeredShortcuts([provider({})], { ...speech, key_provider_id: null })).toHaveLength(1);
});
