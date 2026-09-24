import { expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";
import { COPY } from "./copy.ts";
import ImageCopy from "./ImageCopy.svelte";
import { copyableImageAt } from "./image-context.ts";

function picture(marked: boolean, src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"): HTMLImageElement {
  const image = document.createElement("img");
  if (marked) image.dataset.copyImage = "";
  image.src = src;
  Object.defineProperty(image, "currentSrc", { configurable: true, get: () => src });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 12 });
  document.body.appendChild(image);
  return image;
}

test("only a decoded picture the app marked can be copied", () => {
  const rendered = picture(true);
  const avatar = picture(false);
  const broken = picture(true, "");
  Object.defineProperty(broken, "naturalWidth", { configurable: true, value: 0 });
  const span = document.createElement("span");
  rendered.append(span);
  try {
    expect(copyableImageAt(span)).toBe(rendered);
    expect(copyableImageAt(avatar)).toBeNull();
    expect(copyableImageAt(broken)).toBeNull();
    expect(copyableImageAt(document.body)).toBeNull();
  } finally {
    rendered.remove();
    avatar.remove();
    broken.remove();
  }
});

test("right-clicking a rendered picture opens copy and leaves the pane menu the event", async () => {
  const image = picture(true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = mount(ImageCopy, { target: host, props: { t: COPY.zh } });
  flushSync();
  const clipboard = navigator.clipboard;
  let wrote = 0;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: clipboard?.writeText?.bind(clipboard),
      write: async () => {
        wrote += 1;
      },
    },
  });
  try {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
    image.dispatchEvent(event);
    flushSync();
    expect(event.defaultPrevented).toBe(true);
    const menu = document.querySelector("[data-testid='image-context-menu']");
    expect(menu?.textContent).toContain("复制图片");
    (menu?.querySelector("button") as HTMLButtonElement).click();
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(wrote).toBe(1);
    expect(document.querySelector("[data-testid='image-context-menu']")).toBeNull();

    const option = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 50,
      altKey: true,
    });
    image.dispatchEvent(option);
    flushSync();
    expect(option.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-testid='image-context-menu']")).toBeNull();
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    void unmount(app);
    host.remove();
    image.remove();
  }
});
