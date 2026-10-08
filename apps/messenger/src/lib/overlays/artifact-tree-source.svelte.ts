import { untrack } from "svelte";
import type { Attachment, TaskArtifacts } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { absWorkspacePath, terminalDirFor } from "./artifacts.ts";
import {
  buildCitedPathTree,
  buildTaskArtifactTree,
  isUnderAny,
  mergeWorkspaceChildren,
  removeTreePaths,
  workspaceEntriesToNodes,
  type ArtifactTreeNode,
} from "./artifact-tree.ts";

/** What the pane hands the tree: each is read where it was read before, so the effects track the same signals. */
export interface ArtifactTreeSourceHost {
  api: () => MessengerApi | null;
  mode: () => "cited" | "workspace";
  taskId: () => string | null;
  siblings: () => Attachment[];
  workspacePath: () => string | null;
  relpath: () => string;
  dirty: () => boolean;
  t: () => Copy;
  onOpenTerminal: () => ((dir: string) => void) | undefined;
  /** The file on screen went to the Trash. */
  showGone: () => void;
}

/** The file tree: what the message cites or the job lists, or the workspace read folder by folder, and the right-click menu and Trash confirm that act on it. */
export class ArtifactTreeSource {
  readonly #h: ArtifactTreeSourceHost;

  /** The file-tree row that was right-clicked, the rows its menu acts on, and where it hangs. */
  treeMenu = $state<{ node: ArtifactTreeNode; targets: ArtifactTreeNode[]; x: number; y: number } | null>(null);
  /** Rows waiting on the Move to Trash confirm; `failed` is the Mac's reason once a try left some behind. */
  trashAsk = $state<{ nodes: ArtifactTreeNode[]; busy: boolean; failed: string | null } | null>(null);
  /** Trashed from this pane. The message's own rows still name those files until the Mac says they are gone. */
  trashedPaths = $state<string[]>([]);
  taskArtifacts = $state<TaskArtifacts | null>(null);
  taskTreeLoading = $state(false);
  taskTreeFailed = $state(false);
  taskTreeRetry = $state(0);
  /** The job whose files are listed, so the same job is never pulled twice. */
  loadedTaskKey: string | null = null;
  loadedTaskClient: MessengerApi | null = null;
  taskTreeAbort: AbortController | null = null;

  /** What this entry handed over, less what the Mac already knows is deleted: the tree is for opening files. */
  ownPaths = $derived.by(() =>
    this.#h.siblings()
      .filter((row) => row.exists !== false && !isUnderAny(row.workspace_relpath, this.trashedPaths))
      .map((row) => row.workspace_relpath)
  );
  /**
   * Opened from a message, the files that message names and nothing else. Opened from the flow
   * chart, which names a job, the job's files anchored at its work dir with this step's own
   * marked — falling back to this step's alone when the pull failed.
   */
  citedTree = $derived(
    this.taskArtifacts
      ? buildTaskArtifactTree(
          this.taskArtifacts.dir,
          this.taskArtifacts.items.map((row) => row.path),
          this.ownPaths
        )
      : buildCitedPathTree(this.ownPaths)
  );
  workspaceTree = $state<ArtifactTreeNode[]>([]);
  loadedDirs = $state(new Set<string>());
  loadingDirs = $state(new Set<string>());
  failedDirs = $state(new Set<string>());
  treeGeneration = $state(0);
  truncatedHint = $state(false);
  tree = $derived.by(() => this.#h.mode() === "workspace" ? this.workspaceTree : this.citedTree);
  /** Which workspace root is listed; `null` when this pane is not the explorer. */
  loadedWorkspaceKey: string | null | undefined = undefined;
  loadedWorkspaceClient: MessengerApi | null = null;

  /** Where the rows the menu acts on sit on the machine, one a line; unknown until the workspace root is. */
  treeMenuAbsPaths = $derived.by(() => {
    if (!this.treeMenu || !this.#h.workspacePath()) return null;
    const root = this.#h.workspacePath()!;
    const paths = this.treeMenu.targets.map((node) => absWorkspacePath(root, node.path));
    return paths.every((path) => path !== null) ? paths.join("\n") : null;
  });
  /** Anything that reaches the Mac can move files to its Trash; a stand-in client without the call cannot. */
  canTrash = $derived.by(() => typeof this.#h.api()?.trashWorkspacePaths === "function");

  trashCopy = $derived.by(() => {
    if (!this.trashAsk) return null;
    const { nodes, failed } = this.trashAsk;
    const count = nodes.length;
    const t = this.#h.t();
    return {
      title: t.stream.artifactTrashTitle(nodes[0]?.name ?? "", count),
      body: failed
        ? t.stream.artifactTrashFailed(count, failed)
        : t.stream.artifactTrashBody(
            nodes.map((node) => node.name),
            count,
            nodes.some((node) => node.kind === "dir"),
            this.#h.dirty() && isUnderAny(this.#h.relpath(), nodes.map((node) => node.path)),
          ),
      confirm: failed ? t.stream.artifactTrashRetry : t.stream.artifactTrash,
      cancel: t.sidebar.cancel,
    };
  });
  /** The folder a terminal opened from that row starts in: the row itself, or a file's own folder. */
  treeMenuTerminalDir = $derived.by(() =>
    this.treeMenu && this.#h.workspacePath() && this.#h.onOpenTerminal() ? terminalDirFor(this.#h.workspacePath()!, this.treeMenu.node.path, this.treeMenu.node.kind) : null
  );

  constructor(host: ArtifactTreeSourceHost) {
    this.#h = host;

    /**
     * The props of this pane come off one object the shell derives, so every snapshot re-runs this
     * — and clearing the list to pull the same job again is the tree blinking. Only a different
     * job, or the retry button, is a reason to let go of what is listed.
     */
    $effect(() => {
      const id = this.#h.taskId();
      const client = this.#h.api();
      const retry = this.taskTreeRetry;
      const key = id && client && this.#h.mode() !== "workspace" ? `${retry}:${id}` : null;
      // A reconnect hands over a new client, and what it listed belongs to the old one.
      if (key === this.loadedTaskKey && client === this.loadedTaskClient) return;
      this.loadedTaskKey = key;
      this.loadedTaskClient = client;
      this.taskTreeAbort?.abort();
      this.taskTreeAbort = null;
      this.taskArtifacts = null;
      this.taskTreeFailed = false;
      this.taskTreeLoading = false;
      if (!key || !id || !client) return;
      const controller = new AbortController();
      this.taskTreeAbort = controller;
      this.taskTreeLoading = true;
      client.taskArtifacts(id, controller.signal)
        .then((rows) => {
          if (!controller.signal.aborted) this.taskArtifacts = rows;
        })
        .catch(() => {
          if (!controller.signal.aborted) this.taskTreeFailed = true;
        })
        .finally(() => {
          if (!controller.signal.aborted) this.taskTreeLoading = false;
        });
    });
  }

  /**
   * Same story as the job's files above: the explorer threw its listing away and re-read the
   * root on every snapshot, which read as the tree blinking once a second. Called where the
   * pane's other effects end, so it runs after them as it always has.
   */
  watchWorkspace(): void {
    $effect(() => {
      const client = this.#h.api();
      const workspaceMode = this.#h.mode() === "workspace";
      const root = this.#h.workspacePath();
      const key = workspaceMode && client ? (root ?? "") : null;
      if (key === this.loadedWorkspaceKey && client === this.loadedWorkspaceClient) return;
      this.loadedWorkspaceKey = key;
      this.loadedWorkspaceClient = client;
      untrack(() => {
        this.treeGeneration += 1;
        this.workspaceTree = [];
        this.loadedDirs = new Set();
        this.loadingDirs = new Set();
        this.failedDirs = new Set();
        this.truncatedHint = false;
        if (key !== null) void this.loadWorkspaceDir(".");
      });
    });
  }

  /** The pane is going away: anything still in flight belongs to a listing that is gone. */
  destroy(): void {
    this.taskTreeAbort?.abort();
    this.treeGeneration += 1;
  }

  async loadWorkspaceDir(dirPath: string): Promise<void> {
    const client = this.#h.api();
    const path = dirPath || ".";
    if (!client || this.loadingDirs.has(path) || this.loadedDirs.has(path)) return;
    const generation = this.treeGeneration;
    this.loadingDirs = new Set(this.loadingDirs).add(path);
    this.failedDirs = new Set([...this.failedDirs].filter((dir) => dir !== path));
    try {
      const page = await client.workspaceTree(path === "." ? "" : path);
      if (generation !== this.treeGeneration) return;
      const children = workspaceEntriesToNodes(page.items);
      if (path === ".") this.workspaceTree = children;
      else this.workspaceTree = mergeWorkspaceChildren(this.workspaceTree, path, children, page.truncated);
      this.loadedDirs = new Set(this.loadedDirs).add(path);
      if (page.truncated) this.truncatedHint = true;
    } catch {
      if (generation === this.treeGeneration) this.failedDirs = new Set(this.failedDirs).add(path);
    } finally {
      if (generation === this.treeGeneration) {
        this.loadingDirs = new Set([...this.loadingDirs].filter((dir) => dir !== path));
      }
    }
  }

  openTreeMenu = (node: ArtifactTreeNode, event: MouseEvent, targets: ArtifactTreeNode[]): void => {
    this.treeMenu = { node, targets, x: event.clientX, y: event.clientY };
  };

  askTrash = (nodes: ArtifactTreeNode[]): void => {
    if (!this.canTrash || nodes.length === 0) return;
    this.trashAsk = { nodes, busy: false, failed: null };
  };

  async confirmTrash(): Promise<void> {
    const ask = this.trashAsk;
    const client = this.#h.api();
    if (!ask || ask.busy || !client) return;
    ask.busy = true;
    let result: Awaited<ReturnType<MessengerApi["trashWorkspacePaths"]>>;
    try {
      result = await client.trashWorkspacePaths(ask.nodes.map((node) => node.path));
    } catch (error) {
      if (this.trashAsk !== ask) return;
      ask.busy = false;
      ask.failed = error instanceof Error && error.message ? error.message : String(error);
      return;
    }
    this.dropTrashed(result.trashed);
    if (this.trashAsk !== ask) return;
    if (result.failed.length === 0) {
      this.trashAsk = null;
      return;
    }
    const left = new Set(result.failed.map((row) => row.path));
    this.trashAsk = { nodes: ask.nodes.filter((node) => left.has(node.path)), busy: false, failed: result.failed[0]!.message };
  }

  /** Takes trashed rows out of the tree where they are: re-reading it would fold every open folder. */
  dropTrashed(paths: string[]): void {
    if (paths.length === 0) return;
    this.trashedPaths = [...this.trashedPaths, ...paths];
    if (this.#h.mode() === "workspace") {
      this.workspaceTree = removeTreePaths(this.workspaceTree, paths);
      const keep = (dirs: Set<string>) => new Set([...dirs].filter((dir) => !isUnderAny(dir, paths)));
      this.loadedDirs = keep(this.loadedDirs);
      this.failedDirs = keep(this.failedDirs);
    } else if (this.taskArtifacts) {
      this.taskArtifacts = { ...this.taskArtifacts, items: this.taskArtifacts.items.filter((row) => !isUnderAny(row.path, paths)) };
    }
    if (this.#h.relpath() && isUnderAny(this.#h.relpath(), paths)) this.#h.showGone();
  }
}
