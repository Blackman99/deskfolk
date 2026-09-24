import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { rememberBlobOriginalSize } from "../api.ts";
import { copyFor } from "../copy.ts";
import type { FileLoadOptions, FileProgressHandler } from "../file-progress.ts";
import { anAttachment } from "../test-fixtures.ts";
import { render } from "../test-render.ts";
import MessageImageLightbox from "./MessageImageLightbox.svelte";

const t = copyFor("zh");
const ORIGINAL = 3_727_854;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};

function scaledCopy(): Blob {
  const copy = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  rememberBlobOriginalSize(copy, ORIGINAL);
  return copy;
}

function fakeApi(kind: "remote" | "local", answer: (options: FileLoadOptions | undefined, onProgress?: FileProgressHandler) => Promise<Blob>) {
  const asked: Array<FileLoadOptions | undefined> = [];
  const api = {
    kind,
    getAttachmentBlob: (_id: string, onProgress?: FileProgressHandler, options?: FileLoadOptions) => {
      asked.push(options);
      return answer(options, onProgress);
    },
  };
  return { api, asked };
}

const picture = anAttachment({ id: "pic", original_filename: "frame.png", workspace_relpath: "shots/frame.png", size: ORIGINAL });

/** A phone enlarges the Mac's 1600 px copy, and the original is one tap away, with its weight. */
test("a remote enlargement shows the copy and swaps in the original on request", async () => {
  let resolveOriginal!: (blob: Blob) => void;
  let report: FileProgressHandler | undefined;
  const { api, asked } = fakeApi("remote", (options, onProgress) => {
    if (options?.size) return Promise.resolve(scaledCopy());
    report = onProgress;
    return new Promise<Blob>((resolve) => { resolveOriginal = resolve; });
  });
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    // Nothing to stand in for it, so the 256 px copy comes first, then the 1600 px one.
    expect(asked.map((row) => row?.size)).toEqual(["thumb", "preview"]);
    const copyUrl = host.querySelector<HTMLImageElement>(".msg-image-full")?.src;
    expect(copyUrl).toBeTruthy();
    const offer = host.querySelector<HTMLButtonElement>(".msg-image-original");
    expect(offer?.textContent).toContain("查看原图（3.6 MB）");
    offer!.click();
    flushSync();
    expect(asked[2]?.size).toBeUndefined();
    report?.({ loaded: 1_048_576, total: ORIGINAL });
    flushSync();
    expect(host.querySelector(".msg-image-original")?.textContent).toContain("正在载入原图 1.0 MB / 3.6 MB");
    expect(host.querySelector<HTMLImageElement>(".msg-image-full")?.src).toBe(copyUrl);
    resolveOriginal(new Blob([new Uint8Array([9])], { type: "image/png" }));
    await settle();
    expect(host.querySelector(".msg-image-original")).toBeNull();
    expect(host.querySelector<HTMLImageElement>(".msg-image-full")?.src).not.toBe(copyUrl);
  } finally {
    close();
  }
});

/** On the Mac the read is free, so the enlargement is the original and offers nothing. */
test("a local enlargement is the original", async () => {
  const { api, asked } = fakeApi("local", async () => new Blob([new Uint8Array([1])], { type: "image/png" }));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.size).toBeUndefined();
    expect(host.querySelector(".msg-image-full")).not.toBeNull();
    expect(host.querySelector(".msg-image-original")).toBeNull();
  } finally {
    close();
  }
});

/** The preview pane hands over its own copy; enlarged, it still offers the original. */
test("a handed-over copy offers the original and fetches it here", async () => {
  const { api, asked } = fakeApi("remote", async () => new Blob([new Uint8Array([9])], { type: "image/png" }));
  const { host, close } = render(MessageImageLightbox, {
    attachment: picture,
    src: "blob:copy",
    srcOriginalSize: ORIGINAL,
    api: api as never,
    t,
    onClose: () => {},
  });
  try {
    await settle();
    expect(asked).toHaveLength(0);
    expect(host.querySelector<HTMLImageElement>(".msg-image-full")?.getAttribute("src")).toBe("blob:copy");
    host.querySelector<HTMLButtonElement>(".msg-image-original")!.click();
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.size).toBeUndefined();
    expect(host.querySelector<HTMLImageElement>(".msg-image-full")?.getAttribute("src")).not.toBe("blob:copy");
    expect(host.querySelector(".msg-image-original")).toBeNull();
  } finally {
    close();
  }
});

/** Closing mid-download stops it, so the phone's one link is free for whatever comes next. */
test("closing the enlargement stops the original on its way", async () => {
  const { api, asked } = fakeApi("remote", (options) =>
    options?.size ? Promise.resolve(scaledCopy()) : new Promise<Blob>(() => {}));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  let closed = false;
  try {
    await settle();
    host.querySelector<HTMLButtonElement>(".msg-image-original")!.click();
    flushSync();
    const original = asked.find((row) => row && !row.size);
    expect(original?.signal?.aborted).toBe(false);
    close();
    closed = true;
    expect(original?.signal?.aborted).toBe(true);
  } finally {
    if (!closed) close();
  }
});

/**
 * The regression. Remotely the enlargement grew into a large box with a spinner, and once the
 * picture came it resized again to the picture's own shape. With the chip's thumbnail in hand it
 * is on screen at once at the picture's proportions, and the real bytes replace it in place.
 */
test("a thumbnail on hand stands in at the picture's shape while the real one arrives", async () => {
  let resolvePreview!: (blob: Blob) => void;
  let report: FileProgressHandler | undefined;
  const { api, asked } = fakeApi("remote", (options, onProgress) => {
    report = onProgress;
    return new Promise<Blob>((resolve) => { resolvePreview = resolve; });
  });
  const { host, close } = render(MessageImageLightbox, {
    attachment: picture, placeholder: "blob:chip-thumb", api: api as never, t, onClose: () => {},
  });
  try {
    await settle();
    // No second thumbnail: the one on hand says the shape.
    expect(asked.map((row) => row?.size)).toEqual(["preview"]);
    const img = host.querySelector<HTMLImageElement>(".msg-image-full");
    expect(img?.getAttribute("src")).toBe("blob:chip-thumb");
    report?.({ loaded: 102_400, total: 409_600 });
    flushSync();
    const status = host.querySelector(".msg-image-progress");
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.textContent).toContain("100.0 KB / 400.0 KB");
    expect(host.querySelector(".msg-image-frame")?.classList.contains("is-loading")).toBe(false);
    resolvePreview(scaledCopy());
    await settle();
    // The same element, now the real picture: nothing re-grows.
    expect(host.querySelector(".msg-image-full")).toBe(img);
    expect(img?.getAttribute("src")).not.toBe("blob:chip-thumb");
    expect(host.querySelector(".msg-image-progress")).toBeNull();
  } finally {
    close();
  }
});

/** A picture no bigger than its thumbnail is the thumbnail: one request, and done. */
test("a remote picture already thumbnail-sized is fetched once", async () => {
  const { api, asked } = fakeApi("remote", async () => new Blob([new Uint8Array([7])], { type: "image/png" }));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    expect(asked.map((row) => row?.size)).toEqual(["thumb"]);
    expect(host.querySelector(".msg-image-full")).not.toBeNull();
    expect(host.querySelector(".msg-image-original")).toBeNull();
    expect(host.querySelector(".msg-image-progress, .msg-image-waiting")).toBeNull();
  } finally {
    close();
  }
});

/** With no pixels yet the frame waits in the picture it grows out of; the progress is readable. */
test("before the first pixels the frame waits in place and the progress shows mid-screen", async () => {
  let report: FileProgressHandler | undefined;
  const { api } = fakeApi("local", (_options, onProgress) => {
    report = onProgress;
    return new Promise<Blob>(() => {});
  });
  const origin = { top: 40, left: 80, width: 36, height: 36 };
  const { host, close } = render(MessageImageLightbox, { attachment: picture, origin, api: api as never, t, onClose: () => {} });
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    flushSync();
    expect(host.querySelector(".msg-image-lightbox")?.classList.contains("is-shown")).toBe(true);
    const frame = host.querySelector<HTMLElement>(".msg-image-frame")!;
    expect([frame.style.width, frame.style.height]).toEqual(["36px", "36px"]);
    report?.({ loaded: 1_048_576, total: 3_727_854 });
    flushSync();
    expect(host.querySelector(".msg-image-waiting")?.textContent).toContain("1.0 MB / 3.6 MB");
    expect([frame.style.width, frame.style.height]).toEqual(["36px", "36px"]);
  } finally {
    close();
  }
});
