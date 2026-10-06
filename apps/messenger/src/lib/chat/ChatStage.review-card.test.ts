import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aMessage, anAttachment, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { flushSync } from "svelte";
import ChatStage from "./ChatStage.svelte";

const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(); };

test("a card asking you to approve a hand-over shows its files, to open before you decide", () => {
  // 2026-10-03: the card named slogans.md only in its words; the file itself was not there to open.
  const session = aGroup();
  const path = "work/做一张咖啡店开业海报-a1r9/02-三句宣传语/slogans.md";
  const card = aMessage({ id: "card", session_id: session.id, kind: "system", author: "user",
    body: "做一张咖啡店开业海报 的任务 02「三句宣传语」交上来了（slogans.md），等你定。\n看过之后，放行或者退回。",
    attachments: [anAttachment({ message_id: "card", workspace_relpath: path, original_filename: "slogans.md" })],
    control: { kind: "review_item", submission_id: "sub-1", task_id: "plan-1", ticket_id: "ticket-2", requirement_ids: [], check_ids: [], offer: ["approve", "reject"] } as never });
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages: [card] }, { selectedId: session.id });
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    const row = host.querySelector('[data-message-id="card"]')!;
    expect(row.querySelector(".attachment-file-btn, .attachment-bundle-btn")).not.toBeNull();
    expect(row.textContent).toContain("slogans.md");
    // The buttons are still there, after the file.
    expect([...row.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(["放行", "退回"]));
  } finally { close(); }
});

test("a hand-over of a few files shows each of them on the card, not one folder to open first", () => {
  // 2026-10-04 real-model run: poster.html, poster.png and poster.svg showed as one chip 「work · 3 个文件」.
  const session = aGroup();
  const dir = "work/做一张咖啡店开业海报-cbp8/01-海报";
  const files = ["poster.html", "poster.png", "poster.svg"];
  const card = aMessage({ id: "card", session_id: session.id, kind: "system", author: "user",
    body: "做一张咖啡店开业海报 的任务 01「海报」交上来了（poster.html、poster.png、poster.svg）。没有审查者，也没有你确认过的检查替你把关，所以要你来定。\n看过之后，放行或者退回。",
    attachments: files.map((name, i) => anAttachment({ id: `att-${i}`, message_id: "card", workspace_relpath: `${dir}/${name}`, original_filename: name })),
    control: { kind: "review_item", submission_id: "sub-1", task_id: "plan-1", ticket_id: "ticket-1", requirement_ids: [], check_ids: [], offer: ["approve", "reject"] } as never });
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages: [card] }, { selectedId: session.id });
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    const row = host.querySelector('[data-message-id="card"]')!;
    expect(row.querySelectorAll(".attachment-file-btn")).toHaveLength(3);
    // And after them the entry a Bot's message ends with, to all of them beside the chat.
    expect(row.querySelector(".attachment-bundle-btn")?.textContent).toContain("3 个文件");
  } finally { close(); }
});

/**
 * 2026-10-06: a card naming four files listed them all, each with the same page icon, and a chip
 * opened the pane beside the chat where a picture's chip enlarged it over the app.
 */
test("a card's chip opens its file over the whole app; the entry after the chips opens the pane", async () => {
  const session = aGroup();
  const dir = "work/2026-10-05-全职猎人-s4vn";
  const files = ["master.mp4", "master_frames.jpg", "edl.json", "script.md", "board.jpg", "notes.md", "cut.srt"];
  const card = aMessage({ id: "card", session_id: session.id, kind: "system", author: "user",
    body: "全职猎人 的最后一件交上来了：任务 02「成片定版」。放行后整件事就交付了。\n看过之后，放行或者退回。",
    attachments: files.map((name, i) => anAttachment({ id: `att-${i}`, message_id: "card", workspace_relpath: `${dir}/${name}`, original_filename: name })),
    control: { kind: "review_item", submission_id: "sub-1", task_id: "plan-1", ticket_id: "ticket-2", requirement_ids: [], check_ids: [], offer: ["approve", "reject"] } as never });
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages: [card] }, { selectedId: session.id });
  runtime.client = {
    kind: "local",
    getAttachmentBlob: () => new Promise<Blob>(() => {}),
    getWorkspaceFileBlob: () => new Promise<Blob>(() => {}),
  } as never;
  const opened: string[] = [];
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session, onOpenProfile: () => {}, onOpenArtifact: (path: string) => opened.push(path), onCreateBot: () => {} });
  try {
    const row = host.querySelector('[data-message-id="card"]')!;
    const chips = [...row.querySelectorAll(".attachment-file-btn")];
    expect(chips.map((chip) => chip.querySelector(".file-title")?.textContent)).toEqual(files.slice(0, 5));
    expect(row.querySelector(".attachment-bundle-btn")?.textContent).toContain("7 个文件");

    click(chips[0]);
    await settle();
    const overlay = host.querySelector(".msg-file-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector(".msg-file-name")?.textContent).toBe("master.mp4");
    for (let i = 0; i < 20 && !overlay?.querySelector(".artifact-pane"); i++) await settle();
    expect(overlay?.querySelector(".artifact-pane")).not.toBeNull();
    // One file, however deep its folder: no tree beside it.
    expect(overlay?.querySelector(".artifact-tree, .artifact-picker")).toBeNull();
    expect(opened).toEqual([]);
    click(overlay?.querySelector(".msg-file-close"));
    await settle();
    expect(host.querySelector(".msg-file-overlay")).toBeNull();

    click(row.querySelector(".attachment-bundle-btn"));
    expect(opened).toEqual([`${dir}/master.mp4`]);
    expect(host.querySelector(".msg-file-overlay")).toBeNull();
  } finally { close(); }
});

/** A file the card only names on an `附件：` line has no row; the overlay reads it from the workspace. */
test("a chip for a file the card only names opens over the app from the workspace", async () => {
  const session = aGroup();
  const path = "work/job/02-稿子/draft.md";
  const card = aMessage({ id: "card", session_id: session.id, kind: "system", author: "user",
    body: `job 的任务 02「稿子」交上来了（draft.md）。\n附件：${path}\n看过之后，放行或者退回。`,
    attachments: [],
    control: { kind: "review_item", submission_id: "sub-1", task_id: "plan-1", ticket_id: "ticket-2", requirement_ids: [], check_ids: [], offer: ["approve", "reject"] } as never });
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages: [card] }, { selectedId: session.id });
  const workspaceReads: string[] = [];
  runtime.client = {
    kind: "local",
    getAttachmentBlob: () => { throw new Error("no attachment row to read"); },
    getWorkspaceFileBlob: (relpath: string) => { workspaceReads.push(relpath); return new Promise<Blob>(() => {}); },
  } as never;
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    click(host.querySelector('[data-message-id="card"] .attachment-file-btn'));
    await settle();
    const overlay = host.querySelector(".msg-file-overlay");
    for (let i = 0; i < 20 && !overlay?.querySelector(".artifact-pane"); i++) await settle();
    expect(overlay?.querySelector(".artifact-pane")).not.toBeNull();
    expect(overlay?.querySelector(".msg-file-name")?.textContent).toBe("draft.md");
    expect(overlay?.querySelector(".artifact-tree, .artifact-picker")).toBeNull();
    expect(workspaceReads).toContain(path);
  } finally { close(); }
});
