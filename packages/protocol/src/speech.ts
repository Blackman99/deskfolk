import { isLocalEndpoint } from "./local-endpoint.ts";

/**
 * Speech recognition (ADR 0073): what you say into the composer's microphone goes to a
 * speech-to-text endpoint you set up in Settings, and comes back as text in the box, where you
 * read it over before sending. The audio passes through the daemon, which holds the key.
 */

/**
 * How a speech endpoint is spoken to:
 * - `openai`: `POST …/audio/transcriptions`, multipart `file` + `model`, a Bearer key, `{ text }`
 *   back. OpenAI's, and what Groq, SiliconFlow, Mistral and local Whisper servers copy.
 * - `qwen_asr`: `POST …/chat/completions` with the audio as an `input_audio` data URI, a Bearer
 *   key, the text in `choices[0].message.content`. Qwen-ASR on Bailian (DashScope).
 * - `deepgram`: `POST …/listen?model=…`, the audio as the body, `Authorization: Token …`.
 * - `elevenlabs`: `POST …/speech-to-text`, multipart `file` + `model_id`, an `xi-api-key`.
 * - `dashscope`: DashScope's own `POST /api/v1/services/aigc/multimodal-generation/generation`,
 *   the audio as an `input_audio` data URI with `parameters.format` and `sample_rate` (without
 *   them it answers 400 `{}`), a Bearer key, the text in `output.text`. Qwen-Audio-ASR, the only
 *   way Bailian's Token Plan takes speech.
 */
export const SPEECH_FORMATS = ["openai", "qwen_asr", "deepgram", "elevenlabs", "dashscope"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

export function isSpeechFormat(value: unknown): value is SpeechFormat {
  return typeof value === "string" && (SPEECH_FORMATS as readonly string[]).includes(value);
}

export const SPEECH_PRESET_IDS = ["openai", "groq", "siliconflow", "bailian", "bailian_token_plan", "deepgram", "elevenlabs", "custom"] as const;
export type SpeechPresetId = (typeof SPEECH_PRESET_IDS)[number];

export function isSpeechPresetId(value: unknown): value is SpeechPresetId {
  return typeof value === "string" && (SPEECH_PRESET_IDS as readonly string[]).includes(value);
}

/** A known service: picking it fills in the format, the address and a model, all of which stay editable. */
export type SpeechPreset = {
  id: SpeechPresetId;
  format: SpeechFormat;
  base_url: string;
  /** What a fresh pick fills in; the first of `models`. */
  model: string;
  /** Model names the service documents for this, offered as suggestions. */
  models: readonly string[];
};

export const SPEECH_PRESETS: readonly SpeechPreset[] = [
  { id: "openai", format: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", models: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"] },
  { id: "groq", format: "openai", base_url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", models: ["whisper-large-v3-turbo", "whisper-large-v3"] },
  { id: "siliconflow", format: "openai", base_url: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall", models: ["FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR"] },
  { id: "bailian", format: "qwen_asr", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-asr-flash", models: ["qwen3-asr-flash"] },
  // Token Plan's key is its own and works only on its own host; its one speech model speaks DashScope's protocol.
  { id: "bailian_token_plan", format: "dashscope", base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com", model: "qwen-audio-3.0-asr-flash", models: ["qwen-audio-3.0-asr-flash"] },
  { id: "deepgram", format: "deepgram", base_url: "https://api.deepgram.com/v1", model: "nova-3", models: ["nova-3", "nova-2"] },
  { id: "elevenlabs", format: "elevenlabs", base_url: "https://api.elevenlabs.io/v1", model: "scribe_v2", models: ["scribe_v2", "scribe_v1"] },
  { id: "custom", format: "openai", base_url: "", model: "", models: [] },
];

export function speechPreset(id: SpeechPresetId): SpeechPreset {
  return SPEECH_PRESETS.find((preset) => preset.id === id) ?? SPEECH_PRESETS[SPEECH_PRESETS.length - 1]!;
}

/** Languages offered for the endpoint to expect; null lets it tell for itself. ISO 639-1. */
export const SPEECH_LANGUAGES = ["zh", "en", "ja", "ko", "fr", "de", "es"] as const;

/** `Settings.speech`: the speech endpoint, without its key. */
export type SpeechSettings = {
  /** Off, the composer shows no microphone; what was filled in is kept. */
  enabled: boolean;
  preset: SpeechPresetId;
  format: SpeechFormat;
  base_url: string | null;
  model: string | null;
  /** The language to expect, or null to let the endpoint tell. */
  language: string | null;
  /**
   * The model endpoint whose key the speech service is called with, read at each call (a Bailian
   * endpoint's key serves its speech model too); null uses the speech service's own key. Null as
   * well once that endpoint is gone.
   */
  key_provider_id: string | null;
  /** That endpoint's key when one is named, else the speech service's own. */
  key_set: boolean;
};

/**
 * `PATCH /v1/speech`. A field left out keeps its value; `api_key: ""` removes the key. The key is
 * kept in the system keychain with the endpoints' and is never sent back.
 */
export type PatchSpeechRequest = {
  enabled?: boolean;
  preset?: SpeechPresetId;
  format?: SpeechFormat;
  base_url?: string;
  model?: string;
  language?: string | null;
  /** An endpoint to take the key from, or null to use the speech service's own. */
  key_provider_id?: string | null;
  /** The speech service's own key; a non-empty one also stops taking an endpoint's (unless `key_provider_id` is in the same patch). */
  api_key?: string;
};

/**
 * `POST /v1/speech/transcribe`: one recording, base64, with the type the recorder gave it. The
 * daemon sends it to the speech endpoint as it is; nothing is stored. No request receipt (see
 * `isNonReceiptPath`): a repeat only transcribes again.
 */
export type TranscribeRequest = {
  audio: string;
  /** The recording's MIME type, e.g. `audio/webm;codecs=opus` or `audio/mp4`. */
  mime: string;
};

export type TranscribeResponse = { text: string };

/**
 * The most base64 one recording may carry: the whole request has to fit the remote link's one
 * megabyte logical message, the same bound an annotation's crop has. Compressed speech is a few
 * kilobytes a second, so this is minutes.
 */
export const SPEECH_AUDIO_BASE64_MAX = 1_000_000;

/** The longest recording the composer takes before it stops by itself and transcribes. */
export const SPEECH_MAX_SECONDS = 180;

/** Ready to use: on, with an address, a model, and a key unless the endpoint is on this computer or network. */
export function speechReady(speech: SpeechSettings | null | undefined): boolean {
  if (!speech?.enabled || !speech.base_url || !speech.model) return false;
  return speech.key_set || isLocalEndpoint(speech.base_url);
}
