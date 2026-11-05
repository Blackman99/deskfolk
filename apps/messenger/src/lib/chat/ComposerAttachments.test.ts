import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import type { FileLoadOptions } from "../file-progress.ts";
import type { StagedAttachment, StagedWorkspacePath } from "../session-view.svelte.ts";
import { aBot, aDirect, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, press, render } from "../test-render.ts";
import { settle } from "../test-async.ts";
import ComposerAttachments from "./ComposerAttachments.svelte";
import Composer from "./Composer.svelte";

const t = copyFor("zh");

function shot(id = "att-1", previewUrl: string | null = "blob:shot"): StagedAttachment {
  const file = new File(["png"], "image-0423.png", { type: "image/png" });
  return { id, file, name: "image-0423.png", size: file.size, isImage: true, previewUrl };
}

function bar(rows: { attachments?: StagedAttachment[]; paths?: StagedWorkspacePath[] }, api: unknown = null) {
  const props = reactive({
    t,
    api: api as never,
    pendingAttachments: rows.attachments ?? [],
    pendingPaths: rows.paths ?? [],
    sending: false,
    uploadedPercent: () => null,
    onRemoveAttachment: () => {},
    onRemovePath: () => {},
  });
  return { ...render(ComposerAttachments, props), props };
}

const lightbox = () => document.querySelector(".msg-image-lightbox");

/** A screenshot pasted into the box enlarges from its chip, from the bytes already in the page. */
test("a pasted picture enlarges from its thumbnail, named by its chip", () => {
  const { host, close } = bar({ attachments: [shot()] });
  try {
    const open = host.querySelector<HTMLButtonElement>(".attachment-preview-btn");
    expect(open?.getAttribute("aria-label")).toBe(`${t.stream.artifactEnlarge} image-0423.png`);
    click(open);
    // Over the whole app, not inside the composer's click-through layer.
    expect(host.querySelector(".msg-image-lightbox")).toBeNull();
    expect(lightbox()?.parentElement).toBe(document.body);
    expect(document.querySelector(".msg-image-full")?.getAttribute("src")).toBe("blob:shot");
    expect(document.querySelector(".msg-image-caption")?.textContent).toBe("image-0423.png");
    expect(document.querySelector(".msg-image-frame")?.getAttribute("aria-label")).toBe("image-0423.png");
    // Already on this device: nothing to save or fetch.
    expect(document.querySelector(".msg-image-save")).toBeNull();
    expect(document.querySelector(".msg-image-original")).toBeNull();

    press(document.body, "Escape");
    expect(lightbox()).toBeNull();
  } finally {
    close();
  }
});

test("a file that is not a picture has no enlargement", () => {
  const file = new File(["%PDF"], "report.pdf", { type: "application/pdf" });
  const { host, close } = bar({ attachments: [{ id: "att-pdf", file, name: "report.pdf", size: 4, isImage: false, previewUrl: null }] });
  expect(host.querySelector(".attachment-preview-btn")).toBeNull();
  close();
});

/** ✕ or a send revokes the chip's object URL: the enlargement goes with the chip. */
test("the enlargement goes when its picture leaves the box", () => {
  const { host, props, close } = bar({ attachments: [shot("att-1"), shot("att-2", "blob:other")] });
  try {
    click(host.querySelectorAll(".attachment-preview-btn")[0]);
    expect(lightbox()).not.toBeNull();
    // Another chip taken away leaves this one up.
    props.pendingAttachments = props.pendingAttachments.filter((row) => row.id !== "att-2");
    flushSync();
    expect(document.querySelector(".msg-image-full")?.getAttribute("src")).toBe("blob:shot");
    props.pendingAttachments = [];
    flushSync();
    expect(lightbox()).toBeNull();
  } finally {
    close();
  }
});

/** A picture dragged in from the file tree enlarges from the Mac's bytes, over its 256 px copy. */
test("a staged workspace picture enlarges from its file", async () => {
  const asked: Array<[string, FileLoadOptions | undefined]> = [];
  const api = {
    kind: "local",
    getWorkspaceFileBlob: async (path: string, _progress: unknown, options?: FileLoadOptions) => {
      asked.push([path, options]);
      return new Blob([new Uint8Array([1])], { type: "image/png" });
    },
  };
  const ref: StagedWorkspacePath = { id: "ref-1", path: "shots/a.png", name: "a.png", isDir: false, isImage: true, previewUrl: "blob:thumb" };
  const { host, close } = bar({ paths: [ref] }, api);
  try {
    click(host.querySelector(".attachment-preview-btn"));
    await settle();
    expect(asked.map(([path, options]) => [path, options?.size])).toEqual([["shots/a.png", undefined]]);
    expect(document.querySelector(".msg-image-caption")?.textContent).toBe("a.png");
  } finally {
    close();
  }
});

/** What WebKit's paste event carries for a screenshot: one file item, and no text. */
function pasteFile(editor: HTMLElement, file: File): void {
  const items = [{ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) }];
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { items, types: ["Files"], getData: () => "" } });
  editor.dispatchEvent(ev);
  flushSync();
}

/** Paste, look at it, send: Enter in the box sends while it is up, and it goes with the chip. */
test("in a Bot's composer a pasted screenshot enlarges, and a send puts it away", async () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = (() => "blob:pasted") as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
  const sent: File[][] = [];
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async (files: File[]) => {
      sent.push(files);
      return true;
    },
    onPickPrompt: () => {},
  });
  try {
    const editor = view.host.querySelector(".composer-input") as HTMLElement;
    const file = new File(["png"], "image.png", { type: "image/png" });
    pasteFile(editor, file);
    click(view.host.querySelector(".attachment-preview-btn"));
    expect(document.querySelector(".msg-image-full")?.getAttribute("src")).toBe("blob:pasted");

    click(view.host.querySelector(".composer-action"));
    await settle();
    expect(sent).toEqual([[file]]);
    expect(revoked).toEqual(["blob:pasted"]);
    expect(lightbox()).toBeNull();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    view.close();
  }
});
