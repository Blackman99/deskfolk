import { expect, test } from "bun:test";
import { CwdTracker } from "./terminal-cwd";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

/** Percent-encodes the way the daemon's own zsh integration does: byte by byte, UTF-8. */
function percentEncode(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && /[/._~A-Za-z0-9-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function osc7(path: string, terminator: string, host = "myhost"): Uint8Array {
  return new TextEncoder().encode(`${ESC}]7;file://${host}${percentEncode(path)}${terminator}`);
}

test("a whole OSC 7 sequence in one chunk decodes the path", () => {
  const tracker = new CwdTracker();
  expect(tracker.feed(osc7("/Users/x/project", BEL))).toBe("/Users/x/project");
});

test("ST (ESC \\\\) terminates a sequence exactly like BEL", () => {
  const tracker = new CwdTracker();
  expect(tracker.feed(osc7("/Users/x/project", ST))).toBe("/Users/x/project");
});

test("a sequence split across two chunks is still decoded", () => {
  const tracker = new CwdTracker();
  const whole = osc7("/Users/x/project", BEL);
  const at = 6;
  expect(tracker.feed(whole.slice(0, at))).toBeNull();
  expect(tracker.feed(whole.slice(at))).toBe("/Users/x/project");
});

test("a split right inside 'ESC ]' is still recognized", () => {
  const tracker = new CwdTracker();
  const whole = osc7("/Users/x/project", BEL);
  // Byte 0 is ESC, byte 1 is ']' — split between them.
  expect(tracker.feed(whole.slice(0, 1))).toBeNull();
  expect(tracker.feed(whole.slice(1))).toBe("/Users/x/project");
});

test("a sequence split across three chunks is still decoded", () => {
  const tracker = new CwdTracker();
  const whole = osc7("/Users/x/deeply/nested/project", BEL);
  const a = 2;
  const b = Math.floor(whole.length / 2);
  expect(tracker.feed(whole.slice(0, a))).toBeNull();
  expect(tracker.feed(whole.slice(a, b))).toBeNull();
  expect(tracker.feed(whole.slice(b))).toBe("/Users/x/deeply/nested/project");
});

test("percent-encoded spaces and CJK round-trip back to the real path", () => {
  const tracker = new CwdTracker();
  const path = "/Users/x/a b 中文";
  expect(tracker.feed(osc7(path, BEL))).toBe(path);
});

test("a payload that is not a file:// URL is ignored", () => {
  const tracker = new CwdTracker();
  const bytes = new TextEncoder().encode(`${ESC}]7;http://myhost/Users/x${BEL}`);
  expect(tracker.feed(bytes)).toBeNull();
});

test("a relative payload (no path after the host) is ignored", () => {
  const tracker = new CwdTracker();
  const bytes = new TextEncoder().encode(`${ESC}]7;file://myhost${BEL}`);
  expect(tracker.feed(bytes)).toBeNull();
});

test("garbage that never matches the OSC 7 prefix at all is ignored", () => {
  const tracker = new CwdTracker();
  const bytes = new TextEncoder().encode(`${ESC}]2;some window title${BEL}not an escape sequence at all`);
  expect(tracker.feed(bytes)).toBeNull();
});

test("a percent-decoded control character is ignored", () => {
  const tracker = new CwdTracker();
  const bytes = new TextEncoder().encode(`${ESC}]7;file://myhost/a%00b${BEL}`);
  expect(tracker.feed(bytes)).toBeNull();
});

test("multiple sequences in one chunk: the last one wins", () => {
  const tracker = new CwdTracker();
  const chunk = new Uint8Array([...osc7("/Users/x/first", BEL), ...osc7("/Users/x/second", BEL)]);
  expect(tracker.feed(chunk)).toBe("/Users/x/second");
});

test("an oversize, unterminated payload is dropped rather than kept forever", () => {
  const tracker = new CwdTracker();
  const huge = new TextEncoder().encode(`${ESC}]7;file://myhost/${"a".repeat(9000)}`);
  expect(tracker.feed(huge)).toBeNull();
  // The tracker gave up on the oversize sequence; a fresh, well-formed one still works.
  expect(tracker.feed(osc7("/Users/x/after", BEL))).toBe("/Users/x/after");
});
