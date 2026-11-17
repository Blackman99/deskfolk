/**
 * `navigator.mediaDevices.getUserMedia` and `MediaRecorder` on a desktop, over the shell's
 * recording (`host/src/recorder.rs`), so the messenger's voice input (`chat/voice-recorder.ts`)
 * runs unchanged: `getUserMedia` asks for the microphone and starts recording, the recorder hands
 * the whole recording over as one `dataavailable` when it stops: `audio/mp4` like Safari's on the
 * Mac, `audio/wav` on Windows and Linux (`recorder_portable.rs`), whose `shell.record.start` says
 * so and says how long the recording may run (`maxSeconds`, which the messenger's recorder reads
 * off the recorder, because an uncompressed recording outgrows what the daemon transcribes).
 *
 * Only what the messenger uses: one audio track, `start`/`stop`, `ondataavailable`, `onstop`,
 * `onerror`, `state`, `mimeType`, `isTypeSupported`. The web keeps the browser's own.
 */
import { host } from "nsh";

export const RECORDING_TYPE = "audio/mp4";

type Answer = { data: string; mime: string; seconds: number };
/** What `shell.record.start` answers where the recording is not the Mac's AAC; null there. */
type Format = { mime?: string; maxSeconds?: number };

/** The format of the recording `getUserMedia` last started: the Mac's until the shell says otherwise. */
let format: { mime: string; maxSeconds: number | undefined } = { mime: RECORDING_TYPE, maxSeconds: undefined };

/** Reads what `shell.record.start` answered into the format of the recording that began. */
export function formatOf(answer: unknown): { mime: string; maxSeconds: number | undefined } {
  const given = answer && typeof answer === "object" ? (answer as Format) : {};
  const mime = typeof given.mime === "string" && given.mime ? given.mime : RECORDING_TYPE;
  const seconds = given.maxSeconds;
  return { mime, maxSeconds: typeof seconds === "number" && seconds > 0 ? seconds : undefined };
}

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
    return type.split(";")[0]!.trim() === format.mime;
  }

  readonly mimeType = format.mime;
  /** How long the shell lets this recording run; the messenger stops it there. Unset where it is unlimited. */
  readonly maxSeconds = format.maxSeconds;
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
        this.ondataavailable?.({ data: new Blob([base64Bytes(answer.data)], { type: answer.mime || this.mimeType }) });
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
        format = formatOf(await host.call("shell.record.start", null, { timeout: 0 }));
      } catch (error) {
        throw domErrorOf(error);
      }
      return new ShellStream();
    },
  };
  g.MediaRecorder = ShellMediaRecorder;
}
