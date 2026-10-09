import { expect, test } from "bun:test";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { deferred, settleTimers } from "../test-async.ts";
import { ComposerVoice, spacedHeard, transcribeFailureText } from "./composer-voice.svelte.ts";
import { RecorderFailure, type RecorderHooks, type Recording, VoiceRecorder } from "./voice-recorder.ts";

const t = copyFor("zh");

class StubRecorder extends VoiceRecorder {
  hooks: RecorderHooks = {};
  cancelled = 0;
  constructor(
    private readonly recording: Recording = { blob: new Blob(["abc"], { type: "audio/webm" }), mime: "audio/webm;codecs=opus", seconds: 2 },
    private readonly failure: unknown = null,
  ) {
    super();
  }
  override async start(hooks: RecorderHooks = {}): Promise<void> {
    if (this.failure) throw this.failure;
    this.hooks = hooks;
  }
  override async stop(): Promise<Recording> {
    return this.recording;
  }
  override cancel(): void {
    this.cancelled++;
  }
}

function setup(opts: { transcribe?: MessengerApi["transcribe"]; recorder?: StubRecorder; session?: () => string | null } = {}) {
  const inserted: Array<{ sessionId: string; text: string }> = [];
  const sent: unknown[] = [];
  const recorder = opts.recorder ?? new StubRecorder();
  let marks = 0;
  const api = {
    transcribe: opts.transcribe ?? (async (body: unknown) => {
      sent.push(body);
      return { text: "  你好世界 " };
    }),
  } as unknown as MessengerApi;
  const voice = new ComposerVoice({
    api: () => api,
    t: () => t,
    sessionId: opts.session ?? (() => "s1"),
    markCaret: () => marks++,
    insert: (sessionId, text) => inserted.push({ sessionId, text }),
    makeRecorder: () => recorder,
  });
  return { voice, inserted, sent, recorder, marks: () => marks };
}

test("press to record, press again: the recording goes as base64 and the text lands where it was recorded", async () => {
  const { voice, inserted, sent, marks } = setup();
  await voice.toggle();
  expect(voice.phase).toBe("recording");
  expect(marks()).toBe(1);
  await voice.toggle();
  expect(voice.phase).toBe("idle");
  expect(sent).toEqual([{ audio: Buffer.from("abc").toString("base64"), mime: "audio/webm;codecs=opus" }]);
  expect(inserted).toEqual([{ sessionId: "s1", text: "你好世界" }]);
  expect(voice.notice).toBeNull();
});

test("the recording's own conversation gets the text, even after switching away", async () => {
  let current = "s1";
  const { voice, inserted } = setup({ session: () => current });
  await voice.start();
  current = "s2";
  await voice.stop();
  expect(inserted[0]!.sessionId).toBe("s1");
});

test("reaching the limit stops and transcribes by itself", async () => {
  const recorder = new StubRecorder();
  const { voice, inserted } = setup({ recorder });
  await voice.start();
  recorder.hooks.onTick?.(12.5);
  expect(voice.seconds).toBe(12.5);
  recorder.hooks.onLimit?.();
  await settleTimers();
  await settleTimers();
  expect(voice.phase).toBe("idle");
  expect(inserted).toHaveLength(1);
});

test("nothing heard, and an empty recording, say so instead of inserting", async () => {
  const quiet = setup({ transcribe: (async () => ({ text: "   " })) as MessengerApi["transcribe"] });
  await quiet.voice.start();
  await quiet.voice.stop();
  expect(quiet.inserted).toEqual([]);
  expect(quiet.voice.notice).toBe(t.speech.heardNothing);
  const empty = setup({ recorder: new StubRecorder({ blob: new Blob([]), mime: "audio/webm", seconds: 0 }) });
  await empty.voice.start();
  await empty.voice.stop();
  expect(empty.voice.notice).toBe(t.speech.heardNothing);
  empty.voice.dismiss();
  expect(empty.voice.notice).toBeNull();
});

test("a refused microphone says where to allow it, and nothing is recording", async () => {
  const { voice } = setup({ recorder: new StubRecorder(undefined, new RecorderFailure("denied", "no")) });
  await voice.toggle();
  expect(voice.phase).toBe("idle");
  expect(voice.notice).toBe(t.speech.micDenied);
});

test("cancelling while the text is on its way drops it and stops waiting", async () => {
  const pending = deferred<{ text: string }>();
  let signal: AbortSignal | undefined;
  const { voice, inserted } = setup({
    transcribe: ((_body: unknown, s?: AbortSignal) => {
      signal = s;
      return pending.promise;
    }) as MessengerApi["transcribe"],
  });
  await voice.start();
  const stopping = voice.stop();
  await settleTimers();
  expect(voice.phase).toBe("transcribing");
  voice.cancel();
  expect(signal?.aborted).toBe(true);
  expect(voice.phase).toBe("idle");
  pending.resolve({ text: "迟到的字" });
  await stopping;
  expect(inserted).toEqual([]);
  expect(voice.phase).toBe("idle");
});

test("cancelling a recording lets the microphone go", async () => {
  const recorder = new StubRecorder();
  const { voice } = setup({ recorder });
  await voice.start();
  voice.cancel();
  expect(recorder.cancelled).toBe(1);
  expect(voice.phase).toBe("idle");
});

test("the daemon's error codes read as what to do", () => {
  expect(transcribeFailureText(new ApiError(409, "speech_not_set_up", "x"), t)).toBe(t.speech.notSetUp);
  expect(transcribeFailureText(new ApiError(409, "speech_key_missing", "x"), t)).toBe(t.speech.keyMissing);
  expect(transcribeFailureText(new ApiError(502, "speech_rejected", "the speech endpoint answered 401: bad key"), t)).toBe(t.speech.rejected("401: bad key"));
  expect(transcribeFailureText(new ApiError(502, "speech_unreachable", "x"), t)).toBe(t.speech.unreachable);
  expect(transcribeFailureText(new ApiError(504, "speech_timeout", "x"), t)).toBe(t.speech.timeout);
  expect(transcribeFailureText(new ApiError(413, "speech_too_long", "x"), t)).toBe(t.speech.tooLong);
  expect(transcribeFailureText(new ApiError(500, "failed", "boom"), t)).toBe(t.speech.transcribeFailed("boom"));
});

test("a space only between Latin words", () => {
  expect(spacedHeard("", "hello")).toBe("hello");
  expect(spacedHeard("say", "hello")).toBe(" hello");
  expect(spacedHeard("done.", "Next")).toBe(" Next");
  expect(spacedHeard("say ", "hello")).toBe("hello");
  expect(spacedHeard("你好", "世界")).toBe("世界");
  expect(spacedHeard("你好", "world")).toBe("world");
  expect(spacedHeard("hello", "世界")).toBe("世界");
});
