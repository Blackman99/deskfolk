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

/** A phone's share sheet: `answer` decides how each opening ends. Restored by the returned function. */
function onAPhone(answer: () => Promise<void>) {
  const shared: File[][] = [];
  const realMatchMedia = window.matchMedia;
  const realShare = Object.getOwnPropertyDescriptor(navigator, "share");
  const realCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare");
  window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: (data: ShareData) => {
      shared.push(data.files ?? []);
      return answer();
    },
  });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  const restore = () => {
    window.matchMedia = realMatchMedia;
    if (realShare) Object.defineProperty(navigator, "share", realShare);
    else delete (navigator as { share?: unknown }).share;
    if (realCanShare) Object.defineProperty(navigator, "canShare", realCanShare);
    else delete (navigator as { canShare?: unknown }).canShare;
  };
  return { shared, restore };
}

/**
 * The phone saves the original, not the 1600 px copy on screen. It is fetched once: it also
 * replaces the copy, and a second save opens the share sheet inside the tap with nothing to wait for.
 */
test("a remote save fetches the original once and hands it to the share sheet", async () => {
  const phone = onAPhone(async () => {});
  let resolveOriginal!: (blob: Blob) => void;
  const { api, asked } = fakeApi("remote", (options) =>
    options?.size ? Promise.resolve(scaledCopy()) : new Promise<Blob>((resolve) => { resolveOriginal = resolve; }));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    const save = host.querySelector<HTMLButtonElement>(".msg-image-save");
    expect(save?.getAttribute("aria-label")).toBe("下载原图");
    const copyUrl = host.querySelector<HTMLImageElement>(".msg-image-full")?.src;
    save!.click();
    flushSync();
    expect(asked).toHaveLength(3);
    expect(asked[2]?.size).toBeUndefined();
    expect(save?.disabled).toBe(true);
    // The offer shows the download a save started.
    expect(host.querySelector(".msg-image-original")?.textContent).toContain("正在载入原图");
    resolveOriginal(new Blob([new Uint8Array([9])], { type: "image/png" }));
    await settle();
    expect(phone.shared).toHaveLength(1);
    expect(phone.shared[0]?.[0]?.name).toBe("frame.png");
    expect(phone.shared[0]?.[0]?.type).toBe("image/png");
    expect(host.querySelector(".msg-image-original")).toBeNull();
    expect(host.querySelector<HTMLImageElement>(".msg-image-full")?.src).not.toBe(copyUrl);
    host.querySelector<HTMLButtonElement>(".msg-image-save")!.click();
    // Opened in the tap itself, before any await.
    expect(phone.shared).toHaveLength(2);
    await settle();
    expect(asked).toHaveLength(3);
  } finally {
    close();
    phone.restore();
  }
});

/** The tap was spent while the original came. The bytes are here now, so the next tap works. */
test("a share sheet refused after the wait asks for one more tap", async () => {
  let refuse = true;
  const phone = onAPhone(() => {
    if (!refuse) return Promise.resolve();
    refuse = false;
    return Promise.reject(new DOMException("no gesture", "NotAllowedError"));
  });
  const { api, asked } = fakeApi("remote", async (options) =>
    options?.size ? scaledCopy() : new Blob([new Uint8Array([9])], { type: "image/png" }));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    host.querySelector<HTMLButtonElement>(".msg-image-save")!.click();
    await settle();
    await settle();
    expect(phone.shared).toHaveLength(1);
    expect(host.querySelector(".msg-image-caption")?.textContent).toBe("原图已取回，再点一次下载");
    expect(host.querySelector(".msg-image-save")?.classList.contains("is-ready")).toBe(true);
    host.querySelector<HTMLButtonElement>(".msg-image-save")!.click();
    expect(phone.shared).toHaveLength(2);
    await settle();
    expect(asked).toHaveLength(3);
    expect(host.querySelector(".msg-image-caption")?.textContent).toBe("frame.png");
    expect(host.querySelector(".msg-image-save")?.classList.contains("is-ready")).toBe(false);
  } finally {
    close();
    phone.restore();
  }
});

/** A picture no bigger than its thumbnail is already the original: saved in the tap, nothing fetched. */
test("a picture that is already the original is saved without another request", async () => {
  const phone = onAPhone(async () => {});
  const { api, asked } = fakeApi("remote", async () => new Blob([new Uint8Array([7])], { type: "image/png" }));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    host.querySelector<HTMLButtonElement>(".msg-image-save")!.click();
    expect(phone.shared).toHaveLength(1);
    await settle();
    expect(asked).toHaveLength(1);
  } finally {
    close();
    phone.restore();
  }
});

test("an original that does not come says so under the picture", async () => {
  const phone = onAPhone(async () => {});
  const { api } = fakeApi("remote", (options) =>
    options?.size ? Promise.resolve(scaledCopy()) : Promise.reject(new Error("too large")));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    host.querySelector<HTMLButtonElement>(".msg-image-save")!.click();
    await settle();
    await settle();
    expect(phone.shared).toHaveLength(0);
    expect(host.querySelector(".msg-image-caption")?.textContent).toBe("没能下载原图");
    expect(host.querySelector<HTMLButtonElement>(".msg-image-save")?.disabled).toBe(false);
    // The copy stays, and so does the offer.
    expect(host.querySelector(".msg-image-original")).not.toBeNull();
  } finally {
    close();
    phone.restore();
  }
});

/** On the Mac the file is already on this machine. */
test("a local enlargement offers no save", async () => {
  const { api } = fakeApi("local", async () => new Blob([new Uint8Array([1])], { type: "image/png" }));
  const { host, close } = render(MessageImageLightbox, { attachment: picture, api: api as never, t, onClose: () => {} });
  try {
    await settle();
    expect(host.querySelector(".msg-image-full")).not.toBeNull();
    expect(host.querySelector(".msg-image-save")).toBeNull();
  } finally {
    close();
  }
});
