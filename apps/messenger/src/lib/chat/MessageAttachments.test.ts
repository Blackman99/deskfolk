import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { anAttachment } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { copyFor } from "../copy.ts";
import MessageAttachments from "./MessageAttachments.svelte";

const t = copyFor("zh");

function mount(rows: ReturnType<typeof anAttachment>[]) {
  const opened: string[] = [];
  const images: string[] = [];
  const view = render(MessageAttachments, {
    attachments: rows,
    api: null,
    t,
    onPreview: (att) => opened.push(att.id),
    onOpenImage: (att) => images.push(att.id),
  });
  return { ...view, opened, images };
}

test("a picture chip shows a spinner in its thumbnail while the bytes are on the way", async () => {
  let resolveBlob!: (blob: Blob) => void;
  const pending = new Promise<Blob>((resolve) => {
    resolveBlob = resolve;
  });
  const picture = anAttachment({
    id: "pic",
    original_filename: "image.png",
    workspace_relpath: "inbox/image-3.png",
    mime: "image/png",
  });
  const { host, close } = render(MessageAttachments, {
    attachments: [picture],
    api: { getAttachmentBlob: () => pending } as never,
    t,
    onPreview: () => {},
  });
  try {
    const chip = host.querySelector(".attachment-file-btn");
    expect(chip?.classList.contains("is-thumb-pending")).toBe(true);
    expect(chip?.getAttribute("aria-busy")).toBe("true");
    const spinner = chip?.querySelector(".attachment-chip-pending");
    expect(spinner).not.toBeNull();
    expect(spinner?.textContent).toContain("正在打开文件…");
    const box = window.getComputedStyle(spinner!);
    expect(box.width).toBe("36px");
    expect(box.height).toBe("36px");
    expect(chip?.querySelector(".file-icon-box")).toBeNull();
    resolveBlob(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(host.querySelector(".attachment-chip-pending")).toBeNull();
    expect(host.querySelector(".attachment-chip-thumb")).not.toBeNull();
  } finally {
    close();
  }
});

test("a picture chip opens in the message area", () => {
  const picture = anAttachment({
    id: "pic",
    original_filename: "image.png",
    workspace_relpath: "inbox/image-3.png",
    mime: "image/png",
  });
  const { host, close, opened, images } = mount([picture]);
  try {
    click(host.querySelector(".attachment-file-btn"));
    expect(images).toEqual(["pic"]);
    expect(opened).toEqual([]);
  } finally {
    close();
  }
});

test("a non-picture chip still opens the preview pane", () => {
  const note = anAttachment({ id: "note", original_filename: "ep-12.md" });
  const { host, close, opened, images } = mount([note]);
  try {
    click(host.querySelector(".attachment-file-btn"));
    expect(opened).toEqual(["note"]);
    expect(images).toEqual([]);
  } finally {
    close();
  }
});

test("a bundle of only pictures opens the preview pane, not an enlargement", () => {
  const first = anAttachment({
    id: "a",
    original_filename: "one.png",
    workspace_relpath: "inbox/one.png",
  });
  const second = anAttachment({
    id: "b",
    original_filename: "two.jpg",
    workspace_relpath: "inbox/two.jpg",
  });
  const { host, close, opened, images } = mount([first, second]);
  try {
    click(host.querySelector(".attachment-bundle-btn"));
    expect(opened).toEqual(["a"]);
    expect(images).toEqual([]);
  } finally {
    close();
  }
});

test("a mixed bundle still opens the preview pane", () => {
  const picture = anAttachment({
    id: "pic",
    original_filename: "shot.png",
    workspace_relpath: "inbox/shot.png",
  });
  const note = anAttachment({
    id: "note",
    original_filename: "notes.md",
    workspace_relpath: "inbox/notes.md",
  });
  const { host, close, opened, images } = mount([picture, note]);
  try {
    click(host.querySelector(".attachment-bundle-btn"));
    expect(opened).toEqual(["pic"]);
    expect(images).toEqual([]);
  } finally {
    close();
  }
});

/**
 * A bundle shows one folder chip and no pictures. Its originals were downloaded anyway, and on a
 * phone they were the megabytes a tapped note waited behind.
 */
test("a bundle fetches none of its pictures", () => {
  const asked: string[] = [];
  const api = { getAttachmentBlob: (id: string) => { asked.push(id); return new Promise<Blob>(() => {}); } };
  const { close } = render(MessageAttachments, {
    attachments: [
      anAttachment({ id: "a", original_filename: "one.png", workspace_relpath: "inbox/one.png" }),
      anAttachment({ id: "b", original_filename: "two.png", workspace_relpath: "inbox/two.png" }),
    ],
    api: api as never,
    t,
    onPreview: () => {},
  });
  try {
    flushSync();
    expect(asked).toEqual([]);
  } finally {
    close();
  }
});

/** A chat's picture waits behind anything opened on purpose, and a chat left behind stops asking. */
test("a thumbnail is a background read that leaving the chat cancels", () => {
  const seen: Array<{ background?: boolean; signal?: AbortSignal; size?: string }> = [];
  const api = {
    getAttachmentBlob: (_id: string, _progress: unknown, options: { background?: boolean; signal?: AbortSignal; size?: string }) => {
      seen.push(options);
      return new Promise<Blob>(() => {});
    },
  };
  const { close } = render(MessageAttachments, {
    attachments: [anAttachment({ id: "pic", original_filename: "shot.png", workspace_relpath: "inbox/shot.png" })],
    api: api as never,
    t,
    onPreview: () => {},
  });
  flushSync();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.background).toBe(true);
  // A 36 px chip asks for the Mac's 256 px copy, not the original.
  expect(seen[0]!.size).toBe("thumb");
  expect(seen[0]!.signal?.aborted).toBe(false);
  close();
  expect(seen[0]!.signal?.aborted).toBe(true);
});

/** A chip says what kind of file it is, the way the file tree does, not one page icon for all. */
test("a chip's icon follows the file's extension", () => {
  const rows = ["master.mp4", "edl.json", "script.md"].map((name) =>
    anAttachment({ id: name, original_filename: name, workspace_relpath: `work/edit/${name}` }));
  const { host, close } = render(MessageAttachments, { attachments: rows, api: null, t, onPreview: () => {}, cards: true });
  try {
    const glyphs = [...host.querySelectorAll(".attachment-file-btn .file-glyph")];
    expect(glyphs).toHaveLength(3);
    // The video's camera, JSON's braces, Markdown's own mark: three different glyphs.
    expect(glyphs[0]!.querySelector("svg path")?.getAttribute("d")).toBe("m16 10 6-3v10l-6-3z");
    expect(glyphs[1]!.textContent?.trim()).toBe("{}");
    expect(glyphs[2]!.querySelector("svg path")?.getAttribute("d")).toBe("M3 5h18v14H3z");
  } finally {
    close();
  }
});

function mountCard(names: string[]) {
  const opened: string[] = [];
  const images: string[] = [];
  const files: string[] = [];
  const rows = names.map((name) => anAttachment({ id: name, original_filename: name, workspace_relpath: `work/job/${name}` }));
  const view = render(MessageAttachments, {
    attachments: rows,
    api: null,
    t,
    cards: true,
    onPreview: (att) => opened.push(att.id),
    onOpenImage: (att) => images.push(att.id),
    onOpenFile: (att) => files.push(att.id),
  });
  return { ...view, opened, images, files };
}

/** An app card shows its first five files and, after them, the entry a Bot's message ends with. */
test("an app card shows five chips and always the entry to every file", () => {
  const many = mountCard(["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"]);
  try {
    expect([...many.host.querySelectorAll(".attachment-file-btn .file-title")].map((el) => el.textContent)).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
    expect(many.host.querySelector(".attachment-bundle-btn")?.textContent).toContain("7 个文件");
  } finally {
    many.close();
  }
  const one = mountCard(["only.md"]);
  try {
    expect(one.host.querySelectorAll(".attachment-file-btn")).toHaveLength(1);
    expect(one.host.querySelector(".attachment-bundle-btn")?.textContent).toContain("1 个文件");
  } finally {
    one.close();
  }
});

test("on an app card a chip opens its file over the app, and the entry opens them beside the chat", () => {
  const { host, close, opened, images, files } = mountCard(["shot.png", "master.mp4", "notes.md"]);
  try {
    const chips = [...host.querySelectorAll(".attachment-file-btn")];
    click(chips[0]);
    click(chips[1]);
    click(chips[2]);
    expect(images).toEqual(["shot.png"]);
    expect(files).toEqual(["master.mp4", "notes.md"]);
    expect(opened).toEqual([]);
    // The entry opens on the first file, with every one in the tree beside it.
    click(host.querySelector(".attachment-bundle-btn"));
    expect(opened).toEqual(["shot.png"]);
  } finally {
    close();
  }
});
