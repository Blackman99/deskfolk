/**
 * The remote screen page against a scripted server: a fake `ScreenChannel` that speaks RFB 3.8 to the
 * app's native client (the handshake, ServerInit of 64 × 48, then one raw rect and one copyrect), and
 * records what the client sends (keys, pointer events, clipboard) as readable lines. Scenarios are
 * buttons: None auth (the picture), ARD (the sign-in, then a refusal), a Mac with Screen Sharing off,
 * a Mac that never answers, and a Windows PC.
 */
import { signal, Text, View } from "nsh";
import { RemoteScreenView } from "../src/ui/overlays/RemoteScreenView";
import { Button } from "../src/ui/Button";
import { ApiError } from "../src/m/api.ts";
import type { ScreenChannel } from "../src/m/remote/rfb-channel.ts";
import type { ScreenConnection } from "../src/m/remote/screen-connect.ts";
import type { RememberedSignIn } from "../src/m/remote/screen-sign-in.ts";

const log = signal<string[]>([]);
const note = (line: string) => log.update((lines) => [...lines, line]);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
const hex = (n: number): string => n.toString(16);

type Scenario = "none" | "ard" | "silent";

/** A channel with a scripted Mac at the other end. It holds what the Mac says until the client listens. */
export class FakeChannel implements ScreenChannel {
  binaryType = "arraybuffer";
  readonly protocol = "";
  readyState: ScreenChannel["readyState"] = "open";
  bytesIn = 0;
  onopen: ScreenChannel["onopen"] = null;
  onclose: ScreenChannel["onclose"] = null;
  onerror: ScreenChannel["onerror"] = null;
  #onmessage: ScreenChannel["onmessage"] = null;
  #held: Uint8Array[] = [];
  #from: Uint8Array = new Uint8Array(0);
  #phase: "version" | "security" | "ard" | "init" | "live" = "version";
  #updates = 0;

  constructor(private readonly scenario: Scenario) {
    if (scenario !== "silent") this.#say(ascii("RFB 003.008\n"));
  }

  get onmessage(): ScreenChannel["onmessage"] {
    return this.#onmessage;
  }

  set onmessage(handler: ScreenChannel["onmessage"]) {
    this.#onmessage = handler;
    if (handler) setTimeout(() => this.#release(), 0);
  }

  #say(bytes: number[] | Uint8Array): void {
    this.#held.push(new Uint8Array(bytes));
    if (this.#onmessage) setTimeout(() => this.#release(), 0);
  }

  #release(): void {
    while (this.#onmessage && this.#held.length) {
      const bytes = this.#held.shift()!;
      this.bytesIn += bytes.length;
      this.#onmessage({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    }
  }

  /** What the client sends: parsed as the script needs it. */
  send(data: ArrayBuffer | ArrayBufferView): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const joined = new Uint8Array(this.#from.length + bytes.length);
    joined.set(this.#from);
    joined.set(bytes, this.#from.length);
    this.#from = joined;
    while (this.#step()) {
      // One message at a time until the buffer holds less than the next one.
    }
  }

  #take(n: number): Uint8Array | null {
    if (this.#from.length < n) return null;
    const taken = this.#from.slice(0, n);
    this.#from = this.#from.slice(n);
    return taken;
  }

  #step(): boolean {
    switch (this.#phase) {
      case "version": {
        if (!this.#take(12)) return false;
        this.#say(this.scenario === "ard" ? [1, 30] : [1, 1]);
        this.#phase = "security";
        return true;
      }
      case "security": {
        const choice = this.#take(1);
        if (!choice) return false;
        if (choice[0] === 30) {
          // generator 2, a 64-bit prime (2^64 - 59) and the server's public value.
          this.#say([...u16(2), ...u16(8), 255, 255, 255, 255, 255, 255, 255, 197, 0, 0, 0, 0, 0, 0, 0, 5]);
          this.#phase = "ard";
        } else {
          this.#say(u32(0));
          this.#phase = "init";
        }
        return true;
      }
      case "ard": {
        // The encrypted credentials and the client's public value; this Mac refuses them.
        if (!this.#take(128 + 8)) return false;
        const reason = ascii("Authentication failed");
        this.#say([...u32(1), ...u32(reason.length), ...reason]);
        return true;
      }
      case "init": {
        if (!this.#take(1)) return false;
        const name = ascii("Story Mac");
        // 64 × 48; the pixel format the client replaces at once: 32 bpp, depth 24, true colour.
        this.#say([...u16(64), ...u16(48), 32, 24, 0, 1, ...u16(255), ...u16(255), ...u16(255), 16, 8, 0, 0, 0, 0, ...u32(name.length), ...name]);
        this.#phase = "live";
        return true;
      }
      case "live":
        return this.#message();
    }
  }

  #message(): boolean {
    const type = this.#from[0];
    if (type === undefined) return false;
    const view = new DataView(this.#from.buffer, this.#from.byteOffset, this.#from.byteLength);
    if (type === 0) return this.#take(20) !== null;
    if (type === 2) {
      if (this.#from.length < 4) return false;
      return this.#take(4 + 4 * view.getUint16(2)) !== null;
    }
    if (type === 3) {
      if (!this.#take(10)) return false;
      this.#update();
      return true;
    }
    if (type === 4) {
      const m = this.#take(8);
      if (m) note(`key:${hex(new DataView(m.buffer).getUint32(4))}:${m[1] ? "down" : "up"}`);
      return m !== null;
    }
    if (type === 5) {
      const m = this.#take(6);
      if (m) {
        const at = new DataView(m.buffer);
        note(`pointer:${at.getUint16(2)},${at.getUint16(4)}:${m[1]}`);
      }
      return m !== null;
    }
    if (type === 6) {
      if (this.#from.length < 8) return false;
      const length = view.getUint32(4);
      const m = this.#take(8 + length);
      if (m) note(`cut:${String.fromCharCode(...m.slice(8))}`);
      return m !== null;
    }
    // Something the script does not know: drop it rather than wedge.
    this.#from = new Uint8Array(0);
    return false;
  }

  /** The first request gets the picture: a red raw rect, and a copy of it beside. Later ones get nothing. */
  #update(): void {
    if (this.#updates++ > 0) return;
    const pixels: number[] = [];
    for (let i = 0; i < 16 * 16; i++) pixels.push(255, 0, 0, 0);
    this.#say([
      0, 0, ...u16(2),
      ...u16(0), ...u16(0), ...u16(16), ...u16(16), ...u32(0), ...pixels,
      ...u16(32), ...u16(16), ...u16(16), ...u16(16), ...u32(1), ...u16(0), ...u16(0),
    ]);
  }

  close(): void {
    this.readyState = "closed";
  }
}

const remembered: RememberedSignIn = {
  load: async () => ({ username: "me", password: "" }),
  save: async () => {},
  forget: async () => {},
};

export default function RemoteScreenStory() {
  const scenario = signal<"none" | "ard" | "silent" | "off" | "windows" | "remembered" | null>(null);
  const stops = signal(0);
  const api = {
    screenStart: async () => {
      throw new Error("unused");
    },
    screenOffer: async () => ({ sdp: "" }),
    screenTunnel: async () => ({ tunnel_id: 1 }),
    openScreenTunnel: (): ScreenChannel => {
      throw new Error("unused");
    },
    screenStatus: async () => ({ mode: "direct" }),
    screenStop: async () => {
      stops.update((n) => n + 1);
    },
  };
  const connect = async (_api: unknown, _options?: { smooth?: boolean }): Promise<ScreenConnection> => {
    const which = scenario();
    if (which === "off") throw new ApiError(409, "screen_sharing_off", "off");
    const channel = new FakeChannel(which === "ard" || which === "remembered" ? "ard" : which === "silent" ? "silent" : "none");
    return { sessionId: "S1", mode: "direct", channel };
  };
  const pick = (next: "none" | "ard" | "silent" | "off" | "windows" | "remembered") => () => {
    log.set([]);
    scenario.set(next);
  };
  return (
    <View class="flex-1 bg-bg">
      <View class="flex-row flex-wrap gap-2 p-2">
        <Button testID="story-none" onPress={pick("none")}>None</Button>
        <Button testID="story-ard" onPress={pick("ard")}>ARD</Button>
        <Button testID="story-off" onPress={pick("off")}>Off</Button>
        <Button testID="story-silent" onPress={pick("silent")}>Silent</Button>
        <Button testID="story-windows" onPress={pick("windows")}>Windows</Button>
        <Button testID="story-remembered" onPress={pick("remembered")}>Remembered</Button>
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log().join(" ")}`}</Text>
        <Text testID="story-stops" class="text-[12px] text-ink-muted">{`stops:${stops()}`}</Text>
      </View>
      <View class="flex-1 min-h-0">
        <If when={scenario()}>
          {(which: () => "none" | "ard" | "silent" | "off" | "windows" | "remembered") => (
            <RemoteScreenView
              api={api}
              host={which() === "windows" ? "windows" : "mac"}
              connect={connect as never}
              onClose={() => scenario.set(null)}
              answerMs={which() === "silent" ? 400 : 20_000}
              remember={which() === "remembered" ? remembered : undefined}
            />
          )}
        </If>
      </View>
    </View>
  );
}
