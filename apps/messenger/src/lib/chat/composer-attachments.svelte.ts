import { isImageFileName } from "./attachments.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import type { SessionView, StagedAttachment, StagedWorkspacePath } from "../session-view.svelte.ts";
import { workspaceDrag, type WorkspaceDragItem } from "../workspace-drag.svelte.ts";
import type { SessionSummary } from "@real-bot/protocol";

/** What the staging of files reads from the composer around it; each is read when needed, so it stays live. */
export type ComposerAttachmentsDeps = {
  runtime: () => MessengerRuntime;
  selected: () => SessionSummary | null;
  view: () => SessionView | null;
  lockedComposer: () => boolean;
  connected: () => boolean;
  fileDrop: () => boolean;
  editorEl: () => HTMLDivElement | null;
};

/** Files and workspace paths staged on the conversation, from the picker, a paste, a drop or the file tree. */
export class ComposerAttachments {
  private readonly deps: ComposerAttachmentsDeps;

  constructor(deps: ComposerAttachmentsDeps) {
    this.deps = deps;
  }

  /** Staged on the conversation, so they wait there when you look at another one. */
  pendingAttachments = $derived.by(() => this.deps.view()?.stagedAttachments ?? []);
  stageAttachments = (next: StagedAttachment[]): void => {
    const view = this.deps.view();
    if (view) view.stagedAttachments = next;
  };
  /** Dragged in from the file tree, and staged the same way. */
  pendingPaths = $derived.by(() => this.deps.view()?.stagedPaths ?? []);

  fileInputEl = $state<HTMLInputElement | null>(null);

  addFiles = (files: FileList | File[]): void => {
    const next: StagedAttachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const isImage = file.type.startsWith("image/");
      let previewUrl: string | null = null;
      if (isImage) {
        previewUrl = URL.createObjectURL(file);
      }
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      let name = file.name;
      if (!name || name === "image.png" || name === "blob") {
        name = `image-${Date.now().toString().slice(-4)}.png`;
      }
      next.push({ id, file, name, size: file.size, isImage, previewUrl });
    }
    this.stageAttachments([...this.pendingAttachments, ...next]);
  };

  removePendingAttachment = (id: string): void => {
    const target = this.pendingAttachments.find((a) => a.id === id);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
    }
    this.stageAttachments(this.pendingAttachments.filter((a) => a.id !== id));
  };

  onFileInputChange = (ev: Event): void => {
    const input = ev.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.addFiles(input.files);
      input.value = "";
    }
  };

  openFilePicker = (): void => {
    if (this.deps.lockedComposer() || !this.deps.connected() || !this.deps.selected() || this.deps.view()?.sending) return;
    this.fileInputEl?.click();
  };

  /**
   * Whether a drag out of the file tree lands here now. The file conversation takes files from
   * elsewhere, not what is already in the workspace; a locked or sending composer takes nothing.
   */
  takesWorkspaceItems = (): boolean => {
    const view = this.deps.view();
    return Boolean(this.deps.selected() && view) && !this.deps.fileDrop() && !this.deps.lockedComposer() && this.deps.connected() && !view?.sending;
  };

  cardEl = $state<HTMLElement | null>(null);
  treeDrag = $derived(workspaceDrag.current);
  /** A drag from the tree is on its way and would land here: the card says it can take it. */
  dropReady = $derived.by(() => Boolean(this.treeDrag) && this.takesWorkspaceItems());
  dropOver = $derived.by(() => Boolean(this.treeDrag && this.cardEl && this.treeDrag.over === this.cardEl));

  stageWorkspaceItems = (items: WorkspaceDragItem[]): void => {
    const target = this.deps.view();
    if (!target) return;
    const staged = new Set(target.stagedPaths.map((row) => row.path));
    const next: StagedWorkspacePath[] = [];
    for (const item of items) {
      if (staged.has(item.path)) continue;
      staged.add(item.path);
      const name = item.path.split("/").pop() || item.path;
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      next.push({ id, path: item.path, name, isDir: item.isDir, isImage: !item.isDir && isImageFileName(name), previewUrl: null });
    }
    if (next.length === 0) return;
    target.stagedPaths = [...target.stagedPaths, ...next];
    for (const row of next) if (row.isImage) void this.loadPathPreview(target, row.id, row.path);
    this.deps.editorEl()?.focus();
  };

  /** The Mac's 256 px copy of a picture, as for one a message names by its path. */
  loadPathPreview = async (target: SessionView, id: string, path: string): Promise<void> => {
    const client = this.deps.runtime().client;
    if (!client) return;
    let url: string;
    try {
      url = URL.createObjectURL(await client.getWorkspaceFileBlob(path, undefined, { background: true, size: "thumb" }));
    } catch {
      return;
    }
    // Taken back or sent while it loaded.
    if (!target.stagedPaths.some((row) => row.id === id)) {
      URL.revokeObjectURL(url);
      return;
    }
    target.stagedPaths = target.stagedPaths.map((row) => (row.id === id ? { ...row, previewUrl: url } : row));
  };

  removePendingPath = (id: string): void => {
    const view = this.deps.view();
    if (!view) return;
    const target = view.stagedPaths.find((row) => row.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    view.stagedPaths = view.stagedPaths.filter((row) => row.id !== id);
  };

  onFileDragOver = (ev: DragEvent): void => {
    if (!this.deps.fileDrop() || this.deps.lockedComposer() || !this.deps.connected() || this.deps.view()?.sending) return;
    if (!ev.dataTransfer?.types.includes("Files")) return;
    ev.preventDefault();
  };

  onFileDrop = (ev: DragEvent): void => {
    if (!this.deps.fileDrop() || this.deps.lockedComposer() || !this.deps.connected() || this.deps.view()?.sending) return;
    const dropped = ev.dataTransfer?.files;
    if (!dropped || dropped.length === 0) return;
    ev.preventDefault();
    this.addFiles(dropped);
  };
}
