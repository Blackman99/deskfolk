import { describe, expect, test } from "bun:test";
import type { RuntimeSnapshot, Settings } from "@real-bot/protocol";
import { SPEECH_AUDIO_BASE64_MAX, SPEECH_KEYCHAIN_NAME } from "@real-bot/protocol";
import { ulid } from "./ids";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { auth, jsonAuth, registerLocalApiCleanup, startLocalApi, type Harness } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const audio = Buffer.from("fake opus bytes").toString("base64");

function patchSpeech(h: Harness, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${h.origin}/v1/speech`, { method: "PATCH", headers: { ...jsonAuth(h), "X-Request-Id": ulid() }, body: JSON.stringify(body) });
}

function transcribeVia(h: Harness, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${h.origin}/v1/speech/transcribe`, { method: "POST", headers: jsonAuth(h), body: JSON.stringify(body) });
}

describe("setting the speech endpoint up", () => {
  test("a fresh install has none; picking a service fills in its address and model, and the key is never sent back", async () => {
    const h = await startLocalApi();
    const before = (await (await fetch(`${h.origin}/v1/settings`, { headers: auth(h) })).json()) as Settings;
    expect(before.speech).toBeNull();

    const res = await patchSpeech(h, { preset: "groq", api_key: "gsk-secret" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("gsk-secret");
    const settings = JSON.parse(text) as Settings;
    expect(settings.speech).toEqual({
      enabled: true,
      preset: "groq",
      format: "openai",
      base_url: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      language: null,
      key_set: true,
    });
    expect(await h.store.speechKey()).toBe("gsk-secret");

    const snapshot = (await (await fetch(`${h.origin}/v1/snapshot`, { headers: auth(h) })).json()) as RuntimeSnapshot;
    expect(snapshot.settings.speech?.key_set).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("gsk-secret");
  });

  test("after the first pick a field changes only when named; an empty key removes it", async () => {
    const h = await startLocalApi();
    await patchSpeech(h, { preset: "openai", api_key: "sk-a" });
    const switched = (await (await patchSpeech(h, { preset: "custom", base_url: "http://127.0.0.1:8000/v1/", model: " Systran/faster-whisper-small ", language: "zh" })).json()) as Settings;
    expect(switched.speech).toMatchObject({ preset: "custom", format: "openai", base_url: "http://127.0.0.1:8000/v1", model: "Systran/faster-whisper-small", language: "zh", key_set: true });
    const off = (await (await patchSpeech(h, { enabled: false, language: null, api_key: "" })).json()) as Settings;
    expect(off.speech).toMatchObject({ enabled: false, language: null, key_set: false, model: "Systran/faster-whisper-small" });
    expect(await h.store.speechKey()).toBeNull();
  });

  test("unknown fields, formats and addresses are refused", async () => {
    const h = await startLocalApi();
    for (const body of [{}, { nope: 1 }, { preset: "azure" }, { format: "grpc" }, { base_url: "ftp://x" }, { language: "Chinese" }, { enabled: "yes" }]) {
      const res = await patchSpeech(h, body);
      expect(res.status).toBe(422);
    }
    expect(h.store.settingsCached().speech).toBeNull();
  });

  test("a key already in the keychain reads as set after a restart", async () => {
    const keys = memoryKeyStore(null);
    const store = new Store({ endpointKey: keys });
    store.db.run("INSERT INTO settings (key, value) VALUES ('speech_preset', 'openai'), ('speech_enabled', '1'), ('speech_base_url', 'https://api.openai.com/v1'), ('speech_model', 'whisper-1')");
    await keys.set("sk-kept", SPEECH_KEYCHAIN_NAME);
    const h = await startLocalApi({ store });
    const settings = (await (await fetch(`${h.origin}/v1/settings`, { headers: auth(h) })).json()) as Settings;
    expect(settings.speech?.key_set).toBe(true);
  });
});

test("a speech key whose keychain write did not finish is listed for repair as kind speech", async () => {
  const keys = memoryKeyStore(null);
  keys.set = async () => {
    throw new Error("keychain locked");
  };
  const h = await startLocalApi({ store: new Store({ endpointKey: keys }) });
  const res = await patchSpeech(h, { preset: "openai", api_key: "sk-stuck" });
  expect(res.status).toBe(503);
  const ops = h.store.listCredentialOperations();
  expect(ops).toEqual([{ id: expect.any(String), kind: "speech", entity_id: "speech", request_id: expect.any(String), can_repair: true }]);
  expect(h.store.settingsCached().speech?.key_set).toBe(false);
});

describe("POST /v1/speech/transcribe", () => {
  test("sends the recording to the endpoint with its key and answers with the text", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: FormData }> = [];
    const h = await startLocalApi({
      speechFetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: init?.body as FormData });
        return Response.json({ text: "你好，世界" });
      }) as typeof fetch,
    });
    await patchSpeech(h, { preset: "openai", api_key: "sk-live", language: "zh" });
    const res = await transcribeVia(h, { audio, mime: "audio/webm;codecs=opus" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "你好，世界" });
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seen[0]!.headers.Authorization).toBe("Bearer sk-live");
    expect(Buffer.from(await (seen[0]!.body.get("file") as File).arrayBuffer()).toString()).toBe("fake opus bytes");
    // Nothing is kept: no receipt, no message, no attachment.
    expect(h.store.db.query("SELECT count(*) AS n FROM request_receipts WHERE path = '/v1/speech/transcribe'").get()).toEqual({ n: 0 });
    expect(h.store.db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  test("says what to fix when speech is not set up, and refuses what is not a recording", async () => {
    const h = await startLocalApi({ speechFetch: (async () => Response.json({ text: "x" })) as unknown as typeof fetch });
    const unset = await transcribeVia(h, { audio, mime: "audio/webm" });
    expect(unset.status).toBe(409);
    expect(((await unset.json()) as { error: { code: string } }).error.code).toBe("speech_not_set_up");
    await patchSpeech(h, { preset: "openai" });
    const keyless = await transcribeVia(h, { audio, mime: "audio/webm" });
    expect(((await keyless.json()) as { error: { code: string } }).error.code).toBe("speech_key_missing");
    for (const body of [{ audio, mime: "text/plain" }, { audio: "", mime: "audio/webm" }, { audio: "not base64!", mime: "audio/webm" }]) {
      expect((await transcribeVia(h, body)).status).toBe(422);
    }
    const long = await transcribeVia(h, { audio: "A".repeat(SPEECH_AUDIO_BASE64_MAX + 4), mime: "audio/webm" });
    expect(long.status).toBe(413);
  });

  test("the endpoint's refusal comes back as a 502 naming it", async () => {
    const h = await startLocalApi({
      speechFetch: (async () => Response.json({ error: { message: "Invalid file format." } }, { status: 400 })) as unknown as typeof fetch,
    });
    await patchSpeech(h, { preset: "openai", api_key: "sk" });
    const res = await transcribeVia(h, { audio, mime: "audio/webm" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("speech_rejected");
    expect(body.error.message).toContain("Invalid file format.");
  });
});

describe("over the remote link", () => {
  const id = "01J00000000000000000000000";

  test("setting up and transcribing are on the list, with every field declared", () => {
    expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: "/v1/speech", body: { preset: "bailian", base_url: "https://x", model: "qwen3-asr-flash", language: null, api_key: "k", enabled: true, format: "qwen_asr", if_revision: 3 } })).not.toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/speech/transcribe", body: { audio, mime: "audio/webm" } })).not.toThrow();
  });

  test("anything else is refused", () => {
    expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: "/v1/speech", body: { if_revision: 3 } })).toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: "/v1/speech", body: { preset: "nope" } })).toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/speech/transcribe", body: { audio } })).toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/speech/transcribe", body: { audio: "A".repeat(SPEECH_AUDIO_BASE64_MAX + 1), mime: "audio/webm" } })).toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/speech/transcribe", body: { audio, mime: "audio/webm", files: [] } })).toThrow();
  });
});
