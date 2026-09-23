/**
 * Where the shell says it is, read off its own output rather than guessed at from what was typed.
 *
 * zsh reports it on its own, via Real Bot's own shell integration ({@link "./terminal-env"}):
 * OSC 7 after every prompt, `ESC ] 7 ; file://<host><path>`, terminated by BEL or ST. Scanning
 * raw bytes for exactly that — rather than parsing a full terminal emulator's worth of escape
 * sequences — is enough; anything else a program writes just passes through unrecognized.
 */

/** However chatty a shell gets between two reports, an in-progress sequence does not grow forever. */
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_PATH_LENGTH = 4096;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const FILE_PREFIX = [0x66, 0x69, 0x6c, 0x65, 0x3a, 0x2f, 0x2f]; // "file://"

type State = "idle" | "esc" | "bracket" | "seven" | "payload" | "payload-esc";

/**
 * One tracker per session: a sequence can be split across chunks, so the scan position has to
 * survive between calls to {@link feed}.
 */
export class CwdTracker {
  private state: State = "idle";
  private payload: number[] = [];

  /** The last cwd this chunk reported, or `null` if none of it was a valid OSC 7. */
  feed(chunk: Uint8Array): string | null {
    let found: string | null = null;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      switch (this.state) {
        case "idle":
          if (byte === 0x1b) this.state = "esc";
          break;
        case "esc":
          this.state = byte === 0x5d ? "bracket" : byte === 0x1b ? "esc" : "idle";
          break;
        case "bracket":
          this.state = byte === 0x37 ? "seven" : byte === 0x1b ? "esc" : "idle";
          break;
        case "seven":
          if (byte === 0x3b) {
            this.state = "payload";
            this.payload = [];
          } else {
            this.state = byte === 0x1b ? "esc" : "idle";
          }
          break;
        case "payload":
          if (byte === 0x07) {
            // A garbage payload just means no cwd this time; an earlier valid one in the same
            // chunk still counts.
            found = decode(this.payload) ?? found;
            this.state = "idle";
          } else if (byte === 0x1b) {
            this.state = "payload-esc";
          } else {
            this.payload.push(byte);
            if (this.payload.length > MAX_PAYLOAD_BYTES) {
              this.state = "idle";
              this.payload = [];
            }
          }
          break;
        case "payload-esc":
          if (byte === 0x5c) {
            found = decode(this.payload) ?? found;
            this.state = "idle";
          } else {
            // Not `ESC \` after all; the byte that looked like a terminator might start its own
            // sequence instead of ending this one.
            this.state = byte === 0x1b ? "esc" : "idle";
          }
          break;
      }
    }
    return found;
  }
}

/** `file://<any host>/<path>`, percent-decoded as UTF-8 bytes; anything else is not a cwd. */
function decode(payload: number[]): string | null {
  if (payload.length < FILE_PREFIX.length) return null;
  for (let i = 0; i < FILE_PREFIX.length; i++) if (payload[i] !== FILE_PREFIX[i]) return null;
  let i = FILE_PREFIX.length;
  while (i < payload.length && payload[i] !== 0x2f) i++; // skip the host
  if (i >= payload.length) return null; // no path at all

  const pathBytes: number[] = [];
  for (; i < payload.length; i++) {
    const byte = payload[i]!;
    if (byte === 0x25 /* % */) {
      const hi = payload[i + 1];
      const lo = payload[i + 2];
      if (hi === undefined || lo === undefined) return null;
      const hex = String.fromCharCode(hi, lo);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      pathBytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      pathBytes.push(byte);
    }
  }
  if (pathBytes[0] !== 0x2f) return null; // must be absolute

  try {
    const path = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(pathBytes));
    return path.length <= MAX_PATH_LENGTH && !CONTROL_CHARS.test(path) ? path : null;
  } catch {
    return null;
  }
}
