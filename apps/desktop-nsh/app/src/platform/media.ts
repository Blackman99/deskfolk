/**
 * `navigator.mediaDevices.getUserMedia` and `MediaRecorder` on a desktop, over the shell's
 * recording (`host/src/recorder.rs`), so the messenger's voice input (`chat/voice-recorder.ts`)
 * runs unchanged: `getUserMedia` asks for the microphone and starts recording, the recorder hands
 * the whole recording over as one `dataavailable` when it stops, `audio/mp4` like Safari's.
 *
 * Only what the messenger uses: one audio track, `start`/`stop`, `ondataavailable`, `onstop`,
 * `onerror`, `state`, `mimeType`, `isTypeSupported`. The web keeps the browser's own.
 */
import { host } from "nsh";

export const RECORDING_TYPE = "audio/mp4";

type Answer = { data: string; mime: string; seconds: number };

/** `NotAllowedError: …` from the shell, as the DOMException `getUserMedia` would throw. */
export function domErrorOf(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^([A-Za-z]+Error): (.*)$/s.exec(text);
  const name = match?.[1] ?? "UnknownError";
  const message = match?.[2] ?? text;
  return typeof DOMException === "function" ? new DOMException(message, name) : Object.assign(new Error(message), { name });
}

function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const raw = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

class ShellTrack {
  readonly kind = "audio";
  readyState: "live" | "ended" = "live";
  stop(): void {
    if (this.readyState === "ended") return;
    this.readyState = "ended";
    // After `stop` took the recording this does nothing; before, it throws the recording away.
    void host.call("shell.record.cancel").catch(() => undefined);
  }
}

class ShellStream {
  readonly track = new ShellTrack();
  getTracks(): ShellTrack[] {
    return [this.track];
  }
  getAudioTracks(): ShellTrack[] {
    return [this.track];
  }
}

type DataEvent = { data: Blob };

export class ShellMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return type.split(";")[0]!.trim() === RECORDING_TYPE;
  }

  readonly mimeType = RECORDING_TYPE;
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: DataEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event & { error?: unknown }) => void) | null = null;
  readonly stream: ShellStream;

  constructor(stream: ShellStream) {
    this.stream = stream;
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    host
      .call<Answer>("shell.record.stop")
      .then((answer) => {
        this.ondataavailable?.({ data: new Blob([base64Bytes(answer.data)], { type: answer.mime || RECORDING_TYPE }) });
        this.onstop?.(new Event("stop"));
      })
      .catch((error) => {
        const event = Object.assign(new Event("error"), { error: domErrorOf(error) });
        this.onerror?.(event);
      });
  }
}

/** Installs both on a desktop shell that records; leaves a browser's own alone. */
export function installMedia(): void {
  const g = globalThis as Record<string, unknown>;
  if (!host.available() || typeof g.MediaRecorder === "function") return;
  const nav = g.navigator as Record<string, unknown> | undefined;
  if (!nav) return;
  nav.mediaDevices = {
    async getUserMedia(constraints?: { audio?: unknown }): Promise<ShellStream> {
      if (!constraints?.audio) throw domErrorOf(new Error("NotSupportedError: only audio can be recorded here"));
      try {
        await host.call("shell.record.start", null, { timeout: 0 });
      } catch (error) {
        throw domErrorOf(error);
      }
      return new ShellStream();
    },
  };
  g.MediaRecorder = ShellMediaRecorder;
}
