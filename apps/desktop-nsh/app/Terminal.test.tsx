/** The canvas terminal's key handling, and typing through the app to the runtime (stubbed). */
import { expect, test } from "nsh/test";
import { encode, keyBytes } from "./src/Terminal";

function decode(b64: string): string {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bits = b64.replace(/=+$/, "").split("").map((c) => table.indexOf(c).toString(2).padStart(6, "0")).join("");
  const bytes = bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes));
}

test("text goes to the pty as UTF-8 in base64", () => {
  expect(encode("ls\r")).toBe("bHMN");
  expect(encode("中")).toBe("5Lit");
  expect(encode("")).toBe("");
});

test("keys send VT sequences, application cursor keys when asked", () => {
  expect(keyBytes("up", false)).toBe("\x1b[A");
  expect(keyBytes("up", true)).toBe("\x1bOA");
  expect(keyBytes("shift+tab", false)).toBe("\x1b[Z");
  expect(keyBytes("ctrl+c", false)).toBe("\x03");
  expect(keyBytes("ctrl+z", false)).toBe("\x1a");
  expect(keyBytes("mod+k", false)).toBe(null);
});
