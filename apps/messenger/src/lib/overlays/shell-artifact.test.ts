import { expect, test } from "bun:test";
import type { Attachment, Message } from "@real-bot/protocol";
import type { PaneContent } from "../workbench/pane-content.ts";
import { previewContext } from "../workbench/preview-context.ts";
import { buildCitedPathTree } from "./artifact-tree.ts";
import { ShellArtifact } from "./shell-artifact.svelte.ts";

type HostedRuntime = {
  hosted: true;
  paneOpener: null;
  snapshot: { messages: Message[] };
  selectedId: string;
  previewRelpath: string | null;
  previewAttachmentId: string | null;
  previewMessageId: string | null;
  forceArtifactTree: boolean;
  previewTaskId: string | null;
  previewSiblings: Attachment[] | null;
};

const message = (over: Partial<Message>): Message => ({
  id: "m1", session_id: "s1", turn_id: null, parent_id: null, kind: "bot", author: "bot-1", body: "",
  attachments: [], created_at: "2026-10-15T08:00:00.000Z", ...over,
}) as Message;

/** The phone's shell: no panes, and a preview that goes by attachment id. */
function phone(messages: Message[]) {
  const runtime: HostedRuntime = {
    hosted: true, paneOpener: null, snapshot: { messages }, selectedId: "s1",
    previewRelpath: null, previewAttachmentId: null, previewMessageId: null,
    forceArtifactTree: false, previewTaskId: null, previewSiblings: null,
  };
  const shell = () => new ShellArtifact({
    runtime: () => runtime as never, selected: () => null, wide: () => false,
    shellEl: () => null, shellWidth: () => 390, workspacePane: () => null, previewPane: () => null,
  });
  return { runtime, shell };
}

/** The tree's top rows for what a preview lists, as `ArtifactTreeSource` builds them before any listing. */
const roots = (rows: readonly Attachment[] | null | undefined) =>
  buildCitedPathTree((rows ?? []).map((row) => row.workspace_relpath)).map((node) => `${node.name}:${node.kind}`);

test("on the phone a link no attachment backs opens too, a folder elsewhere on the Mac among them", () => {
  const { runtime, shell } = phone([message({ body: "克隆在 [~/my-projects/curio](~/my-projects/curio)" })]);
  shell().openArtifactPath("~/my-projects/curio", undefined, "m1");
  expect(runtime.previewRelpath).toBeNull();
  expect(runtime.previewAttachmentId).toBe("virtual-m1-~/my-projects/curio");
  expect(shell().artifactPreview).toMatchObject({ relpath: "~/my-projects/curio", attachment: { id: "virtual-m1-~/my-projects/curio" } });

  // Entries opened from that folder (the tree hands over a row with no id) sit inside it, and only
  // the stand-in for the one on screen changes: the folder stays the tree's root.
  for (const entry of ["~/my-projects/curio/lumen-landing", "~/my-projects/curio/demos.json"]) {
    shell().openArtifactPath(entry, { workspace_relpath: entry } as Attachment, "m1", false, null, runtime.previewSiblings);
    expect(runtime.previewSiblings?.map((row) => row.workspace_relpath)).toEqual(["~/my-projects/curio", entry]);
    expect(shell().artifactPreview?.relpath).toBe(entry);
    expect(roots(runtime.previewSiblings)).toEqual(["curio:dir"]);
  }

  // Pressing the file on screen again leaves it on screen.
  const standIn = runtime.previewSiblings!.find((row) => row.id.startsWith("virtual-preview-"))!;
  shell().openArtifactPath(standIn.workspace_relpath, standIn, "m1", false, null, runtime.previewSiblings);
  expect(shell().artifactPreview?.relpath).toBe("~/my-projects/curio/demos.json");
});

test("in the workbench a tab opened from a link keeps that folder while you walk inside it", () => {
  const messages = [message({ body: "克隆在 [~/my-projects/curio](~/my-projects/curio)" })];
  const opened: PaneContent[] = [];
  const runtime = {
    hosted: false, paneOpener: (content: PaneContent) => { opened.push(content); },
    snapshot: { messages }, selectedId: "s1", previewSiblings: null,
  };
  new ShellArtifact({
    runtime: () => runtime as never, selected: () => null, wide: () => true,
    shellEl: () => null, shellWidth: () => 1440, workspacePane: () => null, previewPane: () => null,
  }).openArtifactPath("~/my-projects/curio/", undefined, "m1");
  const first = opened[0];
  if (first?.kind !== "preview") throw new Error("preview expected");
  let tab = first;
  expect(tab.relpath).toBe("~/my-projects/curio");
  expect(tab.siblings?.map((row) => row.workspace_relpath)).toEqual(["~/my-projects/curio"]);

  // What a click in the tree writes back (`selectPreview`): the file on screen, and the rows the tab keeps.
  for (const next of ["~/my-projects/curio/lumen-landing", "~/my-projects/curio/lumen-landing/index.html"]) {
    tab = { ...tab, relpath: next, attachmentId: null, siblings: previewContext(tab, messages).handedOver };
    const context = previewContext(tab, messages);
    expect(context.handedOver.map((row) => row.workspace_relpath)).toEqual(["~/my-projects/curio"]);
    expect(roots(context.siblings)).toEqual(["curio:dir"]);
  }
});

test("a link opened in a job's tree is not added as one this message handed over", () => {
  const opened: PaneContent[] = [];
  const att = { id: "att-1", message_id: "m1", workspace_relpath: "out/a.md", original_filename: "a.md", created_at: "" } as Attachment;
  const siblingsOf = (content: PaneContent | undefined) => (content?.kind === "preview" ? content.siblings : undefined);
  const runtime = {
    hosted: false, paneOpener: (content: PaneContent) => { opened.push(content); },
    snapshot: { messages: [message({ attachments: [att] })] }, selectedId: "s1", previewSiblings: null,
  };
  const shell = new ShellArtifact({
    runtime: () => runtime as never, selected: () => null, wide: () => true,
    shellEl: () => null, shellWidth: () => 1440, workspacePane: () => null, previewPane: () => null,
  });
  shell.openArtifactPath("out/b.md", undefined, "m1", true, "job-1");
  expect(siblingsOf(opened[0])?.map((row) => row.workspace_relpath)).toEqual(["out/a.md"]);
  // A handed-over file opened by its path adds nothing either.
  shell.openArtifactPath("out/a.md", undefined, "m1");
  expect(siblingsOf(opened[1])).toEqual([att]);
});

test("on the phone a handed-over file still opens by its own attachment", () => {
  const att = { id: "att-1", message_id: "m1", workspace_relpath: "out/a.md", original_filename: "a.md", created_at: "" } as Attachment;
  const { runtime, shell } = phone([message({ attachments: [att] })]);
  shell().openArtifactPath("out/a.md", undefined, "m1");
  expect(runtime.previewAttachmentId).toBe("att-1");
  expect(runtime.previewSiblings).toBeNull();
  // A path that climbs out is never stood in for.
  shell().openArtifactPath("../secret.md", undefined, "m1");
  expect(runtime.previewAttachmentId).toBeNull();
});
