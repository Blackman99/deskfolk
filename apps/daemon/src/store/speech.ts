/**
 * The speech endpoint (ADR 0073): what the composer's microphone sends to. Kept as `speech_*`
 * rows in `settings`, the key in the keychain under its own name, read back as `Settings.speech`
 * and changed through `PATCH /v1/speech` (its key's field there is `api_key`, which a resumed
 * receipt reads back; `/v1/settings` reads `endpoint_api_key`). Instead of a key of its own it can
 * take a model endpoint's (`speech_key_provider_id`), read at each call: a Bailian endpoint's key
 * serves Bailian's speech model too.
 */
import {
  SPEECH_KEYCHAIN_NAME,
  isSpeechFormat,
  providerKeychainName,
  isSpeechPresetId,
  speechPreset,
  type PatchSpeechRequest,
  type SpeechFormat,
  type SpeechSettings,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { providersCached } from "./providers";
import { type StoreContext, emptyToNull, planKey, requireProvider, setSetting, settingsMap } from "./shared";

const FIELDS = ["enabled", "preset", "format", "base_url", "model", "language", "key_provider_id", "api_key"] as const;

/** The endpoint whose key speech takes, while it exists. */
function keyProvider(ctx: StoreContext, map = settingsMap(ctx)) {
  const id = emptyToNull(map.get("speech_key_provider_id"));
  return id ? (providersCached(ctx).find((provider) => provider.id === id) ?? null) : null;
}

/** Set up at least once: a service was picked. Null before, so a fresh install reads no speech. */
export function speechSettings(ctx: StoreContext): SpeechSettings | null {
  const map = settingsMap(ctx);
  const preset = map.get("speech_preset");
  if (!isSpeechPresetId(preset)) return null;
  const format = map.get("speech_format");
  const planned = ctx.keyPlan?.find((op) => op.name === SPEECH_KEYCHAIN_NAME);
  const provider = keyProvider(ctx, map);
  return {
    enabled: map.get("speech_enabled") === "1",
    preset,
    format: isSpeechFormat(format) ? format : speechPreset(preset).format,
    base_url: emptyToNull(map.get("speech_base_url")),
    model: emptyToNull(map.get("speech_model")),
    language: emptyToNull(map.get("speech_language")),
    key_provider_id: provider?.id ?? null,
    key_set: provider ? provider.key_set : planned ? planned.value.length > 0 : ctx.keys.peek(SPEECH_KEYCHAIN_NAME) != null,
  };
}

/** Reads the key into the cache once speech is set up, so `key_set` is right in the snapshot. */
export async function hydrateSpeechKey(ctx: StoreContext): Promise<void> {
  if (settingsMap(ctx).get("speech_preset")) await ctx.keys.read(SPEECH_KEYCHAIN_NAME);
}

export async function speechKey(ctx: StoreContext): Promise<string | null> {
  const provider = keyProvider(ctx);
  return ctx.keys.read(provider ? providerKeychainName(provider.id) : SPEECH_KEYCHAIN_NAME);
}

function speechUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "base_url must be a string");
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(422, "invalid_args", "base_url must be an http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(422, "invalid_args", "base_url must be an http or https URL");
  }
  return trimmed.replace(/\/+$/, "");
}

function speechLanguage(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string" || (value !== "" && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value))) {
    throw new HttpError(422, "invalid_args", "language must be null or a language code such as zh or en");
  }
  return value;
}

/**
 * Applies a `PATCH /v1/speech`. Picking a service for the first time fills in its format, address
 * and model unless the patch names them; after that a field changes only when named, so switching
 * services is the form's to fill. Must run inside a key plan (`keyMutation` / `planKeys`).
 */
export function patchSpeechSync(ctx: StoreContext, patch: PatchSpeechRequest | Record<string, unknown>): SpeechSettings {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new HttpError(422, "invalid_args", "PATCH body must include at least one field");
  for (const key of keys) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new HttpError(422, "invalid_args", `unknown speech field: ${key}`);
  }
  const body = patch as Record<string, unknown>;
  if ("enabled" in body && typeof body.enabled !== "boolean") throw new HttpError(422, "invalid_args", "enabled must be a boolean");
  if ("preset" in body && !isSpeechPresetId(body.preset)) throw new HttpError(422, "invalid_args", "preset is not a known speech service");
  if ("format" in body && !isSpeechFormat(body.format)) throw new HttpError(422, "invalid_args", "format is not a known speech format");
  if ("model" in body && typeof body.model !== "string") throw new HttpError(422, "invalid_args", "model must be a string");
  if ("api_key" in body && typeof body.api_key !== "string") throw new HttpError(422, "invalid_args", "api_key must be a string");
  if ("key_provider_id" in body && body.key_provider_id !== null) {
    if (typeof body.key_provider_id !== "string") throw new HttpError(422, "invalid_args", "key_provider_id must be an endpoint id or null");
    requireProvider(ctx, body.key_provider_id);
  }
  const baseUrl = "base_url" in body ? speechUrl(body.base_url) : undefined;
  const language = "language" in body ? speechLanguage(body.language) : undefined;
  const before = speechSettings(ctx);
  const preset = (body.preset as SpeechSettings["preset"] | undefined) ?? before?.preset ?? "custom";
  const first = before === null ? speechPreset(preset) : null;
  ctx.commit(() => {
    setSetting(ctx, "speech_preset", preset);
    if ("enabled" in body) setSetting(ctx, "speech_enabled", body.enabled ? "1" : "0");
    else if (first) setSetting(ctx, "speech_enabled", "1");
    const format = (body.format as SpeechFormat | undefined) ?? first?.format;
    if (format) setSetting(ctx, "speech_format", format);
    const url = baseUrl ?? first?.base_url;
    if (url !== undefined) setSetting(ctx, "speech_base_url", url);
    const model = "model" in body ? (body.model as string).trim() : first?.model;
    if (model !== undefined) setSetting(ctx, "speech_model", model);
    if (language !== undefined) setSetting(ctx, "speech_language", language);
    // A key typed in for speech is what it uses from then on, unless the same patch names an endpoint.
    if ("key_provider_id" in body) setSetting(ctx, "speech_key_provider_id", (body.key_provider_id as string | null) ?? "");
    else if (typeof body.api_key === "string" && body.api_key.length > 0) setSetting(ctx, "speech_key_provider_id", "");
    // As sent: a resumed receipt reads the key back from the body and checks its digest.
    if ("api_key" in body) planKey(ctx, SPEECH_KEYCHAIN_NAME, body.api_key as string);
    ctx.db.run("UPDATE request_meta SET settings_rev = settings_rev + 1 WHERE singleton = 1");
  });
  return speechSettings(ctx)!;
}
