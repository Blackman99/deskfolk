import { SPEECH_AUDIO_BASE64_MAX, type PatchSpeechRequest, type TranscribeResponse } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { jsonResponse } from "../../http";
import { isSpeechMime, transcribe } from "../../speech";
import type { RouteCtx } from "../route-ctx";

/** Local API routes for speech recognition (ADR 0073): setting the endpoint up, and one transcription. */
export function speechRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { store, method, path, input, request, options } = ctx;

  if (method === "PATCH" && path === "/v1/speech") {
    store.patchSpeechSync(input.body as PatchSpeechRequest);
    return jsonResponse(store.settingsCached(), 200, null);
  }

  // No receipt (see isNonReceiptPath): it stores nothing, and a repeat only transcribes again.
  if (method === "POST" && path === "/v1/speech/transcribe") {
    const body = input.body as { audio?: unknown; mime?: unknown };
    if (typeof body.mime !== "string" || !isSpeechMime(body.mime)) {
      throw new HttpError(422, "invalid_args", "mime must be an audio type such as audio/webm");
    }
    if (typeof body.audio !== "string" || body.audio.length === 0) throw new HttpError(422, "invalid_args", "audio is required");
    if (body.audio.length > SPEECH_AUDIO_BASE64_MAX) throw new HttpError(413, "speech_too_long", "the recording is too long");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) throw new HttpError(422, "invalid_args", "audio must be base64");
    const audio = new Uint8Array(Buffer.from(body.audio, "base64"));
    const mime = body.mime;
    return (async () => {
      await store.settings();
      const text = await transcribe({
        speech: store.settingsCached().speech ?? null,
        key: await store.speechKey(),
        audio,
        mime,
        fetch: options.speechFetch,
        signal: request.signal,
      });
      ctx.scope?.guard?.();
      return jsonResponse({ text } satisfies TranscribeResponse, 200, null);
    })();
  }

  return null;
}
