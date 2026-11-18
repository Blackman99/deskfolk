import "../../platform/install";
import { expect, test } from "nsh/test";
import type { Attachment, WorkspaceImportResult } from "@real-bot/protocol";
import { state } from "../../lib/reactive.ts";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { settle } from "../test-async.ts";
import { toasts } from "../toast.svelte.ts";
import { ArtifactTreeSource } from "./artifact-tree-source.svelte.ts";
import type { ArtifactTreeNode } from "./artifact-tree.ts";

const t = copyFor("zh");

const row = (id: string, path: string): Attachment =>
  ({ id, message_id: "m1", workspace_relpath: path, original_filename: path.split("/").pop(), mime: "text/plain", size: 1 }) as unknown as Attachment;

/** A preview of what a message hands over (not the workspace's tree), on a client that answers as `answer` says. */
function cited(answer: (dir: string, sources: string[]) => Promise<WorkspaceImportResult>) {
  const siblings = state<Attachment[]>([row("a1", "inbox/notes.md"), row("a2", "inbox/sum.ts")]);
  const asked: Array<{ dir: string; sources: string[] }> = [];
  const api = {
    importIntoWorkspace: (dir: string, sources: string[]) => {
      asked.push({ dir, sources });
      return answer(dir, sources);
    },
    // Each copy is a file: the probe asks, and a file answers 422 as the Mac does.
    workspaceTree: () => Promise.reject(new ApiError(422, "invalid_args", "path is not a directory")),
  } as unknown as MessengerApi;
  const tree = new ArtifactTreeSource({
    api: () => api,
    mode: () => "cited",
    taskId: () => null,
    siblings: () => siblings.get(),
    workspacePath: () => "/ws",
    relpath: () => "inbox/notes.md",
    dirty: () => false,
    t: () => t,
    onOpenTerminal: () => undefined,
    showGone: () => {},
    projectDir: () => null,
  });
  return { tree, asked, siblings };
}

const paths = (nodes: readonly ArtifactTreeNode[]): string[] =>
  nodes.flatMap((node) => [`${node.path}${node.fresh ? "*" : ""}`, ...paths(node.children ?? [])]);

test("copies dropped on a message's files are rows of that tree, marked, until another message's files show", async () => {
  const { tree, asked, siblings } = cited(async (_dir, sources) => ({
    imported: sources.map((source) => ({ source, name: source.split("/").pop()! })),
    failed: [],
  }));
  await tree.importDropped("inbox", ["/Users/me/Desktop/brief.pdf"]);
  await tree.importDropped(null, ["/Users/me/Desktop/photo.png"]);
  await settle();
  // A folder's row is that folder; the space around the rows is the workspace itself.
  expect(asked.map((call) => call.dir)).toEqual(["inbox", ""]);
  expect(paths(tree.tree)).toEqual(["inbox", "inbox/brief.pdf*", "inbox/notes.md", "inbox/sum.ts", "photo.png*"]);
  expect(toasts.current?.text).toBe(t.stream.workspaceImported(["photo.png"], ""));
  // Another message in the same pane: its own files only.
  siblings.set([row("b1", "out/cut.mp4")]);
  await settle();
  expect(paths(tree.tree)).toEqual(["out", "out/cut.mp4"]);
});

test("a drop the runtime refuses is said in words: a runtime too old to copy, a folder outside where it writes", async () => {
  let refusal: Error = new ApiError(404, "not_found", "unknown route");
  const { tree } = cited(() => Promise.reject(refusal));
  await tree.importDropped("inbox", ["/Users/me/Desktop/brief.pdf"]);
  expect(toasts.current?.text).toBe(t.stream.workspaceImportNeedsRestart);
  refusal = new ApiError(422, "invalid_args", "path is outside the workspace and every project");
  await tree.importDropped("~/Downloads", ["/Users/me/Desktop/brief.pdf"]);
  expect(toasts.current?.text).toBe(t.stream.workspaceImportOutside);
  refusal = new ApiError(503, "request_unknown", "result unknown");
  await tree.importDropped("inbox", ["/Users/me/Desktop/brief.pdf"]);
  expect(toasts.current?.text).toBe(t.stream.workspaceImportRefused("result unknown"));
  expect(tree.importedPaths).toEqual([]);
});
