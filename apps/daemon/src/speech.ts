/**
 * Speech to text (ADR 0073): one recording to the speech endpoint, in whichever of the four formats
 * it speaks, and the text it heard back. Nothing is stored; the audio is in memory only for the
 * length of the call.
 */
import { STATUS_CODES } from "node:http";
import { isLocalEndpoint, type SpeechSettings } from "@real-bot/protocol";
import { HttpError } from "./errors";

/** One recording rarely takes a speech endpoint more than a few seconds; a minute is plainly stuck. */
export const SPEECH_TIMEOUT_MS = 60_000;

export type TranscribeInput = {
  speech: SpeechSettings | null;
  key: string | null;
  audio: Uint8Array<ArrayBuffer>;
  /** The recorder's MIME type; parameters such as `;codecs=opus` are kept off the wire. */
  mime: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Recorded audio only; what browsers' recorders give, by type. */
export function isSpeechMime(mime: string): boolean {
  return /^audio\/[a-z0-9.+-]+$/.test(baseMime(mime));
}

/** OpenAI tells the format from the file's extension, so the name has to carry the right one. */
export function speechFilename(mime: string): string {
  const sub = baseMime(mime).slice("audio/".length);
  const ext: Record<string, string> = {
    webm: "webm", ogg: "ogg", mp4: "mp4", "x-m4a": "m4a", m4a: "m4a", aac: "aac",
    mpeg: "mp3", mp3: "mp3", wav: "wav", "x-wav": "wav", wave: "wav", flac: "flac",
  };
  return `speech.${ext[sub] ?? (sub.replace(/[^a-z0-9]/g, "") || "audio")}`;
}

/** The address as given, or with the format's path added; a full path pasted in is kept as it is. */
export function speechEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.toLowerCase().endsWith(path) ? trimmed : `${trimmed}${path}`;
}

function requestFor(speech: SpeechSettings, key: string | null, audio: Uint8Array<ArrayBuffer>, mime: string): { url: string; init: RequestInit } {
  const base = speech.base_url!;
  const model = speech.model!;
  const type = baseMime(mime);
  const blob = () => new Blob([audio], { type });
  switch (speech.format) {
    case "openai": {
      const form = new FormData();
      form.append("file", blob(), speechFilename(mime));
      form.append("model", model);
      if (speech.language) form.append("language", speech.language);
      return { url: speechEndpoint(base, "/audio/transcriptions"), init: { method: "POST", body: form, headers: key ? { Authorization: `Bearer ${key}` } : {} } };
    }
    case "qwen_asr": {
      const body = {
        model,
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:${type};base64,${Buffer.from(audio).toString("base64")}` } }] }],
        stream: false,
        ...(speech.language ? { asr_options: { language: speech.language } } : {}),
      };
      return {
        url: speechEndpoint(base, "/chat/completions"),
        init: { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } },
      };
    }
    case "deepgram": {
      const url = new URL(speechEndpoint(base, "/listen"));
      url.searchParams.set("model", model);
      url.searchParams.set("smart_format", "true");
      if (speech.language) url.searchParams.set("language", speech.language);
      else url.searchParams.set("detect_language", "true");
      return { url: url.href, init: { method: "POST", body: audio, headers: { "Content-Type": type, ...(key ? { Authorization: `Token ${key}` } : {}) } } };
    }
    case "elevenlabs": {
      const form = new FormData();
      form.append("file", blob(), speechFilename(mime));
      form.append("model_id", model);
      if (speech.language) form.append("language_code", speech.language);
      return { url: speechEndpoint(base, "/speech-to-text"), init: { method: "POST", body: form, headers: key ? { "xi-api-key": key } : {} } };
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The text in what came back, per format; null when the answer has none where the format puts it. */
export function heardText(format: SpeechSettings["format"], body: unknown): string | null {
  const root = record(body);
  if (!root) return typeof body === "string" ? body : null;
  if (format === "qwen_asr") {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const content = record(record(choices[0])?.message)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part === "string" ? part : String(record(part)?.text ?? ""))).join("");
    }
    return null;
  }
  if (format === "deepgram") {
    const channels = record(root.results)?.channels;
    const alternatives = Array.isArray(channels) ? record(channels[0])?.alternatives : null;
    const transcript = Array.isArray(alternatives) ? record(alternatives[0])?.transcript : null;
    return typeof transcript === "string" ? transcript : null;
  }
  return typeof root.text === "string" ? root.text : null;
}

/** What the endpoint said went wrong, short enough for a line under the composer. */
function upstreamMessage(text: string): string {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = record(JSON.parse(text));
  } catch {
    // Not JSON: the start of the body says it as well as anything.
    return text.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  if (!parsed) return text.replace(/\s+/g, " ").trim().slice(0, 300);
  const error = parsed.error;
  const message = typeof error === "string" ? error : record(error)?.message ?? parsed.message ?? record(parsed.detail)?.message ?? parsed.detail ?? parsed.err_msg ?? record(error)?.code ?? parsed.code;
  // A JSON body that says nothing (Bailian's Token Plan answers an ASR call with `{}`): the status says more.
  return typeof message === "string" ? message.trim().slice(0, 300) : "";
}

/**
 * Sends one recording and returns what was heard, trimmed; "" when the endpoint heard nothing.
 * Errors are `HttpError`s whose code says which side failed: `speech_not_set_up`, `speech_key_missing`
 * (ours to fix in Settings), `speech_unreachable`, `speech_timeout`, `speech_rejected` (theirs).
 */
export async function transcribe(input: TranscribeInput): Promise<string> {
  const { speech, audio, mime } = input;
  if (!speech || !speech.enabled || !speech.base_url || !speech.model) {
    throw new HttpError(409, "speech_not_set_up", "speech recognition is not set up");
  }
  const key = input.key?.trim() || null;
  if (!key && !isLocalEndpoint(speech.base_url)) throw new HttpError(409, "speech_key_missing", "the speech endpoint has no key");
  if (audio.length === 0) throw new HttpError(422, "invalid_args", "the recording is empty");
  const { url, init } = requestFor(speech, key, audio, mime);
  const timeout = AbortSignal.timeout(input.timeoutMs ?? SPEECH_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, { ...init, signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (timeout.aborted) throw new HttpError(504, "speech_timeout", "the speech endpoint did not answer in time");
    throw new HttpError(502, "speech_unreachable", `could not reach the speech endpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(502, "speech_rejected", `the speech endpoint answered ${response.status}: ${upstreamMessage(text) || response.statusText || STATUS_CODES[response.status] || "no details"}`);
  }
  let body: unknown = text;
  if ((response.headers.get("content-type") ?? "").includes("json") || /^\s*[{[]/.test(text)) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const heard = heardText(speech.format, body);
  if (heard === null) throw new HttpError(502, "speech_rejected", "the speech endpoint's answer has no text in it");
  return heard.trim();
}
