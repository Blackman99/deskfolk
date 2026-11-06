/**
 * One RFB session over a `ScreenChannel`: the transport half of the native client. The Rust side
 * (`Screens` in `deskfolk/native`, `app/native/src/rfb`) holds the protocol, the decoders and the
 * framebuffer; this owns the wire. Bytes that arrive go to `Screens.feed`, and after every call
 * that can queue a reply whatever `Screens.takeOutgoing` holds is sent on. The changed picture
 * comes out as tiles (`Screens.dirtyTiles`), at most once a frame however fast updates arrive.
 */
import { signal, untracked, type Signal } from "nsh";
import { Screens } from "deskfolk/native";
import type { ScreenChannel } from "../../m/remote/rfb-channel.ts";

/** What the Rust client reports (`feed` and `credentials` return them as a JSON array). */
export type ScreenEvent =
  | { type: "credentials"; needs: string[] }
  | { type: "connected"; width: number; height: number; name: string }
  | { type: "resized"; width: number; height: number }
  | { type: "bell" }
  | { type: "clipboard"; text: string }
  | { type: "failed"; reason: string; securityFailure?: boolean }
  | { type: "closed" }
  | { type: "update" };

/** A 256-pixel square of the picture, shown as an `Image`: its place in the Mac's pixels and its BMP. */
export type Tile = { key: string; x: number; y: number; w: number; h: number; uri: Signal<string> };

type RawTile = { x: number; y: number; w: number; h: number; uri: string };

let counter = 0;

export class ScreenSession {
  readonly id = `screen-${++counter}`;
  /** The tiles the picture is made of, a new list only when the picture's size changed. */
  readonly tiles = signal<Tile[]>([]);
  #byKey = new Map<string, Tile>();
  #drawDue = false;
  #closed = false;

  constructor(
    private readonly channel: ScreenChannel,
    private readonly onEvent: (event: ScreenEvent) => void,
  ) {
    Screens.open(this.id);
    Screens.seed(this.id, crypto.getRandomValues(new Uint8Array(32)));
    channel.binaryType = "arraybuffer";
    channel.onmessage = (message) => this.#feed(new Uint8Array(message.data));
    channel.onclose = () => this.#end();
    channel.onerror = () => this.#end();
    // The Mac may have spoken already: nothing is lost, the channel holds it until a handler is attached.
    this.#flush();
  }

  /** The Mac's framebuffer size; 0 × 0 until connected. */
  size(): { w: number; h: number } {
    const [w, h] = Screens.size(this.id);
    return { w: w ?? 0, h: h ?? 0 };
  }

  credentials(username: string, password: string): void {
    if (this.#closed) return;
    this.#dispatch(Screens.credentials(this.id, username, password));
    this.#flush();
  }

  pointer(x: number, y: number, buttons: number): void {
    if (this.#closed) return;
    Screens.pointer(this.id, x, y, buttons);
    this.#flush();
  }

  key(keysym: number, down: boolean): void {
    if (this.#closed) return;
    Screens.key(this.id, keysym, down);
    this.#flush();
  }

  /** The clipboard text for the Mac. */
  cutText(text: string): void {
    if (this.#closed) return;
    Screens.cutText(this.id, text);
    this.#flush();
  }

  /** Ctrl, Alt and Delete as one press: what a Windows VNC server running as a service turns into the secure attention sequence. */
  ctrlAltDel(): void {
    for (const keysym of [0xffe3, 0xffe9, 0xffff]) this.key(keysym, true);
    for (const keysym of [0xffff, 0xffe9, 0xffe3]) this.key(keysym, false);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    channelQuiet(this.channel);
    Screens.close(this.id);
    this.#byKey.clear();
    this.tiles.set([]);
  }

  #feed(bytes: Uint8Array): void {
    if (this.#closed || bytes.length === 0) return;
    this.#dispatch(Screens.feed(this.id, bytes));
    this.#flush();
  }

  /** The channel ended: an empty feed tells the client, which answers `closed`, or `failed` before it was connected. */
  #end(): void {
    if (this.#closed) return;
    this.#dispatch(Screens.feed(this.id, new Uint8Array(0)));
    this.#flush();
  }

  #flush(): void {
    const out = Screens.takeOutgoing(this.id);
    if (out.length === 0) return;
    try {
      this.channel.send(out);
    } catch {
      // A channel that cannot send is closing; its close arrives on its own.
    }
  }

  #dispatch(json: string): void {
    let events: ScreenEvent[];
    try {
      events = JSON.parse(json) as ScreenEvent[];
    } catch {
      return;
    }
    for (const event of events) {
      if (this.#closed) return;
      if (event.type === "update") this.#scheduleDraw();
      else if (event.type === "resized" || event.type === "connected") {
        // A new size starts a new tile grid; its tiles all arrive as dirty.
        this.#byKey.clear();
        this.tiles.set([]);
        this.#scheduleDraw();
        this.onEvent(event);
      } else this.onEvent(event);
    }
  }

  #scheduleDraw(): void {
    if (this.#drawDue) return;
    this.#drawDue = true;
    setTimeout(() => {
      this.#drawDue = false;
      if (!this.#closed) this.draw();
    }, 16);
  }

  /** Takes the changed tiles from Rust: a known tile gets its new picture, a new one joins the list. */
  draw(): void {
    let raw: RawTile[];
    try {
      raw = JSON.parse(Screens.dirtyTiles(this.id)) as RawTile[];
    } catch {
      return;
    }
    const added: Tile[] = [];
    for (const tile of raw) {
      const key = `${tile.x},${tile.y}`;
      const known = this.#byKey.get(key);
      if (known) {
        known.uri.set(tile.uri);
        continue;
      }
      const fresh: Tile = { key, x: tile.x, y: tile.y, w: tile.w, h: tile.h, uri: signal(tile.uri) };
      this.#byKey.set(key, fresh);
      added.push(fresh);
    }
    if (added.length) this.tiles.set([...untracked(() => this.tiles()), ...added]);
  }
}

function channelQuiet(channel: ScreenChannel): void {
  channel.onmessage = null;
  channel.onclose = null;
  channel.onerror = null;
  try {
    channel.close();
  } catch {
    // Already closed.
  }
}
