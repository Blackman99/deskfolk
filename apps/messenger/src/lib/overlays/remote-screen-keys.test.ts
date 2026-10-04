import { expect, test } from "bun:test";
import { KEYSYM, keysymFor, press, typeText } from "./remote-screen-keys.ts";

test("characters become X11 keysyms: Latin-1 as itself, the rest above 0x01000000", () => {
  expect(keysymFor("a")).toBe(0x61);
  expect(keysymFor("é")).toBe(0xe9);
  expect(keysymFor("中")).toBe(0x01000000 + 0x4e2d);
  expect(keysymFor("😀")).toBe(0x01000000 + 0x1f600);
  expect(keysymFor("\n")).toBe(KEYSYM.enter);
  expect(keysymFor("\u0007")).toBeNull();
});

test("armed modifiers wrap the next key, released in reverse; typed text carries them on its first character", () => {
  const sent: string[] = [];
  const send = (keysym: number, down: boolean) => sent.push(`${down ? "+" : "-"}${keysym.toString(16)}`);
  press(send, KEYSYM.tab, ["command", "shift"]);
  expect(sent).toEqual(["+ffeb", "+ffe1", "+ff09", "-ff09", "-ffe1", "-ffeb"]);
  sent.length = 0;
  typeText(send, "ab", ["control"]);
  expect(sent).toEqual(["+ffe3", "+61", "-61", "-ffe3", "+62", "-62"]);
});
