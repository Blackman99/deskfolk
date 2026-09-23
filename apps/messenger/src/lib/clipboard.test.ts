import { expect, test } from "bun:test";
import { clipboardImageBlob, copyRenderedImage, readClipboardText, readRenderedImage } from "./clipboard.ts";

/** 1×1 PNG. */
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1,
  255, 137, 153, 28, 44, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

test("a png is copied as the same bytes", async () => {
  const source = new Blob([PNG], { type: "image/png" });
  const out = await clipboardImageBlob(source);
  expect(out).toBe(source);
  expect(out.type).toBe("image/png");
});

function withClipboardWrite(
  write: (items: ClipboardItem[]) => Promise<void>,
  run: () => Promise<void>,
): Promise<void> {
  const clipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard?.writeText?.bind(clipboard), write },
  });
  return run().finally(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  });
}

test("copy starts the clipboard write before the picture's bytes resolve", async () => {
  const written: ClipboardItem[] = [];
  const url = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
  const bytes = await readRenderedImage(url);
  expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG);
  await withClipboardWrite(
    async (items) => {
      written.push(...items);
    },
    async () => {
      const pending = copyRenderedImage(url);
      expect(written).toHaveLength(1);
      expect(written[0]!.types).toEqual(["image/png"]);
      const png = await written[0]!.getType("image/png");
      expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
      await pending;
    },
  );
});

test("copy rejects when the picture cannot be read and still hands the promise to the clipboard", async () => {
  let seen = false;
  await withClipboardWrite(
    async (items) => {
      seen = true;
      await items[0]!.getType("image/png");
    },
    async () => {
      await expect(copyRenderedImage("blob:http://localhost/missing-picture")).rejects.toThrow();
      expect(seen).toBe(true);
    },
  );
});

test("in the desktop window a menu's Paste reads the pasteboard natively, with no second click", async () => {
  const calls: string[] = [];
  const internals = { invoke: async (cmd: string) => { calls.push(cmd); return "ls -la\n"; } };
  expect(await readClipboardText(internals)).toBe("ls -la\n");
  expect(calls).toEqual(["read_clipboard_text"]);
  // An empty pasteboard is nothing to paste, not an error.
  expect(await readClipboardText({ invoke: async () => null })).toBe("");
});

test("outside the window, or if the command fails, the page's own reader is asked", async () => {
  const clipboard = navigator.clipboard as { readText?: () => Promise<string> } | undefined;
  const original = clipboard?.readText;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { ...clipboard, readText: async () => "from page" } });
  try {
    expect(await readClipboardText(undefined)).toBe("from page");
    expect(await readClipboardText({ invoke: async () => { throw new Error("no such command"); } })).toBe("from page");
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { ...clipboard, readText: original } });
  }
});
