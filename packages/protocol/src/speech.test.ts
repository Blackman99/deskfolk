import { describe, expect, test } from "bun:test";
import { SPEECH_PRESETS, isSpeechFormat, isSpeechPresetId, speechPreset, speechReady, type SpeechSettings } from "./index.ts";

const ready: SpeechSettings = {
  enabled: true,
  preset: "openai",
  format: "openai",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini-transcribe",
  language: null,
  key_set: true,
};

describe("speech presets", () => {
  test("every preset names a known format, and only custom leaves the address empty", () => {
    for (const preset of SPEECH_PRESETS) {
      expect(isSpeechFormat(preset.format)).toBe(true);
      expect(isSpeechPresetId(preset.id)).toBe(true);
      expect(Boolean(preset.base_url)).toBe(preset.id !== "custom");
      if (preset.models.length) expect(preset.models[0]).toBe(preset.model);
    }
  });

  test("an unknown id reads as custom", () => {
    expect(speechPreset("groq").base_url).toBe("https://api.groq.com/openai/v1");
    expect(speechPreset("nope" as never).id).toBe("custom");
  });
});

describe("speechReady", () => {
  test("needs it on, an address, a model and a key", () => {
    expect(speechReady(ready)).toBe(true);
    expect(speechReady(null)).toBe(false);
    expect(speechReady(undefined)).toBe(false);
    expect(speechReady({ ...ready, enabled: false })).toBe(false);
    expect(speechReady({ ...ready, base_url: null })).toBe(false);
    expect(speechReady({ ...ready, model: null })).toBe(false);
    expect(speechReady({ ...ready, key_set: false })).toBe(false);
  });

  test("a server on this computer or network needs no key", () => {
    expect(speechReady({ ...ready, preset: "custom", base_url: "http://127.0.0.1:8000/v1", key_set: false })).toBe(true);
  });
});
