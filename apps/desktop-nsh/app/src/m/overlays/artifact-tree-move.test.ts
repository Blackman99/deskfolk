import "../../platform/install";
import { expect, test } from "nsh/test";
import type { Attachment, WorkspaceMoveResult } from "@real-bot/protocol";
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

/** A Bot's panel: the files a message hands over, on a client that moves as `answer` says; the file on screen and its edits as given. */
function panel(opts: { dirty?: boolean; answer?: (dir: string, sources: string[]) => Promise<WorkspaceMoveResult> } = {}) {
  const asked: Array<{ dir: string; sources: string[] }> = [];
  const followed: Array<[string, string]> = [];
  const api = {
    moveInWorkspace: (dir: string, sources: string[]) => {
      asked.push({ dir, sources });
      return opts.answer ? opts.answer(dir, sources) : Promise.resolve({ moved: sources.map((source) => ({ source, name: source.split("/").pop()! })), failed: [] });
    },
    workspaceTree: () => Promise.reject(new ApiError(422, "invalid_args", "path is not a directory")),
  } as unknown as MessengerApi;
  const tree = new ArtifactTreeSource({
    api: () => api,
    mode: () => "cited",
    taskId: () => null,
    siblings: () => [row("a1", "inbox/notes.md"), row("a2", "inbox/sum.ts"), row("a3", "docs/plan.md")],
    workspacePath: () => "/ws",
    relpath: () => "inbox/notes.md",
    dirty: () => opts.dirty ?? false,
    t: () => t,
    onOpenTerminal: () => undefined,
    showGone: () => {},
    followMove: (from, to) => followed.push([from, to]),
    projectDir: () => null,
  });
  return { tree, asked, followed };
}

const paths = (nodes: readonly ArtifactTreeNode[]): string[] =>
  nodes.flatMap((node) => [`${node.path}${node.fresh ? "*" : ""}`, ...paths(node.children ?? [])]);

test("a row moved in a message's tree shows where it went, the preview goes with it, and Undo puts it back", async () => {
  const { tree, asked, followed } = panel();
  await tree.moveItems("docs", [{ path: "inbox/notes.md", isDir: false }]);
  await settle();
  expect(asked).toEqual([{ dir: "docs", sources: ["inbox/notes.md"] }]);
  expect(paths(tree.tree)).toEqual(["docs", "docs/notes.md*", "docs/plan.md", "inbox", "inbox/sum.ts"]);
  expect(followed).toEqual([["inbox/notes.md", "docs/notes.md"]]);
  expect(toasts.current?.text).toBe(t.stream.workspaceMoved(["notes.md"], "docs"));
  expect(toasts.current?.action?.label).toBe(t.stream.workspaceMoveUndo);

  toasts.current!.action!.run();
  await settle();
  await settle();
  expect(asked[1]).toEqual({ dir: "inbox", sources: ["docs/notes.md"] });
  expect(paths(tree.tree)).toEqual(["docs", "docs/plan.md", "inbox", "inbox/notes.md", "inbox/sum.ts"]);
  // The move back offers no undo of its own.
  expect(toasts.current?.action ?? null).toBeNull();
});

test("a folder picked with a row inside it goes once: what is inside goes with it", async () => {
  const { tree, asked } = panel();
  await tree.moveItems("docs", [{ path: "inbox", isDir: true }, { path: "inbox/sum.ts", isDir: false }]);
  expect(asked).toEqual([{ dir: "docs", sources: ["inbox"] }]);
});

test("the file on screen with edits not saved is not moved, and nothing else in the drag is either", async () => {
  const { tree, asked } = panel({ dirty: true });
  await tree.moveItems("docs", [{ path: "inbox/sum.ts", isDir: false }, { path: "inbox/notes.md", isDir: false }]);
  expect(asked).toEqual([]);
  expect(toasts.current?.text).toBe(t.stream.workspaceMoveUnsaved);
});

test("what the runtime would not move stays, said in words", async () => {
  const { tree } = panel({
    answer: async (_dir, sources) => ({ moved: [], failed: sources.map((source) => ({ source, code: "exists" as const, message: "taken" })) }),
  });
  await tree.moveItems("docs", [{ path: "inbox/sum.ts", isDir: false }]);
  await settle();
  expect(paths(tree.tree)).toEqual(["docs", "docs/plan.md", "inbox", "inbox/notes.md", "inbox/sum.ts"]);
  expect(toasts.current?.text).toBe(t.stream.workspaceMoveFailed([{ name: "sum.ts", code: "exists", message: "taken" }]));
  expect(toasts.current?.action ?? null).toBeNull();
});
