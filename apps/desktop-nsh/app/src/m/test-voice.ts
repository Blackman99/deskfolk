/**
 * A microphone and a recorder for happy-dom, which has neither: `getUserMedia` hands back a stream
 * whose tracks note being stopped, and the recorder gives what it was told to as one chunk on stop.
 */
export type FakeMic = {
  /** Tracks stopped so far: the microphone let go. */
  stopped: number;
  /** Recorders made so far, newest last. */
  recorders: FakeMediaRecorder[];
  restore: () => void;
};

export class FakeMediaRecorder {
  static supported = ["audio/webm;codecs=opus"];
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.includes(type);
  }
  static bytes = "voice bytes";
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  options: MediaRecorderOptions;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(_stream: unknown, options: MediaRecorderOptions = {}) {
    this.options = options;
    this.mimeType = options.mimeType ?? "";
    mic?.recorders.push(this);
  }
  start(): void {
    this.state = "recording";
  }
  /** What the recorder hands over each second; a test calls it to grow the recording. */
  emit(data: Blob): void {
    this.ondataavailable?.({ data });
  }
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([FakeMediaRecorder.bytes], { type: this.mimeType }) });
    this.onstop?.(new Event("stop"));
  }
}

let mic: FakeMic | null = null;

export function installFakeMic(opts: { deny?: string } = {}): FakeMic {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const recorderBefore = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const state: FakeMic = {
    stopped: 0,
    recorders: [],
    restore: () => {
      if (navigatorDescriptor) Object.defineProperty(navigator, "mediaDevices", navigatorDescriptor);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder = recorderBefore;
      mic = null;
    },
  };
  mic = state;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (opts.deny) throw new DOMException("denied", opts.deny);
        return { getTracks: () => [{ stop: () => state.stopped++ }] };
      },
    },
  });
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  return state;
}
