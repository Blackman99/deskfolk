import { expect, test } from "bun:test";
import type { Attachment, Message } from "@real-bot/protocol";
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

test("on the phone a link no attachment backs opens too, a folder elsewhere on the Mac among them", () => {
  const { runtime, shell } = phone([message({ body: "克隆在 [~/my-projects/curio](~/my-projects/curio)" })]);
  shell().openArtifactPath("~/my-projects/curio", undefined, "m1");
  expect(runtime.previewRelpath).toBeNull();
  expect(runtime.previewAttachmentId).toBe("virtual-preview-~/my-projects/curio");
  expect(shell().artifactPreview).toMatchObject({ relpath: "~/my-projects/curio", attachment: { id: "virtual-preview-~/my-projects/curio" } });

  // An entry opened from that folder's page takes the stand-in's place instead of piling up beside it.
  shell().openArtifactPath("/Users/me/my-projects/curio/demos.json", undefined, "m1", false, null, runtime.previewSiblings);
  expect(runtime.previewSiblings?.map((row) => row.workspace_relpath)).toEqual(["/Users/me/my-projects/curio/demos.json"]);
  expect(shell().artifactPreview?.relpath).toBe("/Users/me/my-projects/curio/demos.json");
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
