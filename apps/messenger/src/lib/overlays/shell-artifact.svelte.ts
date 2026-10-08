/**
 * The shell's artifact preview and workspace explorer: which file the preview shows, the ways to
 * open and close the two, and dragging the preview column's width.
 *
 * Lives beside `Shell.svelte` rather than inside it, the way `workbench/shell-workbench.svelte.ts`
 * and `danger-confirm.svelte.ts` do: the constructor takes getters for whatever it needs to read
 * from that Shell instance, and never snapshots them. The actions are arrow fields because the
 * shell hands them to components as callbacks.
 */
import type { Attachment, SessionSummary } from "@real-bot/protocol";
import { targetFor } from "../annotations/model.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import { sanitizePreviewPath } from "../session-url.ts";
import { findAttachmentById, findAttachmentByPath, siblingsForPath } from "./artifact-lookup.ts";
import { clampPreviewWidth, loadPreviewWidth, savePreviewWidth } from "./preview-width.ts";
import { trackPointerDrag } from "../pointer-drag.ts";

/** What the shell binds the workspace explorer and the preview to: both can ask before they close. */
type PaneHandle = {
  requestCloseFromParent: (afterClose?: () => void) => void;
  closeFind: () => boolean;
  blocksClose: () => boolean;
};

export type ShellArtifactDeps = {
  runtime: () => MessengerRuntime;
  selected: () => SessionSummary | null;
  wide: () => boolean;
  shellEl: () => HTMLElement | null;
  shellWidth: () => number;
  workspacePane: () => PaneHandle | null;
  previewPane: () => PaneHandle | null;
};

export class ShellArtifact {
  private readonly getRuntime: () => MessengerRuntime;
  private readonly getSelected: () => SessionSummary | null;
  private readonly getWide: () => boolean;
  private readonly getShellEl: () => HTMLElement | null;
  private readonly getShellWidth: () => number;
  private readonly getWorkspacePane: () => PaneHandle | null;
  private readonly getPreviewPane: () => PaneHandle | null;

  previewPreferred = $state(loadPreviewWidth());
  previewDragging = $state(false);
  previewWidth = $derived.by(() => clampPreviewWidth(this.previewPreferred, this.getShellWidth()));

  constructor(deps: ShellArtifactDeps) {
    this.getRuntime = deps.runtime;
    this.getSelected = deps.selected;
    this.getWide = deps.wide;
    this.getShellEl = deps.shellEl;
    this.getShellWidth = deps.shellWidth;
    this.getWorkspacePane = deps.workspacePane;
    this.getPreviewPane = deps.previewPane;
  }

  artifactPreview = $derived.by(() => {
    const runtime = this.getRuntime();
    const snapshot = runtime.snapshot;
    if (runtime.hosted) {
      const id = runtime.previewAttachmentId;
      if (!id) return null;
      const attachment = findAttachmentById(snapshot.messages, id) ?? runtime.previewSiblings?.find((s) => s.id === id);
      if (!attachment) return null;
      const owner = snapshot.messages.find((message) => message.id === attachment.message_id);
      return {
        relpath: attachment.workspace_relpath,
        attachment,
        siblings: siblingsForPath(snapshot.messages, attachment.workspace_relpath, attachment, undefined, runtime.previewSiblings),
        forceTree: runtime.forceArtifactTree,
        taskId: runtime.previewTaskId ?? null,
        // 挂到谁, the same way as below: the job this preview lists is where a delivery is looked for first.
        target: targetFor(snapshot.messages, attachment.workspace_relpath, owner, {
          sessionId: runtime.selectedId,
          taskId: runtime.previewTaskId ?? owner?.task_id ?? null,
        }),
      };
    }
    const relpath = runtime.previewRelpath;
    if (!relpath) return null;
    const attachment = findAttachmentByPath(snapshot.messages, relpath) ?? runtime.previewSiblings?.find((s) => s.workspace_relpath === relpath);
    const owner = runtime.previewMessageId
      ? snapshot.messages.find((message) => message.id === runtime.previewMessageId)
      : undefined;
    return {
      relpath,
      attachment: attachment ?? null,
      siblings: siblingsForPath(snapshot.messages, relpath, attachment, runtime.previewMessageId, runtime.previewSiblings),
      forceTree: runtime.forceArtifactTree,
      // A message's entry lists that message's files; only the flow chart names a job to list.
      taskId: runtime.previewTaskId ?? null,
      // 挂到谁：the message this was opened from when it handed this very path over — the tree
      // keeps that message while you walk to other files — else the latest Bot message in this
      // conversation that did, in this job first.
      target: targetFor(snapshot.messages, relpath, owner, {
        sessionId: runtime.selectedId,
        taskId: runtime.previewTaskId ?? owner?.task_id ?? null,
      }),
    };
  });

  openArtifactPath = (
    relpath: string,
    att?: Attachment,
    messageId?: string | null,
    forceTree = false,
    taskId?: string | null,
    siblings?: Attachment[] | null,
    sessionId?: string | null,
  ): void => {
    const runtime = this.getRuntime();
    const snapshot = runtime.snapshot;
    const selected = this.getSelected();
    if (runtime.paneOpener) {
      const sourceMessageId = messageId ?? att?.message_id ?? null;
      const owner = snapshot.messages.find((row) => row.id === sourceMessageId);
      runtime.paneOpener({
        kind: "preview",
        // Whose preview this is decides which pane turns: every conversation has one.
        sessionId: sessionId ?? owner?.session_id ?? selected?.id ?? null,
        relpath: sanitizePreviewPath(relpath),
        attachmentId: att?.id ?? null,
        messageId: sourceMessageId,
        taskId: taskId ?? null,
        forceTree,
        siblings: siblings ?? siblingsForPath(snapshot.messages, relpath, att, sourceMessageId, runtime.previewSiblings),
      });
      return;
    }
    if (runtime.hosted) {
      // A remote URL never carries a file path, so the preview goes by attachment id.
      runtime.previewRelpath = null;
      runtime.previewAttachmentId = att?.id ?? findAttachmentByPath(snapshot.messages, relpath)?.id ?? null;
      runtime.previewMessageId = messageId ?? att?.message_id ?? null;
      runtime.forceArtifactTree = forceTree;
      runtime.previewTaskId = taskId ?? null;
      runtime.previewSiblings = siblings ?? null;
      return;
    }
    runtime.previewAttachmentId = null;
    runtime.previewRelpath = sanitizePreviewPath(relpath);
    runtime.previewMessageId = messageId ?? att?.message_id ?? null;
    runtime.forceArtifactTree = forceTree;
    runtime.previewTaskId = taskId ?? null;
    runtime.previewSiblings = siblings ?? null;
  };

  closeArtifactPreview = (): void => {
    const runtime = this.getRuntime();
    runtime.previewRelpath = null;
    runtime.previewAttachmentId = null;
    runtime.previewMessageId = null;
    runtime.forceArtifactTree = false;
    runtime.previewTaskId = null;
    runtime.previewSiblings = null;
    runtime.annotationFocusId = null;
  };

  toggleWorkspaceExplorer = (): void => {
    const runtime = this.getRuntime();
    const snapshot = runtime.snapshot;
    if (!snapshot.settings.workspace_path) return;
    if (runtime.workspaceOpen) {
      this.getWorkspacePane()?.requestCloseFromParent();
      return;
    }
    runtime.openWorkspace(this.artifactPreview?.relpath ?? runtime.workspaceSelected);
    if (!this.artifactPreview?.relpath) void this.selectCurrentWorkDir();
  };

  /**
   * Opening the explorer cold lands on this session's current work dir rather than wherever it
   * was left days ago. Only the dir is known server-side, so it is a pull; a failure just leaves
   * the previous selection, which is what the explorer did before.
   */
  private async selectCurrentWorkDir(): Promise<void> {
    const runtime = this.getRuntime();
    const snapshot = runtime.snapshot;
    const client = runtime.client;
    const taskId = [...snapshot.messages].reverse().find((message) => message.task_id)?.task_id;
    if (!client || !taskId) return;
    try {
      const task = await client.taskArtifacts(taskId);
      if (runtime.workspaceOpen) runtime.workspaceSelected = task.dir;
    } catch {
      // the explorer keeps whatever it had
    }
  }

  closeWorkspaceExplorer = (): void => {
    this.getRuntime().closeWorkspace();
  };

  openWorkspaceFile = (path: string): void => {
    this.getRuntime().workspaceSelected = sanitizePreviewPath(path) ?? "";
  };

  startPreviewResize = (ev: PointerEvent): void => {
    if (!this.artifactPreview) return;
    ev.preventDefault();
    this.previewDragging = true;
    const originX = ev.clientX;
    const originW = this.previewWidth;
    const onMove = (move: PointerEvent) => {
      const shellW = this.getShellEl()?.clientWidth ?? 1200;
      this.previewPreferred = clampPreviewWidth(originW - (move.clientX - originX), shellW);
    };
    const onUp = () => {
      this.previewDragging = false;
      savePreviewWidth(this.previewPreferred);
    };
    trackPointerDrag(window, { move: onMove, end: onUp, cancel: false });
  };

  guardNotificationNavigation = (perform: () => void): void => {
    const runtime = this.getRuntime();
    const previewPane = this.getPreviewPane();
    if (this.artifactPreview && previewPane?.requestCloseFromParent) {
      previewPane.requestCloseFromParent(() => {
        this.closeArtifactPreview();
        const workspacePane = this.getWorkspacePane();
        if (runtime.workspaceOpen && workspacePane?.requestCloseFromParent) {
          workspacePane.requestCloseFromParent(() => {
            this.closeWorkspaceExplorer();
            perform();
          });
          return;
        }
        perform();
      });
      return;
    }
    const workspacePane = this.getWorkspacePane();
    if (runtime.workspaceOpen && workspacePane?.requestCloseFromParent) {
      workspacePane.requestCloseFromParent(() => {
        this.closeWorkspaceExplorer();
        perform();
      });
      return;
    }
    perform();
  };

  openRoutinesFromUi = (): void => {
    const runtime = this.getRuntime();
    const workspacePane = this.getWorkspacePane();
    const open = () => runtime.openRoutines();
    if (runtime.workspaceOpen && workspacePane) workspacePane.requestCloseFromParent(open);
    else open();
  };

  openSpendFromUi = (): void => {
    const runtime = this.getRuntime();
    const workspacePane = this.getWorkspacePane();
    const open = () => runtime.openSpend();
    if (runtime.workspaceOpen && workspacePane) workspacePane.requestCloseFromParent(open);
    else open();
  };

  /**
   * A terminal asked for from a file tree opens in the workbench or, on a phone, as the terminal
   * page. A tree drawn over the screen would hide it either way, so that one closes first,
   * asking about an unsaved edit the way leaving it any other way does.
   */
  openTerminalFromWorkspace = (dir: string): void => {
    const runtime = this.getRuntime();
    const workspacePane = this.getWorkspacePane();
    const open = () => void runtime.openTerminalAt(dir);
    if (runtime.workspaceOpen && workspacePane) workspacePane.requestCloseFromParent(open);
    else open();
  };

  openTerminalFromPreview = (dir: string): void => {
    const runtime = this.getRuntime();
    const previewPane = this.getPreviewPane();
    const open = () => void runtime.openTerminalAt(dir);
    if (!this.getWide() && previewPane) previewPane.requestCloseFromParent(open);
    else open();
  };
}
