import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup, aMessage, anAttachment, fakeRuntime } from "../test-fixtures.ts";
import ChatStage from "./ChatStage.svelte";
import { render } from "../test-render.ts";
import MessageAttachments from "./MessageAttachments.svelte";
import MessageImageLightbox from "./MessageImageLightbox.svelte";

const t = copyFor("zh");
const picture = anAttachment({ id: "transparent", original_filename: "transparent.png", workspace_relpath: "images/transparent.png" });
const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};
let palette: HTMLStyleElement;
let previousTheme: string | null;

beforeEach(() => {
  previousTheme = document.documentElement.getAttribute("data-theme");
  palette = document.createElement("style");
  palette.textContent = tokens;
  document.head.append(palette);
});

afterEach(() => {
  palette.remove();
  if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", previousTheme);
});

const themes = [
  { name: "light", pane: "#ffffff", ink: "#0f172a", control: "#ffffff", thumb: "#f1f5f9", accent: "#2563eb" },
  { name: "dark", pane: "#161e2b", ink: "#f1f5f9", control: "#1c2534", thumb: "#182231", accent: "#3b82f6" },
];

for (const [label, session] of [
  ["file conversation", aDirect({ id: "filedrop", participants: [{ member: "user", joined_at: "2026-09-19T00:00:00.000Z", left_at: null }] })],
  ["direct", aDirect()],
  ["group", aGroup()],
] as const) {
  test(`${label} attachment cards follow both themes inside user and Bot bubbles`, () => {
    const messages = (["user", "bot"] as const).flatMap((kind) => ["single", "bundle"].map((shape, index) => {
      const id = `${kind}-${shape}`;
      const attachment = anAttachment({ ...picture, id: `${id}-one`, message_id: id });
      return aMessage({
        id, session_id: session.id, kind, author: kind === "user" ? "user" : "bot-1", body: "",
        created_at: `2026-09-19T02:00:0${index + (kind === "bot" ? 2 : 0)}.000Z`,
        attachments: shape === "single" ? [attachment] : [attachment, anAttachment({
          ...attachment, id: `${id}-two`, original_filename: "second.png", workspace_relpath: "images/second.png",
        })],
      });
    }));
    const { host, close } = render(ChatStage, {
      runtime: fakeRuntime({ bots: [aBot()], sessions: [session], messages }, { selectedId: session.id }),
      selected: session, t, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
    });
    try {
      expect(host.querySelectorAll(".msg.is-you .attachment-file-btn, .msg.is-you .attachment-bundle-btn").length).toBe(2);
      expect(host.querySelectorAll(".msg:not(.is-you) .attachment-file-btn, .msg:not(.is-you) .attachment-bundle-btn").length).toBe(2);
      const cards = host.querySelectorAll(".attachment-file-btn, .attachment-bundle-btn");
      for (const theme of [...themes].reverse()) {
        document.documentElement.dataset.theme = theme.name;
        for (const card of cards) {
          const style = getComputedStyle(card);
          expect(style.backgroundColor).toBe(theme.pane);
          expect(style.color).toBe(theme.ink);
        }
      }
    } finally {
      close();
    }
  });
}

test("an open image and its controls follow live theme changes", () => {
  const { host, close } = render(MessageImageLightbox, {
    attachment: picture, src: "blob:transparent", srcOriginalSize: 1024, api: null, t, onClose: () => {},
  });
  try {
    const image = host.querySelector<HTMLImageElement>(".msg-image-full")!;
    for (const theme of themes) {
      document.documentElement.dataset.theme = theme.name;
      expect(getComputedStyle(host.querySelector(".msg-image-frame")!).backgroundColor).toBe(theme.pane);
      expect(getComputedStyle(image).backgroundColor).toBe(theme.pane);
      for (const selector of [".msg-image-close", ".msg-image-original"]) {
        const style = getComputedStyle(host.querySelector(selector)!);
        expect(style.backgroundColor).toBe(theme.control);
        expect(style.color).toBe(theme.ink);
      }
      expect(host.querySelector(".msg-image-full")).toBe(image);
      expect(image.getAttribute("src")).toBe("blob:transparent");
    }
  } finally {
    close();
  }
});

for (const theme of themes) {
  test(`${theme.name} image loading uses the theme surface and progress colour`, async () => {
    document.documentElement.dataset.theme = theme.name;
    const { host, close } = render(MessageImageLightbox, {
      attachment: picture,
      origin: { top: 20, left: 20, width: 36, height: 36 },
      api: { kind: "local", getAttachmentBlob: () => new Promise<Blob>(() => {}) } as never,
      t, onClose: () => {},
    });
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      flushSync();
      expect(getComputedStyle(host.querySelector(".msg-image-frame")!).backgroundColor).toBe(theme.pane);
      const waiting = getComputedStyle(host.querySelector(".msg-image-waiting")!);
      expect(waiting.backgroundColor).toBe(theme.pane);
      expect(waiting.color).toBe(theme.ink);
      expect(getComputedStyle(host.querySelector(".msg-image-loading-fill")!).backgroundColor).toBe(theme.accent);
    } finally {
      close();
    }
  });

  test(`${theme.name} image failure remains readable`, async () => {
    document.documentElement.dataset.theme = theme.name;
    const { host, close } = render(MessageImageLightbox, {
      attachment: picture,
      api: { kind: "local", getAttachmentBlob: async () => { throw new Error("missing"); } } as never,
      t, onClose: () => {},
    });
    try {
      await settle();
      expect(host.querySelector(".msg-image-status")?.textContent).toBe(t.stream.artifactMissing);
      expect(getComputedStyle(host.querySelector(".msg-image-status")!).color).toBe(theme.ink);
      expect(getComputedStyle(host.querySelector(".msg-image-frame")!).backgroundColor).toBe(theme.pane);
    } finally {
      close();
    }
  });

  test(`${theme.name} attachment thumbnails retain their loading background`, async () => {
    document.documentElement.dataset.theme = theme.name;
    let resolve!: (blob: Blob) => void;
    const { host, close } = render(MessageAttachments, {
      attachments: [picture],
      api: { getAttachmentBlob: () => new Promise<Blob>((done) => { resolve = done; }) } as never,
      t, onPreview: () => {},
    });
    try {
      expect(getComputedStyle(host.querySelector(".attachment-chip-pending")!).backgroundColor).toBe(theme.thumb);
      resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
      await settle();
      expect(getComputedStyle(host.querySelector(".attachment-chip-thumb")!).backgroundColor).toBe(theme.thumb);
    } finally {
      close();
    }
  });
}
