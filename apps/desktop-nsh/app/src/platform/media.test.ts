import { expect, test } from "nsh/test";
import { domErrorOf, formatOf, RECORDING_TYPE, ShellMediaRecorder } from "./media";

test("the recorder speaks the type Safari's does", () => {
  expect(ShellMediaRecorder.isTypeSupported("audio/mp4")).toBe(true);
  expect(ShellMediaRecorder.isTypeSupported("audio/webm;codecs=opus")).toBe(false);
  expect(RECORDING_TYPE).toBe("audio/mp4");
});

test("the shell's refusals read as getUserMedia's DOMExceptions", () => {
  const denied = domErrorOf(new Error("NotAllowedError: the microphone is not allowed"));
  expect(denied.name).toBe("NotAllowedError");
  expect(denied.message).toBe("the microphone is not allowed");
  expect(domErrorOf("boom").name).toBe("UnknownError");
});

test("a shell that records WAV says so, and how long it may run", () => {
  expect(formatOf(null)).toEqual({ mime: "audio/mp4", maxSeconds: undefined });
  expect(formatOf({ mime: "audio/wav", maxSeconds: 31 })).toEqual({ mime: "audio/wav", maxSeconds: 31 });
  expect(formatOf({ mime: "", maxSeconds: -1 })).toEqual({ mime: "audio/mp4", maxSeconds: undefined });
});
