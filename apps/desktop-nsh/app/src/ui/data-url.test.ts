/** Bytes as Base64 for a `data:` URL: the engine's `btoa` over the bytes, a chunk at a time. */
import { expect, test } from "nsh/test";
import { base64, blobDataUrl } from "./data-url";

test("Base64 is the standard alphabet with its padding", () => {
  const enc = (s: string) => base64(new TextEncoder().encode(s));
  expect(enc("")).toBe("");
  expect(enc("f")).toBe("Zg==");
  expect(enc("fo")).toBe("Zm8=");
  expect(enc("foo")).toBe("Zm9v");
  expect(enc("风沙")).toBe("6aOO5rKZ");
  expect(base64(Uint8Array.from([0, 255, 128, 62, 63]))).toBe("AP+APj8=");
});

test("bytes past a chunk come out whole and in order", () => {
  const bytes = new Uint8Array(0x8000 * 3 + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
  const decoded = Uint8Array.from(atob(base64(bytes)), (c) => c.charCodeAt(0));
  expect(decoded.length).toBe(bytes.length);
  expect(decoded.every((b, i) => b === bytes[i])).toBe(true);
});

test("a blob becomes a data URL of its type", async () => {
  expect(await blobDataUrl(new Blob(["hi"], { type: "text/plain" }))).toBe("data:text/plain;base64,aGk=");
  expect(await blobDataUrl(new Blob(["hi"]))).toBe("data:application/octet-stream;base64,aGk=");
});
