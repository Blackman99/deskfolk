import { realClock, type Clock, type Point } from "./screen-trackpad.ts";

/**
 * Pointer events for Screen Sharing, written as RFB messages straight into the screen's channel.
 * noVNC only ever puts the pointer where a finger or mouse is on its canvas, and has no call to
 * put it anywhere else; trackpad mode moves it by how far a finger travels, so it speaks RFB
 * itself. A PointerEvent is six bytes, and after ARD's sign-in (which encrypts only the
 * credentials) the stream is plain RFB both ways, so these sit between noVNC's own messages
 * as they are. Positions are the Mac's framebuffer pixels.
 */
export const BUTTON = {
  left: 0x01,
  middle: 0x02,
  right: 0x04,
  wheelUp: 0x08,
  wheelDown: 0x10,
  wheelLeft: 0x20,
  wheelRight: 0x40,
} as const;

/** RFB's PointerEvent: message type 5, the buttons held, then x and y as big-endian u16. */
export function pointerEvent(x: number, y: number, mask: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  const u16 = (n: number) => Math.min(0xffff, Math.max(0, Math.round(n)));
  view.setUint8(0, 5);
  // The top bit marks an extended pointer event on servers that take one; never set it here.
  view.setUint8(1, mask & 0x7f);
  view.setUint16(2, u16(x));
  view.setUint16(4, u16(y));
  return bytes;
}

/**
 * The pointer as the Mac should see it. Moves go out at most once per `gapMs`, the latest
 * position winning, the way noVNC paces a mouse; a click, a button or a wheel step goes at once
 * and carries its own position, so a move still waiting is dropped rather than sent after it.
 */
export class PointerOut {
  #at: Point = { x: 0, y: 0 };
  #mask = 0;
  #sentAt = -Infinity;
  #cancelDue: (() => void) | null = null;

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    private readonly clock: Clock = realClock,
    private readonly gapMs = 25,
  ) {}

  moveTo(point: Point): void {
    this.#at = point;
    if (this.#cancelDue) return;
    const wait = this.gapMs - (this.clock.now() - this.#sentAt);
    if (wait <= 0) {
      this.#write(this.#mask);
      return;
    }
    this.#cancelDue = this.clock.after(wait, () => {
      this.#cancelDue = null;
      this.#write(this.#mask);
    });
  }

  click(point: Point, button: number): void {
    this.#settle(point);
    this.#write(this.#mask | button);
    this.#write(this.#mask);
  }

  press(point: Point, button: number): void {
    this.#settle(point);
    this.#mask |= button;
    this.#write(this.#mask);
  }

  release(point: Point, button: number): void {
    this.#settle(point);
    this.#mask &= ~button;
    this.#write(this.#mask);
  }

  /** One wheel step: RFB's wheel is a button pressed and let go. */
  wheel(point: Point, button: number): void {
    this.click(point, button);
  }

  /** A fresh connection: nothing held, nothing waiting. */
  reset(): void {
    this.#cancelDue?.();
    this.#cancelDue = null;
    this.#mask = 0;
    this.#sentAt = -Infinity;
  }

  #settle(point: Point): void {
    this.#cancelDue?.();
    this.#cancelDue = null;
    this.#at = point;
  }

  #write(mask: number): void {
    this.#sentAt = this.clock.now();
    this.send(pointerEvent(this.#at.x, this.#at.y, mask));
  }
}
