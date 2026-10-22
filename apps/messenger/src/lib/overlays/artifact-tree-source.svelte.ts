import { untrack } from "svelte";
import type { Attachment, TaskArtifacts } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { hostSeparator } from "../paths.ts";
import { absWorkspacePath, artifactKind, citedInWorkspace, isHostCitedPath, terminalDirFor } from "./artifacts.ts";
import {
  buildCitedPathTree,
  buildTaskArtifactTree,
  graftDirListings,
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
  /** The project session's directory (ADR 0095) when the preview is one of its conversation's. */
  projectDir: () => string | null;
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

  /** Cited paths the Mac was asked about: a folder, or not one. */
  dirProbe = $state(new Map<string, "dir" | "file">());
  /** What is in each cited path that turned out to be a folder, one level down. */
  citedListings = $state(new Map<string, ArtifactTreeNode[]>());
  #probing = new Set<string>();
  #probeClient: MessengerApi | null = null;
  /** The Mac's home as it names it, asked for once a path cited from `~` needs a place on disk. */
  home = $state<string | null>(null);
  #homeClient: MessengerApi | null = null;

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
    graftDirListings(
      this.taskArtifacts
        ? buildTaskArtifactTree(
            this.taskArtifacts.dir,
            this.taskArtifacts.items.map((row) => row.path),
            this.ownPaths
          )
        : buildCitedPathTree(this.ownPaths),
      this.citedListings
    )
  );

  /**
   * Opened from a project session (ADR 0095), a file inside its directory is shown in that
   * directory's tree, as in the agent's own app. Null for the explorer, a job's files and a file
   * from anywhere else (a picture you pasted, `/tmp/…`), which keep the tree they had.
   */
  projectRoot = $derived.by(() => {
    if (this.#h.mode() === "workspace" || this.#h.taskId()) return null;
    const dir = dirKey(this.#h.projectDir() ?? "");
    const relpath = dirKey(this.#h.relpath());
    return dir && (relpath === dir || holds(dir, relpath)) ? dir : null;
  });
  /** The tree is a folder read a level at a time, as you open it: the workspace's, or the project's. */
  lazy = $derived.by(() => this.#h.mode() === "workspace" || this.projectRoot !== null);
  /**
   * The project's folders down to the file on screen, outermost first, and the one on screen when
   * it is a folder: the tree opens them, each listed after the one above it.
   */
  revealDirs = $derived.by(() => {
    const root = this.projectRoot;
    if (root === null) return [];
    const relpath = dirKey(this.#h.relpath());
    const names = relpath.slice(root.length + 1).split(/[\\/]/).filter(Boolean);
    if (!this.isDir(relpath)) names.pop();
    const sep = hostSeparator(root);
    const dirs: string[] = [];
    for (const name of names) dirs.push(`${dirs.at(-1) ?? root}${sep}${name}`);
    return dirs;
  });

  workspaceTree = $state<ArtifactTreeNode[]>([]);
  loadedDirs = $state(new Set<string>());
  loadingDirs = $state(new Set<string>());
  failedDirs = $state(new Set<string>());
  treeGeneration = $state(0);
  truncatedHint = $state(false);
  tree = $derived.by(() => this.lazy ? this.workspaceTree : this.citedTree);
  /** Which workspace root (or project directory) is listed; `null` when the tree is not read a folder at a time. */
  loadedWorkspaceKey: string | null | undefined = undefined;
  loadedWorkspaceClient: MessengerApi | null = null;

  /** Where the rows the menu acts on sit on the machine, one a line; unknown until the workspace root (or the home, for `~`) is. */
  treeMenuAbsPaths = $derived.by(() => {
    if (!this.treeMenu) return null;
    const paths = this.treeMenu.targets.map((node) => absWorkspacePath(this.#h.workspacePath(), node.path, this.home));
    return paths.every((path) => path !== null) ? paths.join("\n") : null;
  });
  /** Anything that reaches the Mac can move files to its Trash; a stand-in client without the call cannot. */
  canTrash = $derived.by(() => typeof this.#h.api()?.trashWorkspacePaths === "function");
  /**
   * Whether every row the menu acts on is the workspace's. A file opened from elsewhere on the Mac
   * has no workspace path to copy, and the Trash takes workspace files only.
   */
  treeMenuInWorkspace = $derived.by(() =>
    Boolean(this.treeMenu?.targets.every((node) => citedInWorkspace(this.#h.workspacePath(), node.path, this.home)))
  );
  treeMenuCanTrash = $derived.by(() => this.canTrash && this.treeMenuInWorkspace);

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
    this.treeMenu && this.#h.onOpenTerminal() ? terminalDirFor(this.#h.workspacePath(), this.treeMenu.node.path, this.treeMenu.node.kind, this.home) : null
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

    /*
     * A cited path may be a folder: a folder attachment, or a link a Bot wrote as
     * `voice_samples/ja/`. Nothing in the message says what is in it, and the tree built from the
     * message made it a leaf, so the pane showed the bare word "Folder". The Mac is asked once per
     * path (a listing comes back; a file answers 422) and a folder's entries are grafted into the
     * tree. Only paths that may be folders are asked: rows marked `is_dir`, rows the path on
     * screen sits inside (the folder a link opened, walked into, then reopened), and the path on
     * screen when its name says nothing about its type and no attachment says it is a file (a
     * link's row is a `virtual-` one). Opening a subfolder from the tree makes it the path on
     * screen, so it is asked in turn.
     */
    $effect(() => {
      const client = this.#h.api();
      if (this.#h.mode() === "workspace" || !client) return;
      const candidates = new Set<string>();
      const relpath = this.#h.relpath();
      for (const row of this.#h.siblings()) {
        if (row.exists === false) continue;
        const path = dirKey(row.workspace_relpath);
        if (row.is_dir || (relpath && holds(path, dirKey(relpath)))) candidates.add(path);
      }
      const own = relpath ? this.#h.siblings().find((row) => dirKey(row.workspace_relpath) === dirKey(relpath)) : undefined;
      const aFile = own !== undefined && !own.is_dir && !own.id.startsWith("virtual-");
      if (relpath && !aFile && artifactKind(relpath) === "file") candidates.add(dirKey(relpath));
      untrack(() => {
        // A reconnect hands over a new client, and what it answered belongs to the old one.
        if (client !== this.#probeClient) {
          this.#probeClient = client;
          this.#probing = new Set();
          this.dirProbe = new Map();
          this.citedListings = new Map();
        }
        for (const path of candidates) if (path) void this.probeDir(client, path);
      });
    });

    // A path cited from `~` opens, reveals and starts a terminal on the Mac only by its full spelling.
    $effect(() => {
      const client = this.#h.api();
      if (!client || client === this.#homeClient) return;
      const relpath = this.#h.relpath();
      const fromHome = [relpath, ...this.ownPaths].some((path) => /^~[\\/]/.test(path.trim()));
      if (!fromHome) return;
      untrack(() => {
        this.#homeClient = client;
        this.home = null;
        client.workspaceTree("~")
          .then((page) => {
            if (client === this.#homeClient) this.home = page.path;
          })
          .catch(() => {
            // Unknown, the rows from `~` keep their open and copy-name entries and lose the rest.
          });
      });
    });
  }

  /** Asks the Mac whether a cited path is a folder, and what is in it when it is. */
  async probeDir(client: MessengerApi, path: string): Promise<void> {
    if (this.dirProbe.has(path) || this.#probing.has(path)) return;
    this.#probing.add(path);
    try {
      const page = await client.workspaceTree(path);
      if (client !== this.#probeClient) return;
      this.dirProbe = new Map(this.dirProbe).set(path, "dir");
      // A folder elsewhere on the Mac comes back spelled from its real place; its entries keep the
      // spelling it was cited by (`~/x/…`), as a workspace folder's do, so the rows line up.
      const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
      const items = isHostCitedPath(path) ? page.items.map((row) => ({ ...row, path: `${path}${sep}${row.name}` })) : page.items;
      this.citedListings = new Map(this.citedListings).set(path, workspaceEntriesToNodes(items));
    } catch {
      if (client === this.#probeClient) this.dirProbe = new Map(this.dirProbe).set(path, "file");
    } finally {
      this.#probing.delete(path);
    }
  }

  /** Whether the Mac said this cited path is a folder. */
  isDir = (path: string): boolean => this.dirProbe.get(dirKey(path)) === "dir";

  /** What is in a cited folder, once the Mac listed it. */
  listingOf = (path: string): ArtifactTreeNode[] | null => this.citedListings.get(dirKey(path)) ?? null;

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
      // Walking from file to file inside the project keeps its listing; leaving it lets go.
      const project = this.projectRoot;
      const key = !client ? null : workspaceMode ? (root ?? "") : project !== null ? `project\u0000${project}` : null;
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

    /*
     * A folder's entries have nowhere to go until the folder above it is listed (a listing that
     * comes first is dropped, and the folder reads as empty), so the way down to the file on
     * screen is listed one folder after another.
     */
    $effect(() => {
      const dirs = this.revealDirs;
      const generation = this.treeGeneration;
      if (dirs.length === 0) return;
      untrack(() => void this.revealPath(dirs, generation));
    });
  }

  async revealPath(dirs: readonly string[], generation: number): Promise<void> {
    for (const dir of [".", ...dirs]) {
      if (generation !== this.treeGeneration) return;
      await this.loadWorkspaceDir(dir);
      if (!this.loadedDirs.has(dir)) return;
    }
  }

  /** The pane is going away: anything still in flight belongs to a listing that is gone. */
  destroy(): void {
    this.taskTreeAbort?.abort();
    this.treeGeneration += 1;
  }

  /** A folder being listed, so whoever asks for it again waits for the same listing. */
  #listing = new Map<string, Promise<void>>();

  loadWorkspaceDir(dirPath: string): Promise<void> {
    const path = dirPath || ".";
    const asked = this.#listing.get(path);
    if (asked && this.loadingDirs.has(path)) return asked;
    const listing = this.#listDir(path);
    this.#listing.set(path, listing);
    return listing;
  }

  async #listDir(path: string): Promise<void> {
    const client = this.#h.api();
    if (!client || this.loadingDirs.has(path) || this.loadedDirs.has(path)) return;
    const generation = this.treeGeneration;
    const project = this.projectRoot;
    this.loadingDirs = new Set(this.loadingDirs).add(path);
    this.failedDirs = new Set([...this.failedDirs].filter((dir) => dir !== path));
    try {
      const dir = path === "." ? project : path;
      const page = await client.workspaceTree(dir ?? "");
      if (generation !== this.treeGeneration) return;
      // The Mac spells a folder's entries from where it really is; the project's keep the spelling
      // the agent's paths have, so the file on screen is the row it opened from.
      const items = dir !== null && project !== null
        ? page.items.map((row) => ({ ...row, path: `${dir}${hostSeparator(dir)}${row.name}` }))
        : page.items;
      const children = workspaceEntriesToNodes(items);
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
    if (!nodes.every((node) => citedInWorkspace(this.#h.workspacePath(), node.path, this.home))) return;
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
    if (this.lazy) {
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

/** A folder's path as the tree keys it: a link may end in a slash (`voice_samples/ja/`), a node never does. */
function dirKey(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

/** Whether `path` lies inside `dir`, in either separator: one elsewhere on the Mac may be `C:\x`. */
function holds(dir: string, path: string): boolean {
  return dir !== "" && (path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`));
}
