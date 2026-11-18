import { derived, effect, state } from "../../lib/reactive";
import { untrack } from "../../lib/reactive";
import type { Attachment, TaskArtifacts } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { ApiError } from "../api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { baseName, hostSeparator } from "../paths.ts";
import { showToast } from "../toast.svelte.ts";
import { absWorkspacePath, artifactKind, citedInWorkspace, isHostCitedPath, terminalDirFor } from "./artifacts.ts";
import {
  folderOfPath,
  buildCitedPathTree,
  buildTaskArtifactTree,
  graftDirListings,
  isUnderAny,
  markPathsFresh,
  mergeWorkspaceChildren,
  relistWorkspaceChildren,
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
  /** Rows moved in the tree took the file on screen with them: it shows from `to` now. */
  followMove?: (from: string, to: string) => void;
  /** The project session's directory (ADR 0095) when the preview is one of its conversation's. */
  projectDir: () => string | null;
}

/** The file tree: what the message cites or the job lists, or the workspace read folder by folder, and the right-click menu and Trash confirm that act on it. */
export class ArtifactTreeSource {
  readonly #h: ArtifactTreeSourceHost;

  /** The file-tree row that was right-clicked, the rows its menu acts on, and where it hangs. */
  #treeMenu$s = state<{ node: ArtifactTreeNode; targets: ArtifactTreeNode[]; x: number; y: number } | null>(null);
	get treeMenu(): { node: ArtifactTreeNode; targets: ArtifactTreeNode[]; x: number; y: number } | null { return this.#treeMenu$s.get(); }
	set treeMenu(value: { node: ArtifactTreeNode; targets: ArtifactTreeNode[]; x: number; y: number } | null) { this.#treeMenu$s.set(value); }
  /** Rows waiting on the Move to Trash confirm; `failed` is the Mac's reason once a try left some behind. */
  #trashAsk$s = state<{ nodes: ArtifactTreeNode[]; busy: boolean; failed: string | null } | null>(null);
	get trashAsk(): { nodes: ArtifactTreeNode[]; busy: boolean; failed: string | null } | null { return this.#trashAsk$s.get(); }
	set trashAsk(value: { nodes: ArtifactTreeNode[]; busy: boolean; failed: string | null } | null) { this.#trashAsk$s.set(value); }
  /** Trashed from this pane. The message's own rows still name those files until the Mac says they are gone. */
  #trashedPaths$s = state<string[]>([]);
	get trashedPaths(): string[] { return this.#trashedPaths$s.get(); }
	set trashedPaths(value: string[]) { this.#trashedPaths$s.set(value); }
  #taskArtifacts$s = state<TaskArtifacts | null>(null);
	get taskArtifacts(): TaskArtifacts | null { return this.#taskArtifacts$s.get(); }
	set taskArtifacts(value: TaskArtifacts | null) { this.#taskArtifacts$s.set(value); }
  #taskTreeLoading$s = state(false);
	get taskTreeLoading() { return this.#taskTreeLoading$s.get(); }
	set taskTreeLoading(value) { this.#taskTreeLoading$s.set(value); }
  #taskTreeFailed$s = state(false);
	get taskTreeFailed() { return this.#taskTreeFailed$s.get(); }
	set taskTreeFailed(value) { this.#taskTreeFailed$s.set(value); }
  #taskTreeRetry$s = state(0);
	get taskTreeRetry() { return this.#taskTreeRetry$s.get(); }
	set taskTreeRetry(value) { this.#taskTreeRetry$s.set(value); }
  /** The job whose files are listed, so the same job is never pulled twice. */
  loadedTaskKey: string | null = null;
  loadedTaskClient: MessengerApi | null = null;
  taskTreeAbort: AbortController | null = null;

  /** Cited paths the Mac was asked about: a folder, or not one. */
  #dirProbe$s = state(new Map<string, "dir" | "file">());
	get dirProbe() { return this.#dirProbe$s.get(); }
	set dirProbe(value) { this.#dirProbe$s.set(value); }
  /** What is in each cited path that turned out to be a folder, one level down. */
  #citedListings$s = state(new Map<string, ArtifactTreeNode[]>());
	get citedListings() { return this.#citedListings$s.get(); }
	set citedListings(value) { this.#citedListings$s.set(value); }
  #probing = new Set<string>();
  #probeClient: MessengerApi | null = null;
  /** The Mac's home as it names it, asked for once a path cited from `~` needs a place on disk. */
  #home$s = state<string | null>(null);
	get home(): string | null { return this.#home$s.get(); }
	set home(value: string | null) { this.#home$s.set(value); }
  #homeClient: MessengerApi | null = null;

  /**
   * Copies dropped from Finder on a tree of what a message or a job names (`importDropped`), as
   * that tree spells them, with the message or job they were dropped on: they are rows of that
   * tree, not of the next one this pane shows. `virtual-` rows (a link opened, the file walked to)
   * come and go as you open files, so they do not count.
   */
  #imported$s = state<{ key: string; paths: string[] }>({ key: "", paths: [] });
  #importKey$s = derived(() =>
    `${this.#h.taskId() ?? ""}|${this.#h.siblings().filter((row) => !row.id.startsWith("virtual-")).map((row) => row.id).sort().join(",")}`);
  /** The copies dropped on this tree, less what was trashed since. */
  #importedPaths$s = derived(() => {
    const imported = this.#imported$s.get();
    return imported.key === this.#importKey$s.get() ? imported.paths.filter((path) => !isUnderAny(path, this.#goneFromHere())) : [];
  });
	get importedPaths() { return this.#importedPaths$s.get(); }

  /** Moved elsewhere from this tree: like a trashed row, no longer here (their new places are `importedPaths`). */
  #movedAway$s = state<string[]>([]);
  /** Rows no longer where the message or the job names them: trashed, or moved from here. */
  #goneFromHere = (): string[] => [...this.trashedPaths, ...this.#movedAway$s.get()];

  /** What this entry handed over, less what the Mac already knows is deleted: the tree is for opening files. */
  #ownPaths$s = derived(() =>
    this.#h.siblings()
      .filter((row) => row.exists !== false && !isUnderAny(row.workspace_relpath, this.#goneFromHere()))
      .map((row) => row.workspace_relpath));
	get ownPaths() { return this.#ownPaths$s.get(); }
  /**
   * Opened from a message, the files that message names and nothing else. Opened from the flow
   * chart, which names a job, the job's files anchored at its work dir with this step's own
   * marked — falling back to this step's alone when the pull failed.
   */
  #citedTree$s = derived(() => {
    // Copies dropped on the tree are rows of it, marked as just arrived.
    const imported = this.importedPaths;
    const tree = graftDirListings(
      this.taskArtifacts
        ? buildTaskArtifactTree(
            this.taskArtifacts.dir,
            this.taskArtifacts.items.map((row) => row.path),
            [...this.ownPaths, ...imported]
          )
        : buildCitedPathTree([...this.ownPaths, ...imported]),
      this.citedListings
    );
    return markPathsFresh(tree, new Set(imported.map(dirKey)));
  });
	get citedTree() { return this.#citedTree$s.get(); }

  /**
   * Opened from a project session (ADR 0095), the tree is that session's directory, as in the
   * agent's own app, whatever file is on screen: one it cites from elsewhere (`~/Downloads/…`,
   * `/tmp/…`, a picture you pasted) opens beside the project's tree too, with no row of its own
   * in it (decision 29). Null for the explorer, a job's files and anything outside a project session.
   */
  #projectRoot$s = derived(() => {
    if (this.#h.mode() === "workspace" || this.#h.taskId()) return null;
    return dirKey(this.#h.projectDir() ?? "") || null;
  });
	get projectRoot() { return this.#projectRoot$s.get(); }
  /**
   * Whether the file on screen is inside the project's directory: such a file is found in the tree,
   * saved where it is and annotated (decisions 14 and 28); one from elsewhere only sits beside it.
   */
  #inProject$s = derived(() => {
    const dir = this.projectRoot;
    const relpath = dirKey(this.#h.relpath());
    return dir !== null && (relpath === dir || holds(dir, relpath));
  });
	get inProject() { return this.#inProject$s.get(); }
  /** The tree is a folder read a level at a time, as you open it: the workspace's, or the project's. */
  #lazy$s = derived(() => this.#h.mode() === "workspace" || this.projectRoot !== null);
	get lazy() { return this.#lazy$s.get(); }
  /**
   * The project's folders down to the file on screen, outermost first, and the one on screen when
   * it is a folder: the tree opens them, each listed after the one above it.
   */
  #revealDirs$s = derived(() => {
    const root = this.projectRoot;
    if (root === null || !this.inProject) return [];
    const relpath = dirKey(this.#h.relpath());
    const names = relpath.slice(root.length + 1).split(/[\\/]/).filter(Boolean);
    if (!this.isDir(relpath)) names.pop();
    const sep = hostSeparator(root);
    const dirs: string[] = [];
    for (const name of names) dirs.push(`${dirs.at(-1) ?? root}${sep}${name}`);
    return dirs;
  });
	get revealDirs() { return this.#revealDirs$s.get(); }

  #workspaceTree$s = state<ArtifactTreeNode[]>([]);
	get workspaceTree(): ArtifactTreeNode[] { return this.#workspaceTree$s.get(); }
	set workspaceTree(value: ArtifactTreeNode[]) { this.#workspaceTree$s.set(value); }
  #loadedDirs$s = state(new Set<string>());
	get loadedDirs() { return this.#loadedDirs$s.get(); }
	set loadedDirs(value) { this.#loadedDirs$s.set(value); }
  #loadingDirs$s = state(new Set<string>());
	get loadingDirs() { return this.#loadingDirs$s.get(); }
	set loadingDirs(value) { this.#loadingDirs$s.set(value); }
  #failedDirs$s = state(new Set<string>());
	get failedDirs() { return this.#failedDirs$s.get(); }
	set failedDirs(value) { this.#failedDirs$s.set(value); }
  #treeGeneration$s = state(0);
	get treeGeneration() { return this.#treeGeneration$s.get(); }
	set treeGeneration(value) { this.#treeGeneration$s.set(value); }
  #truncatedHint$s = state(false);
	get truncatedHint() { return this.#truncatedHint$s.get(); }
	set truncatedHint(value) { this.#truncatedHint$s.set(value); }
  #tree$s = derived(() => this.lazy ? this.workspaceTree : this.citedTree);
	get tree() { return this.#tree$s.get(); }
  /** Which workspace root (or project directory) is listed; `null` when the tree is not read a folder at a time. */
  loadedWorkspaceKey: string | null | undefined = undefined;
  loadedWorkspaceClient: MessengerApi | null = null;

  /** Where the rows the menu acts on sit on the machine, one a line; unknown until the workspace root (or the home, for `~`) is. */
  #treeMenuAbsPaths$s = derived(() => {
    if (!this.treeMenu) return null;
    const paths = this.treeMenu.targets.map((node) => absWorkspacePath(this.#h.workspacePath(), node.path, this.home));
    return paths.every((path) => path !== null) ? paths.join("\n") : null;
  });
	get treeMenuAbsPaths() { return this.#treeMenuAbsPaths$s.get(); }
  /** Anything that reaches the Mac can move files to its Trash; a stand-in client without the call cannot. */
  #canTrash$s = derived(() => typeof this.#h.api()?.trashWorkspacePaths === "function");
	get canTrash() { return this.#canTrash$s.get(); }
  /** Rows can be dragged onto a folder to move them there, on any tree here, when the client has the call. */
  #canMove$s = derived(() => typeof this.#h.api()?.moveInWorkspace === "function");
	get canMove() { return this.#canMove$s.get(); }
  /**
   * Whether every row the menu acts on is the workspace's. A file opened from elsewhere on the Mac
   * has no workspace path to copy, and the Trash takes workspace files only.
   */
  #treeMenuInWorkspace$s = derived(() =>
    Boolean(this.treeMenu?.targets.every((node) => citedInWorkspace(this.#h.workspacePath(), node.path, this.home))));
	get treeMenuInWorkspace() { return this.#treeMenuInWorkspace$s.get(); }
  #treeMenuCanTrash$s = derived(() => this.canTrash && this.treeMenuInWorkspace);
	get treeMenuCanTrash() { return this.#treeMenuCanTrash$s.get(); }
  /**
   * Files from Finder can be dropped on any tree here, the workspace's, a project's, or the files a
   * message or a job names, when the client has the call. Only a desktop hears drops from Finder;
   * through the relay the Mac refuses the call, and the toast says so.
   */
  #canImport$s = derived(() => typeof this.#h.api()?.importIntoWorkspace === "function");
	get canImport() { return this.#canImport$s.get(); }

  #trashCopy$s = derived(() => {
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
	get trashCopy() { return this.#trashCopy$s.get(); }
  /** The folder a terminal opened from that row starts in: the row itself, or a file's own folder. */
  #treeMenuTerminalDir$s = derived(() =>
    this.treeMenu && this.#h.onOpenTerminal() ? terminalDirFor(this.#h.workspacePath(), this.treeMenu.node.path, this.treeMenu.node.kind, this.home) : null);
	get treeMenuTerminalDir() { return this.#treeMenuTerminalDir$s.get(); }

  constructor(host: ArtifactTreeSourceHost) {
    this.#h = host;

    /**
     * The props of this pane come off one object the shell derives, so every snapshot re-runs this
     * — and clearing the list to pull the same job again is the tree blinking. Only a different
     * job, or the retry button, is a reason to let go of what is listed.
     */
    effect(() => {
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
    effect(() => {
      const client = this.#h.api();
      if (this.#h.mode() === "workspace" || !client) return;
      const candidates = new Set<string>();
      const relpath = this.#h.relpath();
      for (const row of this.#h.siblings()) {
        if (row.exists === false) continue;
        const path = dirKey(row.workspace_relpath);
        if (row.is_dir || (relpath && holds(path, dirKey(relpath)))) candidates.add(path);
      }
      // A copy dropped on the tree may be a folder: asked like a cited one, and again after a reconnect.
      for (const path of this.importedPaths) candidates.add(dirKey(path));
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
    effect(() => {
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
    effect(() => {
      const client = this.#h.api();
      const workspaceMode = this.#h.mode() === "workspace";
      const root = this.#h.workspacePath();
      // Walking from file to file keeps the project's listing, out to a file from elsewhere and back too.
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
    effect(() => {
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

  /** A folder's entries as the tree keys them (`"."`: the top of the workspace, or of the project). */
  async #readDir(client: MessengerApi, path: string): Promise<{ children: ArtifactTreeNode[]; truncated: boolean }> {
    const project = this.projectRoot;
    const dir = path === "." ? project : path;
    const page = await client.workspaceTree(dir ?? "");
    // The Mac spells a folder's entries from where it really is; the project's keep the spelling
    // the agent's paths have, so the file on screen is the row it opened from.
    const items = dir !== null && project !== null
      ? page.items.map((row) => ({ ...row, path: `${dir}${hostSeparator(dir)}${row.name}` }))
      : page.items;
    return { children: workspaceEntriesToNodes(items), truncated: page.truncated };
  }

  async #listDir(path: string): Promise<void> {
    const client = this.#h.api();
    if (!client || this.loadingDirs.has(path) || this.loadedDirs.has(path)) return;
    const generation = this.treeGeneration;
    this.loadingDirs = new Set(this.loadingDirs).add(path);
    this.failedDirs = new Set([...this.failedDirs].filter((dir) => dir !== path));
    try {
      const { children, truncated } = await this.#readDir(client, path);
      if (generation !== this.treeGeneration) return;
      if (path === ".") this.workspaceTree = children;
      else this.workspaceTree = mergeWorkspaceChildren(this.workspaceTree, path, children, truncated);
      this.loadedDirs = new Set(this.loadedDirs).add(path);
      if (truncated) this.truncatedHint = true;
    } catch {
      if (generation === this.treeGeneration) this.failedDirs = new Set(this.failedDirs).add(path);
    } finally {
      if (generation === this.treeGeneration) {
        this.loadingDirs = new Set([...this.loadingDirs].filter((dir) => dir !== path));
      }
    }
  }

  /**
   * Files dropped on the tree from Finder (absolute paths on the Mac), copied into `dir`: the
   * folder they landed on, as the tree spells it, or `null` for the tree's top (the workspace, or
   * the project's folder). A folder read a level at a time is listed again where it is; on a tree
   * of what a message or a job names, the copies become rows of it (and a cited folder that was
   * listed is listed again). Either way the copies are marked as just arrived, and a toast says
   * what went in and what did not. Only the workspace and project folders take copies, and a
   * runtime too old to copy says so.
   */
  async importDropped(dir: string | null, sources: string[]): Promise<void> {
    const client = this.#h.api();
    if (!client?.importIntoWorkspace || sources.length === 0) return;
    const t = this.#h.t();
    const lazy = this.lazy;
    const project = this.projectRoot;
    const into = dir ?? (lazy ? project : null) ?? "";
    const generation = this.treeGeneration;
    const key = this.#importKey$s.get();
    let result: Awaited<ReturnType<MessengerApi["importIntoWorkspace"]>>;
    try {
      result = await client.importIntoWorkspace(into, sources);
    } catch (error) {
      showToast(this.#importRefusal(error), { tone: "error" });
      return;
    }
    const sep = into === "" ? "/" : hostSeparator(into);
    const copies = result.imported.map((row) => (into ? `${into.replace(/[\\/]+$/, "")}${sep}${row.name}` : row.name));
    if (lazy) await this.#relistAfterImport(client, dir === null ? "." : dir, generation, new Set(copies));
    else this.#addImported(client, key, into, copies);
    // One notice: a second one would take the first one's place.
    const label = into === "" ? "" : baseName(into);
    const said = [
      result.imported.length > 0 ? t.stream.workspaceImported(result.imported.map((row) => row.name), label) : "",
      result.failed.length > 0 ? t.stream.workspaceImportFailed(result.failed.map((row) => ({ name: baseName(row.source), code: row.code, message: row.message }))) : "",
    ].filter(Boolean);
    if (said.length > 0) showToast(said.join(t.stream.workspaceImportJoin), result.failed.length > 0 ? { tone: "error" } : undefined);
  }

  /** A folder read a level at a time, listed again where it is after the copies went in. */
  async #relistAfterImport(client: MessengerApi, at: string, generation: number, fresh: ReadonlySet<string>): Promise<void> {
    // A folder dropped on opens and is listed for the first time meanwhile; that listing may have
    // been read before the copies were there, so this one waits for it and lists again.
    if (this.loadingDirs.has(at)) await this.#listing.get(at);
    if (generation !== this.treeGeneration || (at !== "." && !this.loadedDirs.has(at))) return;
    try {
      const { children, truncated } = await this.#readDir(client, at);
      if (generation === this.treeGeneration) {
        this.workspaceTree = relistWorkspaceChildren(this.workspaceTree, at, children, truncated, fresh);
        if (truncated) this.truncatedHint = true;
      }
    } catch {
      // The rows stay as they were; the folder's next listing shows the copies.
    }
  }

  /**
   * The copies become rows of the tree they were dropped on (the probe effect asks whether each is
   * a folder); a cited folder that was listed is listed again, so its listing has them too.
   */
  #addImported(client: MessengerApi, key: string, into: string, copies: string[]): void {
    if (copies.length > 0) {
      const was = this.#imported$s.get();
      const kept = was.key === key ? was.paths : [];
      this.#imported$s.set({ key, paths: [...kept, ...copies.filter((path) => !kept.includes(path))] });
    }
    const folder = dirKey(into);
    if (folder && this.citedListings.has(folder)) {
      const probe = new Map(this.dirProbe);
      probe.delete(folder);
      const listings = new Map(this.citedListings);
      listings.delete(folder);
      this.dirProbe = probe;
      this.citedListings = listings;
      void this.probeDir(client, folder);
    }
  }

  /**
   * Rows dragged onto a folder of the tree (`dir`, as the tree spells it; `null` for its top),
   * moved there. The file on screen goes along if it is among them, unless it has edits not saved
   * yet, which keeps every row where it is. A folder read a level at a time lists the folders
   * they left and the one they went to again; a tree of what a message or a job names hides them
   * where they were and shows them where they are now. The toast says what moved and offers to
   * move them back (`undo` is that move back, which offers nothing more).
   */
  async moveItems(dir: string | null, items: readonly { path: string; isDir: boolean }[], undo = false): Promise<void> {
    const client = this.#h.api();
    if (!client?.moveInWorkspace || items.length === 0) return;
    const t = this.#h.t();
    const relpath = dirKey(this.#h.relpath());
    if (this.#h.dirty() && items.some((item) => relpath === dirKey(item.path) || holds(dirKey(item.path), relpath))) {
      showToast(t.stream.workspaceMoveUnsaved, { tone: "error" });
      return;
    }
    const lazy = this.lazy;
    const project = this.projectRoot;
    const into = dir ?? (lazy ? project : null) ?? "";
    const generation = this.treeGeneration;
    const key = this.#importKey$s.get();
    // A folder takes what is in it, so a row picked inside a picked folder is not asked for again (as the Trash does).
    const outermost = items.filter((item) => !items.some((other) => other !== item && holds(dirKey(other.path), dirKey(item.path))));
    let result: Awaited<ReturnType<MessengerApi["moveInWorkspace"]>>;
    try {
      result = await client.moveInWorkspace(into, outermost.map((item) => item.path));
    } catch (error) {
      showToast(this.#importRefusal(error, "move"), { tone: "error" });
      return;
    }
    const sep = into === "" ? "/" : hostSeparator(into);
    const base = into.replace(/[\\/]+$/, "");
    const moves = result.moved
      .map((row) => ({ from: dirKey(row.source), to: base ? `${base}${sep}${row.name}` : row.name }))
      .filter((move) => move.from !== move.to);
    if (moves.length > 0) {
      if (lazy) {
        // The folders they left, and the one they went to, listed again where they are.
        const folders = new Set([dir ?? ".", ...moves.map((move) => this.#treeFolderOf(move.from))]);
        const gone = moves.map((move) => move.from);
        const keep = (dirs: Set<string>) => new Set([...dirs].filter((path) => !isUnderAny(path, gone)));
        this.loadedDirs = keep(this.loadedDirs);
        this.failedDirs = keep(this.failedDirs);
        for (const folder of folders) await this.#relistAfterImport(client, folder, generation, new Set(moves.map((move) => move.to)));
      } else {
        // A row comes back where it was hidden (an undo), or is added; one added earlier goes, a cited one hides.
        let away = this.#movedAway$s.get().slice();
        const added: string[] = [];
        for (const move of moves) {
          if (away.includes(move.to)) away = away.filter((path) => path !== move.to);
          else added.push(move.to);
          if (!this.#dropImported(key, move.from)) away.push(move.from);
        }
        this.#movedAway$s.set(away);
        this.#addImported(client, key, into, added);
        for (const move of moves) this.#relistCited(client, folderOfPath(move.from) ?? "");
      }
      const follow = moves.find((move) => relpath === move.from || holds(move.from, relpath));
      if (follow) this.#h.followMove?.(relpath, `${follow.to}${relpath.slice(follow.from.length)}`);
    }
    const label = into === "" ? "" : baseName(into);
    const said = [
      result.moved.length > 0 ? t.stream.workspaceMoved(result.moved.map((row) => row.name), label) : "",
      result.failed.length > 0 ? t.stream.workspaceMoveFailed(result.failed.map((row) => ({ name: baseName(row.source), code: row.code, message: row.message }))) : "",
    ].filter(Boolean);
    if (said.length === 0) return;
    const back = !undo && moves.length > 0
      ? { label: t.stream.workspaceMoveUndo, run: () => void this.#moveBack(moves, items) }
      : undefined;
    showToast(said.join(t.stream.workspaceImportJoin), { ...(result.failed.length > 0 ? { tone: "error" as const } : {}), ...(back ? { action: back } : {}) });
  }

  /** Takes a row dropped or moved onto this tree out of it again (it moved on); false when it was not one. */
  #dropImported(key: string, path: string): boolean {
    const imported = this.#imported$s.get();
    if (imported.key !== key || !imported.paths.includes(path)) return false;
    this.#imported$s.set({ key, paths: imported.paths.filter((row) => row !== path) });
    return true;
  }

  /** Undo: each moved row back into the folder it came from. */
  async #moveBack(moves: readonly { from: string; to: string }[], items: readonly { path: string; isDir: boolean }[]): Promise<void> {
    const byFolder = new Map<string, { path: string; isDir: boolean }[]>();
    for (const move of moves) {
      const folder = folderOfPath(move.from) ?? "";
      const isDir = items.find((item) => dirKey(item.path) === move.from)?.isDir ?? false;
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), { path: move.to, isDir }]);
    }
    for (const [folder, back] of byFolder) await this.moveItems(this.#treeFolder(folder), back, true);
  }

  /** A folder as this tree keys it for listing: `"."` for its top (the workspace, or the project's folder). */
  #treeFolderOf(path: string): string {
    const folder = this.#treeFolder(folderOfPath(path) ?? "");
    return folder ?? ".";
  }
  #treeFolder(folder: string): string | null {
    const project = this.projectRoot;
    return folder === "" || (project !== null && dirKey(folder) === project) ? null : folder;
  }

  /** A cited folder that was listed, listed again: what moved into it or out of it shows as it is now. */
  #relistCited(client: MessengerApi, folder: string): void {
    const key = dirKey(folder);
    if (!key || !this.citedListings.has(key)) return;
    const probe = new Map(this.dirProbe);
    probe.delete(key);
    const listings = new Map(this.citedListings);
    listings.delete(key);
    this.dirProbe = probe;
    this.citedListings = listings;
    void this.probeDir(client, key);
  }

  /**
   * What a refused drop or move says: in words for a folder the runtime does not write to, or a
   * runtime too old to have the route. A route the runtime does not know answers 404 "not found"
   * (the dispatch's last word) or "unknown route"; a folder gone answers 404 "folder not found".
   */
  #importRefusal(error: unknown, kind: "import" | "move" = "import"): string {
    const t = this.#h.t();
    if (error instanceof ApiError && error.status === 404 && (error.message === "not found" || error.message === "unknown route")) return t.stream.workspaceImportNeedsRestart;
    if (error instanceof ApiError && error.status === 422 && /outside the workspace/.test(error.message)) {
      return kind === "move" ? t.stream.workspaceMoveOutside : t.stream.workspaceImportOutside;
    }
    const reason = error instanceof Error && error.message ? error.message : String(error);
    return kind === "move" ? t.stream.workspaceMoveRefused(reason) : t.stream.workspaceImportRefused(reason);
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
