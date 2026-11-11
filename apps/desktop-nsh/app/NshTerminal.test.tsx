/** How `NshTerminal` takes the runtime's stream: base64 frames, skipped where already shown, decoded as one text. */
import { expect, test } from "nsh/test";
import { bytesOf, unseen } from "./src/NshTerminal";

test("a frame's base64 is its bytes", () => {
  expect([...bytesOf("5Lit")]).toEqual([0xe4, 0xb8, 0xad]);
  expect([...bytesOf("bHMN")]).toEqual([0x6c, 0x73, 0x0d]);
  expect(bytesOf("").length).toBe(0);
});

test("frames already on the screen are dropped and overlaps trimmed", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
  expect(text(unseen(10, 0, bytes("0123456789")))).toBe(null);
  expect(text(unseen(10, 5, bytes("56789abc")))).toBe("abc");
  expect(text(unseen(10, 10, bytes("abc")))).toBe("abc");
  expect(text(unseen(10, 20, bytes("xyz")))).toBe("xyz");
});

test("a character split across two frames comes out whole", () => {
  const decoder = new TextDecoder();
  const zhong = bytesOf("5Lit");
  expect(decoder.decode(zhong.subarray(0, 2), { stream: true })).toBe("");
  expect(decoder.decode(zhong.subarray(2), { stream: true })).toBe("中");
});
