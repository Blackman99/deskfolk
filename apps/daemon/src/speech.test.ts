import { describe, expect, test } from "bun:test";
import type { SpeechSettings } from "@real-bot/protocol";
import { HttpError } from "./errors";
import { heardText, isSpeechMime, speechEndpoint, speechFilename, transcribe } from "./speech";

const audio = new Uint8Array([1, 2, 3, 4]);

function speech(over: Partial<SpeechSettings> = {}): SpeechSettings {
  return {
    enabled: true,
    preset: "openai",
    format: "openai",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    language: null,
    key_set: true,
    ...over,
  };
}

type Seen = { url: string; init: RequestInit };

function answering(body: unknown, status = 200, contentType = "application/json"): { seen: Seen[]; fetch: typeof fetch } {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": contentType } });
  }) as typeof fetch;
  return { seen, fetch: impl };
}

async function failure(run: Promise<unknown>): Promise<HttpError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a failure");
}

describe("the wire, per format", () => {
  test("openai: multipart file with the type's extension, model, language, Bearer key", async () => {
    const { seen, fetch } = answering({ text: "  你好  " });
    const text = await transcribe({ speech: speech({ language: "zh" }), key: "sk-1", audio, mime: "audio/webm;codecs=opus", fetch });
    expect(text).toBe("你好");
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-1");
    const form = seen[0]!.init.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("speech.webm");
    expect(file.type).toBe("audio/webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("zh");
  });

  test("openai: no language field when the endpoint is left to tell", async () => {
    const { seen, fetch } = answering({ text: "hi" });
    await transcribe({ speech: speech(), key: "sk-1", audio, mime: "audio/mp4", fetch });
    const form = seen[0]!.init.body as FormData;
    expect(form.has("language")).toBe(false);
    expect((form.get("file") as File).name).toBe("speech.mp4");
  });

  test("qwen_asr: chat completions with the audio as a data URI and the language in asr_options", async () => {
    const { seen, fetch } = answering({ choices: [{ message: { role: "assistant", content: "欢迎使用阿里云。" } }] });
    const text = await transcribe({
      speech: speech({ preset: "bailian", format: "qwen_asr", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-asr-flash", language: "zh" }),
      key: "sk-dash", audio, mime: "audio/webm;codecs=opus", fetch,
    });
    expect(text).toBe("欢迎使用阿里云。");
    expect(seen[0]!.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-dash");
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body.model).toBe("qwen3-asr-flash");
    expect(body.stream).toBe(false);
    expect(body.asr_options).toEqual({ language: "zh" });
    expect(body.messages[0].content[0]).toEqual({ type: "input_audio", input_audio: { data: `data:audio/webm;base64,${Buffer.from(audio).toString("base64")}` } });
  });

  test("qwen_asr: content given as parts is joined", () => {
    expect(heardText("qwen_asr", { choices: [{ message: { content: [{ text: "一" }, { text: "二" }] } }] })).toBe("一二");
  });

  test("deepgram: raw body, model and detection in the query, Token key", async () => {
    const { seen, fetch } = answering({ results: { channels: [{ alternatives: [{ transcript: "hello there", confidence: 0.9 }] }] } });
    const text = await transcribe({
      speech: speech({ preset: "deepgram", format: "deepgram", base_url: "https://api.deepgram.com/v1", model: "nova-3" }),
      key: "dg", audio, mime: "audio/ogg;codecs=opus", fetch,
    });
    expect(text).toBe("hello there");
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("detect_language")).toBe("true");
    expect(url.searchParams.has("language")).toBe(false);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Token dg");
    expect(headers["Content-Type"]).toBe("audio/ogg");
    expect(seen[0]!.init.body).toEqual(audio);
  });

  test("deepgram: a chosen language replaces detection", async () => {
    const { seen, fetch } = answering({ results: { channels: [{ alternatives: [{ transcript: "x" }] }] } });
    await transcribe({ speech: speech({ format: "deepgram", base_url: "https://api.deepgram.com/v1", model: "nova-2", language: "zh" }), key: "dg", audio, mime: "audio/webm", fetch });
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("language")).toBe("zh");
    expect(url.searchParams.has("detect_language")).toBe(false);
  });

  test("elevenlabs: multipart with model_id and language_code, xi-api-key", async () => {
    const { seen, fetch } = answering({ language_code: "en", text: "Hello." });
    const text = await transcribe({
      speech: speech({ preset: "elevenlabs", format: "elevenlabs", base_url: "https://api.elevenlabs.io/v1", model: "scribe_v2", language: "en" }),
      key: "xi", audio, mime: "audio/mp4", fetch,
    });
    expect(text).toBe("Hello.");
    expect(seen[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((seen[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("xi");
    const form = seen[0]!.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
  });

  test("a full path pasted in is kept, a trailing slash is not doubled", () => {
    expect(speechEndpoint("https://x.test/v1/audio/transcriptions", "/audio/transcriptions")).toBe("https://x.test/v1/audio/transcriptions");
    expect(speechEndpoint("https://x.test/v1/", "/audio/transcriptions")).toBe("https://x.test/v1/audio/transcriptions");
  });

  test("a plain-text answer is the text", async () => {
    const { fetch } = answering("just words\n", 200, "text/plain");
    expect(await transcribe({ speech: speech(), key: "k", audio, mime: "audio/wav", fetch })).toBe("just words");
  });
});

describe("what is ours to fix and what is theirs", () => {
  test("off, or missing an address or a model: not set up", async () => {
    const { fetch, seen } = answering({ text: "x" });
    for (const s of [null, speech({ enabled: false }), speech({ base_url: null }), speech({ model: null })]) {
      expect((await failure(transcribe({ speech: s, key: "k", audio, mime: "audio/webm", fetch }))).code).toBe("speech_not_set_up");
    }
    expect(seen).toHaveLength(0);
  });

  test("a cloud endpoint without a key is refused before anything is sent", async () => {
    const { fetch, seen } = answering({ text: "x" });
    const error = await failure(transcribe({ speech: speech(), key: "  ", audio, mime: "audio/webm", fetch }));
    expect(error.code).toBe("speech_key_missing");
    expect(seen).toHaveLength(0);
  });

  test("a server on this computer goes without a key, and without an Authorization header", async () => {
    const { fetch, seen } = answering({ text: "local" });
    const text = await transcribe({ speech: speech({ preset: "custom", base_url: "http://127.0.0.1:8000/v1", model: "whisper" }), key: null, audio, mime: "audio/webm", fetch });
    expect(text).toBe("local");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("a refusal carries the endpoint's own message", async () => {
    const { fetch } = answering({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, 401);
    const error = await failure(transcribe({ speech: speech(), key: "bad", audio, mime: "audio/webm", fetch }));
    expect(error.status).toBe(502);
    expect(error.code).toBe("speech_rejected");
    expect(error.message).toContain("401");
    expect(error.message).toContain("Incorrect API key provided");
  });

  test("a refusal whose body says nothing reads as its status, not as `{}`", async () => {
    const { fetch } = answering("{}", 400);
    const error = await failure(transcribe({ speech: speech({ format: "qwen_asr" }), key: "k", audio, mime: "audio/webm", fetch }));
    expect(error.message).toBe("the speech endpoint answered 400: Bad Request");
    const coded = answering({ code: "InvalidParameter" }, 400);
    expect((await failure(transcribe({ speech: speech(), key: "k", audio, mime: "audio/webm", fetch: coded.fetch }))).message).toContain("400: InvalidParameter");
  });

  test("an answer without text where the format puts it is a refusal", async () => {
    const { fetch } = answering({ choices: [] });
    const error = await failure(transcribe({ speech: speech({ format: "qwen_asr" }), key: "k", audio, mime: "audio/webm", fetch }));
    expect(error.code).toBe("speech_rejected");
  });

  test("an unreachable endpoint and a stuck one are told apart", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await failure(transcribe({ speech: speech(), key: "k", audio, mime: "audio/webm", fetch: down }))).code).toBe("speech_unreachable");
    const stuck = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))))) as unknown as typeof fetch;
    expect((await failure(transcribe({ speech: speech(), key: "k", audio, mime: "audio/webm", fetch: stuck, timeoutMs: 20 }))).code).toBe("speech_timeout");
  });

  test("the caller hanging up is passed on as it is", async () => {
    const caller = new AbortController();
    const hung = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const run = transcribe({ speech: speech(), key: "k", audio, mime: "audio/webm", fetch: hung, signal: caller.signal });
    caller.abort();
    await expect(run).rejects.toThrow("aborted");
  });
});

test("only recorded audio types, named with an extension OpenAI reads", () => {
  expect(isSpeechMime("audio/webm;codecs=opus")).toBe(true);
  expect(isSpeechMime("audio/mp4")).toBe(true);
  expect(isSpeechMime("video/webm")).toBe(false);
  expect(isSpeechMime("text/plain")).toBe(false);
  expect(speechFilename("audio/mpeg")).toBe("speech.mp3");
  expect(speechFilename("audio/x-m4a")).toBe("speech.m4a");
  expect(speechFilename("audio/wav")).toBe("speech.wav");
  expect(speechFilename("audio/weird+thing")).toBe("speech.weirdthing");
});
