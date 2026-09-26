import { afterEach, expect, test } from "bun:test";
import { saveFile } from "./save-file.ts";

const picture = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

const realShare = Object.getOwnPropertyDescriptor(navigator, "share");
const realCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare");
const realClick = HTMLAnchorElement.prototype.click;

/** The share sheet, as a phone offers it. `share` decides how the sheet ends. */
function withShareSheet(share: (data: ShareData) => Promise<void>, canShare = true): ShareData[] {
  const shared: ShareData[] = [];
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: (data: ShareData) => {
      shared.push(data);
      return share(data);
    },
  });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => canShare });
  return shared;
}

/** Links clicked, instead of happy-dom navigating to them. */
function catchDownloads(): Array<{ href: string; download: string; attached: boolean }> {
  const clicked: Array<{ href: string; download: string; attached: boolean }> = [];
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
  };
  return clicked;
}

afterEach(() => {
  if (realShare) Object.defineProperty(navigator, "share", realShare);
  else delete (navigator as { share?: unknown }).share;
  if (realCanShare) Object.defineProperty(navigator, "canShare", realCanShare);
  else delete (navigator as { canShare?: unknown }).canShare;
  HTMLAnchorElement.prototype.click = realClick;
});

/** On a phone the picture goes to the share sheet, whose Save Image reaches Photos. */
test("a touch device shares the file under its own name and type", async () => {
  const shared = withShareSheet(async () => {});
  const downloads = catchDownloads();
  expect(await saveFile(picture(), "frame.png", true)).toBe("saved");
  const file = shared[0]?.files?.[0];
  expect(file?.name).toBe("frame.png");
  expect(file?.type).toBe("image/png");
  expect(downloads).toHaveLength(0);
});

test("closing the share sheet is not a failure", async () => {
  withShareSheet(() => Promise.reject(new DOMException("closed", "AbortError")));
  expect(await saveFile(picture(), "frame.png", true)).toBe("cancelled");
});

/** The tap was spent waiting for the bytes. A download in its place would silently do nothing on iOS. */
test("a sheet refused for want of a tap asks for another tap and downloads nothing", async () => {
  withShareSheet(() => Promise.reject(new DOMException("no gesture", "NotAllowedError")));
  const downloads = catchDownloads();
  expect(await saveFile(picture(), "frame.png", true)).toBe("needs-tap");
  expect(downloads).toHaveLength(0);
});

test("a file the sheet cannot take is downloaded", async () => {
  const shared = withShareSheet(async () => {}, false);
  const downloads = catchDownloads();
  expect(await saveFile(picture(), "diagram.svg", true)).toBe("saved");
  expect(shared).toHaveLength(0);
  expect(downloads).toHaveLength(1);
  expect(downloads[0]?.download).toBe("diagram.svg");
});

/** A desktop browser downloads, even where it could share files. */
test("without a touch screen the file is downloaded", async () => {
  const shared = withShareSheet(async () => {});
  const downloads = catchDownloads();
  expect(await saveFile(picture(), "frame.png", false)).toBe("saved");
  expect(shared).toHaveLength(0);
  expect(downloads).toEqual([{ href: expect.stringMatching(/^blob:/), download: "frame.png", attached: true }]);
  // The link is not left behind.
  expect(document.querySelector("a[download]")).toBeNull();
});
