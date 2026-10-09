import { afterEach, expect, test } from "bun:test";
import { SPEECH_AUDIO_BASE64_MAX } from "@real-bot/protocol";
import { settleTimers } from "../test-async.ts";
import { FakeMediaRecorder, installFakeMic, type FakeMic } from "../test-voice.ts";
import {
  RecorderFailure,
  SPEECH_RAW_BYTES_MAX,
  VoiceRecorder,
  blobToBase64,
  formatClock,
  pickRecorderType,
  recordingMime,
} from "./voice-recorder.ts";

let mic: FakeMic | null = null;
afterEach(() => {
  mic?.restore();
  mic = null;
});

test("the first compressed type the browser records, else its own choice", () => {
  expect(pickRecorderType((type) => type === "audio/mp4")).toBe("audio/mp4");
  expect(pickRecorderType((type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
  expect(pickRecorderType(() => false)).toBe("");
  expect(pickRecorderType(() => {
    throw new Error("old browser");
  })).toBe("");
});

test("the type the daemon is told is audio", () => {
  expect(recordingMime("video/webm;codecs=opus")).toBe("audio/webm;codecs=opus");
  expect(recordingMime("audio/mp4")).toBe("audio/mp4");
  expect(recordingMime("")).toBe("audio/webm");
});

test("clock and base64", async () => {
  expect(formatClock(0)).toBe("0:00");
  expect(formatClock(7.9)).toBe("0:07");
  expect(formatClock(125)).toBe("2:05");
  expect(await blobToBase64(new Blob(["你好"]))).toBe(Buffer.from("你好").toString("base64"));
  const big = new Uint8Array(100_000).map((_, i) => i % 251);
  expect(await blobToBase64(new Blob([big]))).toBe(Buffer.from(big).toString("base64"));
});

test("the size bound leaves room under the transcription's base64 limit", () => {
  expect(Math.ceil(SPEECH_RAW_BYTES_MAX / 3) * 4).toBeLessThan(SPEECH_AUDIO_BASE64_MAX);
});

test("records opus at a low bit rate, hands back the recording, and lets go of the microphone", async () => {
  mic = installFakeMic();
  const recorder = new VoiceRecorder();
  await recorder.start();
  const made = mic.recorders[0]!;
  expect(made.options).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 });
  expect(made.state).toBe("recording");
  const recording = await recorder.stop();
  expect(recording.mime).toBe("audio/webm;codecs=opus");
  expect(await recording.blob.text()).toBe(FakeMediaRecorder.bytes);
  expect(mic.stopped).toBe(1);
});

test("a recording near the size bound asks to be stopped, once", async () => {
  mic = installFakeMic();
  let limits = 0;
  const recorder = new VoiceRecorder();
  await recorder.start({ onLimit: () => limits++ });
  const made = mic.recorders[0]!;
  made.emit(new Blob([new Uint8Array(Math.ceil(SPEECH_RAW_BYTES_MAX * 0.5))]));
  expect(limits).toBe(0);
  made.emit(new Blob([new Uint8Array(Math.ceil(SPEECH_RAW_BYTES_MAX * 0.45))]));
  made.emit(new Blob([new Uint8Array(10)]));
  expect(limits).toBe(1);
  recorder.cancel();
  expect(mic.stopped).toBe(1);
});

test("a refused microphone, a missing one and a page without one are told apart", async () => {
  mic = installFakeMic({ deny: "NotAllowedError" });
  await expect(new VoiceRecorder().start()).rejects.toMatchObject({ kind: "denied" });
  mic.restore();
  mic = installFakeMic({ deny: "NotFoundError" });
  await expect(new VoiceRecorder().start()).rejects.toMatchObject({ kind: "missing" });
  mic.restore();
  mic = null;
  const before = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  try {
    const error = await new VoiceRecorder().start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecorderFailure);
    expect((error as RecorderFailure).kind).toBe("unsupported");
  } finally {
    if (before) Object.defineProperty(navigator, "mediaDevices", before);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  }
  await settleTimers();
});
