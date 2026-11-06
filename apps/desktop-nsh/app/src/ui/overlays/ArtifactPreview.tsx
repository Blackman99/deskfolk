/**
 * The preview of a file a Bot made, or the workspace's own files (`ArtifactPreview.svelte`): the
 * header a phone (or a sheet) gets, the annotation bar, the file tree beside the file (a drop-down
 * sheet on a narrow window), the body its kind decides (`ArtifactBody`), the send bars, the tree's
 * menu, the Trash confirm, the enlarged picture and the unsaved-edit dialog.
 *
 * The props are the Svelte's, minus `t` and the `loadMonaco` test seam, plus `ref`: the pane's
 * handle (`ArtifactPane` / `WorkspaceHandle`, what the Svelte exports) given to the host once the
 * preview is up, and null when it goes. `ShellPreview` and `WorkspaceView` give their props as an
 * object of getters: read them as `props.x` where used, never destructured or spread.
 *
 * Not the Svelte's: the tree split is a PanResponder; the pane's width comes from `onLayout`; Escape
 * (list open) and the save shortcut are `keymap`; opening a file with the system or in Finder is the
 * Tauri command `open_workspace_path` the shell bridges (`openWorkspacePath`).
 */
import { cleanup, colorScheme, computed, Clipboard, effect, keymap, PanResponder, Scroll, signal, Text, untracked, View } from "nsh";
import type { Annotation, Attachment, CreateAnnotationRequest, PatchAnnotationRequest, SessionSummary } from "@real-bot/protocol";
import { ANNOTATION_BATCH_MAX } from "@real-bot/protocol";
import { ApiError } from "../../m/api.ts";
import { ADAPTER_ANCHOR_KIND, adapterFor, annotateGate, destinationLabel, drawnAnnotations, type AnnotationTarget } from "../../m/annotations/model.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { ArtifactAnnotations } from "../../m/overlays/artifact-annotations.svelte.ts";
import { ArtifactLoader } from "../../m/overlays/artifact-loader.svelte.ts";
import { ArtifactTreeSource } from "../../m/overlays/artifact-tree-source.svelte.ts";
import { clampArtifactTreeWidth, loadArtifactTreeWidth, saveArtifactTreeWidth } from "../../m/overlays/artifact-tree-width.ts";
import type { ArtifactTreeNode } from "../../m/overlays/artifact-tree.ts";
import { absWorkspacePath, artifactByteSource, artifactKind, citedInWorkspace, isInAppPreviewKind, tooLargeToRender, type ArtifactKind } from "../../m/overlays/artifacts.ts";
import { openWorkspacePath } from "../../m/overlays/open-workspace.ts";
import { baseName } from "../../m/paths.ts";
import { isTauri } from "../../m/tauri.ts";
import { copy } from "../../runtime";
import { AnnotationSendBar } from "../annotations/AnnotationSendBar";
import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { MessageImageLightbox, type ImageOrigin } from "../chat/MessageImageLightbox";
import { ArtifactAnnotBar } from "./ArtifactAnnotBar";
import { ArtifactBody, type ArtifactEditorHandle, type ArtifactPdfHandle } from "./ArtifactBody";
import { ArtifactDirtyDialog } from "./ArtifactDirtyDialog";
import { ArtifactTree } from "./ArtifactTree";
import { ArtifactTreeMenu } from "./ArtifactTreeMenu";
import { DangerDialog } from "./DangerDialog";
import { FileDownload } from "./FileDownload";
import type { ArtifactPane } from "./ShellPreview";

type PendingNav = null | { kind: "close"; afterClose?: () => void } | { kind: "node"; node: ArtifactTreeNode } | { kind: "leave"; after: () => void };

export type ArtifactPreviewComponentProps = {
  attachment?: Attachment | null;
  relpath: string;
  siblings?: Attachment[];
  api: MessengerApi | null;
  workspacePath?: string | null;
  onClose: () => void;
  onSelect?: (att: Attachment) => void;
  mode?: "cited" | "workspace";
  onSelectWorkspacePath?: (path: string) => void;
  /** Starts a terminal in this folder (absolute); without it the tree offers none. */
  onOpenTerminal?: (dir: string) => void;
  forceTree?: boolean;
  /** One file and nothing beside it: a file opened over the whole app has no tree, however deep. */
  noTree?: boolean;
  taskId?: string | null;
  projectDir?: string | null;
  target?: AnnotationTarget | null;
  annotations?: Annotation[];
  annotationFocusId?: string | null;
  annotationFileKey?: string | null;
  bots?: ReadonlyMap<string, { name: string }>;
  locale?: "zh" | "en";
  sessions?: SessionSummary[];
  viewedSessionId?: string | null;
  onLoadAnnotations?: (path: string) => void;
  onCreateAnnotation?: (input: CreateAnnotationRequest) => Promise<ApiError | null>;
  onPatchAnnotation?: (id: string, patch: PatchAnnotationRequest) => Promise<ApiError | null>;
  onDeleteAnnotation?: (id: string) => Promise<ApiError | null>;
  onSendAnnotations?: (sessionId: string, summary: string, ids: string[]) => Promise<ApiError | null>;
  /** The pane is a whole screen of its own: the phone flow, whatever the window width. */
  sheet?: boolean;
  /** The pane's handle, once it is up (null when it goes). */
  ref?: (pane: ArtifactPane | null) => void;
};

/**
 * The props, each kept as last read. A host that closes its preview (`ShellPreview`) clears what
 * its getters read before it takes this component down, so an effect that runs in between would
 * throw: it gets the value the preview had instead.
 */
function held<T extends object>(source: T): T {
  const last = new Map<PropertyKey, unknown>();
  return new Proxy(source, {
    get(target, key) {
      try {
        const value = Reflect.get(target, key);
        last.set(key, value);
        return value;
      } catch (error) {
        if (last.has(key)) return last.get(key);
        throw error;
      }
    },
  });
}

export function ArtifactPreview(hosted: ArtifactPreviewComponentProps) {
  const props = held(hosted);
  const t = () => copy();
  const relpath = () => props.relpath;
  const mode = () => props.mode ?? "cited";
  const attachment = () => props.attachment ?? null;
  const api = () => props.api;

  const enlarged = signal<{ from: string; relpath: string; own: boolean; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
  const shownEnlarged = computed(() => {
    const e = enlarged();
    return e && e.from === relpath() ? e : null;
  });
  const wrap = signal(true);
  const showSource = signal(false);
  const lastSourcePath = signal("");
  const editor = signal<ArtifactEditorHandle | null>(null);
  const pdfViewer = signal<ArtifactPdfHandle | null>(null);
  /** The source editor's word on its buffer, which it compares with `diskText`. */
  const editorDirty = signal(false);
  const saving = signal(false);
  const saveError = signal(false);
  const saveConflict = signal(false);
  const pendingNav = signal<PendingNav>(null);
  const treePreferred = signal(loadArtifactTreeWidth());
  const treeDragging = signal(false);
  /** Phone only: the list opens as a sheet from the bottom, which stays put under the file. */
  const treeOpen = signal(false);
  const treeCollapsed = signal(new Set<string>());
  const treeExpanded = signal(new Set<string>());
  const paneWidth = signal(Number.POSITIVE_INFINITY);
  const stacked = () => narrowWindow();
  const treeWidth = computed(() => clampArtifactTreeWidth(treePreferred(), paneWidth()));

  // `kind` is read by the loader and the annotations before it is declared, as in the Svelte.
  let kindOf: () => ArtifactKind = () => "text";
  let byteSourceOf: () => ReturnType<typeof artifactByteSource> = () => null;
  let dirtyOf: () => boolean = () => false;
  let gateOf: () => ReturnType<typeof annotateGate> = () => annotateGate({ target: null, kind: "text", sourceMode: false, dirty: false });

  const loader = new ArtifactLoader({
    api,
    relpath,
    attachment,
    kind: () => kindOf(),
    byteSource: () => byteSourceOf(),
  });
  const annot = new ArtifactAnnotations({
    relpath,
    mode,
    target: () => props.target ?? null,
    annotations: () => props.annotations ?? [],
    annotationFocusId: () => props.annotationFocusId ?? null,
    annotationFileKey: () => props.annotationFileKey ?? null,
    workspacePath: () => props.workspacePath ?? null,
    viewedSessionId: () => props.viewedSessionId ?? null,
    onLoadAnnotations: () => props.onLoadAnnotations,
    onCreateAnnotation: () => props.onCreateAnnotation,
    onPatchAnnotation: () => props.onPatchAnnotation,
    onDeleteAnnotation: () => props.onDeleteAnnotation,
    onSendAnnotations: () => props.onSendAnnotations,
    t,
    gate: () => gateOf(),
    contentSha: () => loader.contentSha,
    kind: () => kindOf(),
    reducedFrom: () => loader.reducedFrom,
    loadOriginal: () => loader.loadOriginal(),
  });
  const treeSrc: ArtifactTreeSource = new ArtifactTreeSource({
    api,
    mode,
    taskId: () => props.taskId ?? null,
    siblings: () => props.siblings ?? [],
    workspacePath: () => props.workspacePath ?? null,
    relpath,
    dirty: () => dirtyOf(),
    t,
    onOpenTerminal: () => props.onOpenTerminal,
    showGone: () => loader.showGone(),
    projectDir: () => props.projectDir ?? null,
  });

  // A new listing starts the folders opened in the sheet over.
  effect(() => {
    void treeSrc.treeGeneration;
    untracked(() => {
      treeCollapsed.set(new Set());
      treeExpanded.set(new Set());
    });
  });
  // A project's file opens with the folders down to it open; after the reset above, which a new listing also runs.
  effect(() => {
    void treeSrc.treeGeneration;
    const dirs = treeSrc.revealDirs;
    untracked(() => {
      if (dirs.some((dir) => !treeExpanded().has(dir))) treeExpanded.set(new Set([...treeExpanded(), ...dirs]));
    });
  });

  const treeLabel = () =>
    mode() === "workspace" ? t().stream.workspaceExplorer : treeSrc.projectRoot !== null ? baseName(treeSrc.projectRoot) || treeSrc.projectRoot : t().stream.artifactTree;
  // A cited path the Mac listed is a folder too: a link can name one (`voice_samples/ja/`).
  const kind = computed<ArtifactKind>(() =>
    artifactKind(attachment()?.original_filename ?? relpath(), { isDir: attachment()?.is_dir === true || (mode() !== "workspace" && treeSrc.isDir(relpath())) }),
  );
  kindOf = kind;
  const showTree = () =>
    !props.noTree && (treeSrc.lazy || Boolean(props.forceTree) || Boolean(props.taskId) || treeSrc.tree.length > 1 || treeSrc.tree.some((node) => node.kind === "dir"));
  const titleName = () => attachment()?.original_filename ?? (relpath() ? (relpath().split("/").pop() ?? relpath()) : t().stream.workspaceExplorer);
  const canShowSource = () => kind() === "text" || kind() === "markdown" || kind() === "html";
  /** Too much text to render without holding the window: Markdown and HTML open as source, with no switch. */
  const renderTooLarge = () => loader.text !== null && tooLargeToRender(kind(), loader.text);
  const sourceMode = computed(() => kind() === "text" || (canShowSource() && (showSource() || renderTooLarge())));
  const byteSource = computed(() => artifactByteSource({ mode: mode(), relpath: relpath(), attachment: attachment() }));
  byteSourceOf = byteSource;
  const remoteClient = () => api()?.kind === "remote";
  /** A file shown only by name: the desktop window opens it with the system, anywhere else it downloads. */
  const opensOnDisk = () => !remoteClient() && isTauri();
  const canDownload = () =>
    remoteClient() && Boolean(relpath()) && kind() !== "directory" && isInAppPreviewKind(kind()) && attachment()?.exists !== false && !loader.missing;
  const downloadKey = () => `${byteSource()}:${attachment()?.id ?? ""}:${relpath()}`;
  /** A file opened from elsewhere on the Mac reads like any other, but saving and notes stay in the workspace. */
  const inWorkspace = () => citedInWorkspace(props.workspacePath ?? null, relpath(), treeSrc.home);
  const canSave = () =>
    Boolean(api() && relpath() && inWorkspace() && canShowSource() && loader.text !== null && loader.textEncoding === "utf-8" && (sourceMode() || loader.text !== loader.diskText));
  /** Unsaved: the editor's buffer in the source view, the text the rendered view shows otherwise. */
  const dirty = computed(() => (sourceMode() && editor() ? editorDirty() : loader.text !== null && loader.diskText !== null && loader.text !== loader.diskText));
  dirtyOf = dirty;
  const gate = computed(() => annotateGate({ target: mode() === "workspace" ? null : (props.target ?? null), kind: kind(), sourceMode: sourceMode(), dirty: dirty(), outside: !inWorkspace() }));
  gateOf = gate;
  const viewAdapter = () => adapterFor(kind(), sourceMode());
  const drawnRows = computed(() => drawnAnnotations(annot.fileAnnotations, { showResolved: annot.annotShowResolved, revealedId: annot.annotRevealedResolved }));
  const hasResolved = () => annot.fileAnnotations.some((row) => row.status === "resolved");
  const viewAnnotations = () => {
    const adapter = viewAdapter();
    return adapter ? drawnRows().filter((row) => row.anchor_kind === ADAPTER_ANCHOR_KIND[adapter]) : [];
  };
  const needsMode = () => {
    const a = viewAdapter();
    return a === "image" || a === "pdf" || a === "html";
  };
  const canToggleSource = () => kind() === "markdown" || kind() === "html";
  const showSourceToggle = () => canToggleSource() && loader.text !== null && !renderTooLarge();
  /** Why the text reads as it does: kept from editing for its encoding, or shown as source for its size. */
  const fileNotice = () => {
    if (!canShowSource() || loader.text === null) return null;
    const notes = [
      loader.textEncoding === "gb18030" ? t().stream.artifactReadGb18030 : loader.textEncoding === null ? t().stream.artifactReadUnknownEncoding : null,
      renderTooLarge() ? t().stream.artifactTooLargeToRender : null,
    ].filter((note) => note !== null);
    return notes.length > 0 ? notes.join(" ") : null;
  };
  const showAnnotToggle = () => {
    const g = gate();
    return mode() !== "workspace" && (annot.fileAnnotations.length > 0 || g.ok || (g.reason !== "kind" && g.reason !== "outside"));
  };
  const showAnnotMode = () => mode() !== "workspace" && needsMode() && gate().ok;
  const annotHint = (): "" | "dirty" | "no-target" | "streamed" | null => {
    const g = gate();
    if (mode() !== "workspace" && g.ok && g.adapter === "media" && loader.streamed && !loader.loading && loader.contentSha === null) return "streamed";
    if (mode() === "workspace" || !sourceMode() || loader.text === null) return null;
    if (g.ok) return "";
    return g.reason === "dirty" || g.reason === "no-target" ? g.reason : null;
  };

  loader.watchLoad();
  treeSrc.watchWorkspace();
  cleanup(() => {
    loader.destroy();
    treeSrc.destroy();
  });

  // Another file is a fresh start for the rendered/source switch.
  effect(() => {
    const path = relpath();
    if (path === untracked(lastSourcePath)) return;
    lastSourcePath.set(path);
    showSource.set(false);
  });

  /** Enlarges a picture over the app: this file when it is an image (`own`), or one in this Markdown. */
  function enlarge(image: string, own: boolean, _picture: unknown): void {
    // No element to grow from here: the picture opens fitted, with nothing to stand in for it.
    enlarged.set({ from: relpath(), relpath: image, own, origin: null, placeholder: null });
  }

  /** Opens this tree row with the system, or reveals it in Finder; a failure stays a quiet hint on the preview. */
  async function openOnDisk(path: string, reveal: boolean): Promise<void> {
    const abs = absWorkspacePath(props.workspacePath ?? null, path, treeSrc.home);
    if (!abs || remoteClient()) {
      loader.openHint = true;
      return;
    }
    const ok = await openWorkspacePath(abs, reveal);
    if (!ok) loader.openHint = true;
  }

  function commitSelect(node: ArtifactTreeNode): void {
    if (mode() === "workspace") {
      props.onSelectWorkspacePath?.(node.path);
      return;
    }
    const next = (props.siblings ?? []).find((row) => row.workspace_relpath === node.path);
    if (next) props.onSelect?.(next);
    else props.onSelect?.({ workspace_relpath: node.path } as Attachment);
  }

  function selectNode(node: ArtifactTreeNode): void {
    if (mode() === "workspace" && node.kind === "dir") return;
    // Picking a file is a request to look at it, so the list gets out of the way.
    if (node.kind !== "dir") treeOpen.set(false);
    if (dirty()) {
      pendingNav.set({ kind: "node", node });
      return;
    }
    commitSelect(node);
  }

  const openMarkdownPath = (path: string) => selectNode({ name: path.split("/").pop() ?? path, path, kind: "file" });

  function requestClose(afterClose?: () => void): void {
    if (saving()) return;
    if (dirty()) {
      // The file is not closing yet. `afterClose` runs only if this close goes through.
      pendingNav.set({ kind: "close", afterClose });
      return;
    }
    props.onClose();
    afterClose?.();
  }

  async function save(): Promise<boolean> {
    // Never while another file is loading or failed to: the buffer on screen is the last file's.
    const client = api();
    if (!client || !relpath() || !canSave() || loader.loading || loader.missing) return false;
    saving.set(true);
    saveError.set(false);
    saveConflict.set(false);
    try {
      const value = editor()?.getValue() ?? loader.text ?? "";
      loader.loadedEtag = await client.putWorkspaceFile(relpath(), value, loader.loadedEtag);
      loader.hashFresh = true;
      loader.text = value;
      loader.diskText = value;
      editor()?.markSaved(value);
      editorDirty.set(false);
      return true;
    } catch (error) {
      saveConflict.set(error instanceof ApiError && error.status === 409);
      saveError.set(true);
      if (error instanceof ApiError && error.code === "file_limit") loader.missing = true;
      return false;
    } finally {
      saving.set(false);
    }
  }

  const proceed = (nav: PendingNav) => {
    if (nav?.kind === "close") {
      props.onClose();
      nav.afterClose?.();
    } else if (nav?.kind === "node") commitSelect(nav.node);
    else if (nav?.kind === "leave") nav.after();
  };

  async function confirmSave(): Promise<void> {
    if (saving()) return;
    const nav = pendingNav();
    const ok = await save();
    if (!ok) return;
    pendingNav.set(null);
    proceed(nav);
  }

  function confirmDiscard(): void {
    const nav = pendingNav();
    pendingNav.set(null);
    // Back to the disk, not to `text`: that is the unsaved buffer when it came through the rendered view.
    const disk = loader.diskText ?? loader.text ?? "";
    loader.text = disk;
    editor()?.revert(disk);
    editorDirty.set(false);
    proceed(nav);
  }

  const closeFind = (): boolean => (editor()?.closeFind() ?? false) || (pdfViewer()?.closeFind() ?? false);

  props.ref?.({
    requestCloseFromParent: (afterClose) => requestClose(afterClose),
    /**
     * Another file is about to take this pane: an unsaved edit is asked about the way leaving it
     * from the tree is; `after` runs once it is saved or let go, never on cancel.
     */
    requestLeaveFromParent: (after) => {
      if (saving()) return;
      if (dirty()) {
        pendingNav.set({ kind: "leave", after });
        return;
      }
      after();
    },
    closeFind,
    /** True when closing would have to ask: an unsaved edit, or a save in flight. */
    blocksClose: () => saving() || dirty(),
  });
  cleanup(() => props.ref?.(null));

  function toggleSource(): void {
    // Leaving the source view carries an edit over to the rendered one: only an edit, not the model's own line-ending folding.
    const ed = editor();
    if (ed) loader.text = ed.isDirty() ? ed.getValue() : (loader.diskText ?? loader.text);
    // Picking elements belongs to the rendered page; the source is annotated by selecting lines.
    if (!showSource()) annot.annotMode = false;
    showSource.set(!showSource());
  }

  // An open list is the innermost thing Escape can close.
  effect(() => {
    if (!treeOpen()) return;
    return keymap.bind("escape", () => treeOpen.set(false), { when: "always" });
  });
  effect(() => {
    if (!canSave()) return;
    return keymap.bind("mod+s", () => void save(), { when: "always" });
  });
  effect(() => {
    if (kind() !== "pdf" || !pdfViewer()) return;
    return keymap.bind("mod+f", () => pdfViewer()?.openFind(), { when: "always" });
  });
  effect(() => {
    if (!sourceMode() || !editor()) return;
    return keymap.bind("mod+f", () => editor()?.openFind(), { when: "always" });
  });

  let originX = 0;
  let originW = 0;
  const splitPan = PanResponder.create({
    onStartShouldSetPanResponder: () => showTree(),
    onPanResponderGrant: () => {
      treeDragging.set(true);
      originX = 0;
      originW = treeWidth();
    },
    onPanResponderMove: (_e, g) => {
      treePreferred.set(clampArtifactTreeWidth(originW + g.dx + originX, paneWidth()));
    },
    onPanResponderRelease: () => {
      treeDragging.set(false);
      saveArtifactTreeWidth(treePreferred());
    },
    onPanResponderTerminate: () => {
      treeDragging.set(false);
      saveArtifactTreeWidth(treePreferred());
    },
    onPanResponderTerminationRequest: () => false,
  });

  const treeView = () => (
    <Each of={[treeSrc.treeGeneration]} key={(generation) => generation}>
      {() => (
        <ArtifactTree
          nodes={treeSrc.tree}
          selected={relpath()}
          label={treeLabel()}
          onSelect={selectNode}
          onContextMenu={(node, at, picked) => treeSrc.openTreeMenu(node, { clientX: at.x, clientY: at.y } as MouseEvent, picked)}
          onTrash={treeSrc.canTrash ? treeSrc.askTrash : undefined}
          dragLabel={t().stream.dragItems}
          lazyDirs={treeSrc.lazy}
          loadedDirs={treeSrc.loadedDirs}
          onExpandDir={(path) => void treeSrc.loadWorkspaceDir(path)}
          truncatedLabel={t().stream.workspaceTruncated}
          loadingDirs={treeSrc.loadingDirs}
          failedDirs={treeSrc.failedDirs}
          loading={treeSrc.lazy ? treeSrc.loadingDirs.has(".") : treeSrc.taskTreeLoading}
          failed={treeSrc.lazy ? treeSrc.failedDirs.has(".") : treeSrc.taskTreeFailed}
          loadingLabel={t().stream.artifactTreeLoading}
          failedLabel={t().stream.artifactTreeFailed}
          emptyLabel={treeSrc.lazy ? t().stream.workspaceEmpty : t().stream.artifactTreeEmpty}
          retryLabel={t().disconnected.retry}
          onRetry={() => {
            if (treeSrc.lazy) void treeSrc.loadWorkspaceDir(".");
            else treeSrc.taskTreeRetry += 1;
          }}
          collapsed={treeCollapsed()}
          onCollapsedChange={(next) => treeCollapsed.set(next)}
          expandedLazy={treeExpanded()}
          onExpandedLazyChange={(next) => treeExpanded.set(next)}
        />
      )}
    </Each>
  );

  const headerShown = () => narrowWindow() || props.sheet === true;
  const menu = () => treeSrc.treeMenu;

  return (
    <View
      role="region"
      testID="artifact-preview"
      accessibilityLabel={mode() === "workspace" ? t().stream.workspaceExplorer : t().stream.artifactPreview}
      class="flex-1 min-w-0 min-h-0 bg-pane"
      onLayout={(e) => paneWidth.set(e.bounds.size.width || Number.POSITIVE_INFINITY)}
    >
      {/* The desktop names and closes this pane on the workbench tab, so the bar is a phone's (or a sheet's). */}
      <If when={headerShown()}>
        <View testID="artifact-pane-head" class="flex-row items-stretch min-h-[64px] border-b border-line bg-pane">
          <View
            role="button"
            testID="artifact-back"
            accessibilityLabel={t().common.back}
            tooltip={tip(t().common.back)}
            onPress={() => requestClose()}
            class="w-[48px] items-center justify-center hover:bg-line-subtle"
          >
            <Icon name="chevron-left" size={20} class="tint-ink-secondary" />
          </View>
          <View class="flex-1 min-w-0 flex-row items-center self-center">
            <Text testID="artifact-title" class="shrink text-[16px] line-clamp-1 font-semibold text-ink">
              {titleName()}
            </Text>
            <If when={dirty()}>
              <Text testID="artifact-dirty-dot" class="ml-[6px] text-[16px] text-brand">
                •
              </Text>
            </If>
          </View>
          <If when={canDownload()}>
            <Each of={[downloadKey()]} key={(k) => k}>
              {() => (
                <View class="self-center">
                  <FileDownload
                    api={api()}
                    path={relpath()}
                    attachmentId={byteSource() === "attachment" ? (attachment()?.id ?? null) : null}
                    name={titleName()}
                    ready={loader.readyOriginal}
                    variant="icon"
                    size={48}
                    note={loader.downloadNote}
                    onNoteChange={(note) => {
                      loader.downloadNote = note;
                    }}
                  />
                </View>
              )}
            </Each>
          </If>
        </View>
      </If>
      <If when={saveError()}>
        <Text testID="artifact-save-error" class="px-8 pb-3 text-[13px] text-ink-muted">
          {saveConflict() ? t().stream.artifactSaveConflict : t().stream.artifactSaveFailed}
        </Text>
      </If>
      <If when={loader.downloadNote}>
        <Text testID="artifact-download-note" class="px-4 py-[6px] text-[12px] text-ink-muted border-b border-line">
          {loader.downloadNote === "tap" ? t().stream.imageSaveTapAgain : t().stream.artifactDownloadFailed}
        </Text>
      </If>
      <ArtifactAnnotBar
        api={api()}
        mode={mode()}
        relpath={relpath()}
        attachment={attachment()}
        byteSource={byteSource()}
        titleName={titleName()}
        downloadKey={downloadKey()}
        canDownload={canDownload()}
        showAnnotToggle={showAnnotToggle()}
        showAnnotMode={showAnnotMode()}
        annotHint={annotHint()}
        fileNotice={fileNotice()}
        showSourceToggle={showSourceToggle()}
        hasResolved={hasResolved()}
        showSource={showSource()}
        toggleSource={toggleSource}
        annot={annot}
        loader={loader}
        hideDownload={headerShown()}
      />
      <If when={showTree() && stacked()}>
        <View class="px-3 py-2 border-b border-line">
          <View
            role="button"
            testID="artifact-picker"
            accessibilityLabel={treeLabel()}
            accessibilityState={{ expanded: treeOpen() }}
            onPress={() => treeOpen.set(!treeOpen())}
            class={`flex-row items-center justify-between gap-2 min-h-[40px] px-3 border rounded-(--radius-md) ${treeOpen() ? "border-line-hover bg-chip" : "border-line bg-btn-secondary-bg"}`}
          >
            <Text class="shrink text-[13px] line-clamp-1 font-semibold text-ink">
              {treeLabel()}
            </Text>
            <Icon name="chevron-down" size={16} class="tint-ink-secondary" />
          </View>
        </View>
        <If when={treeOpen()}>
          <BottomSheet title={treeLabel()} closeLabel={t().common.close} onClose={() => treeOpen.set(false)}>
            <Scroll class="shrink min-h-0">{treeView()}</Scroll>
          </BottomSheet>
        </If>
      </If>
      <View class="flex-1 min-h-0 min-w-0 flex-row">
        <If when={showTree() && !stacked()}>
          <View testID="artifact-tree-column" class="min-h-0" style={{ width: treeWidth() }}>
            {treeView()}
          </View>
          <View class="w-px bg-line">
            <View
              role="button"
              testID="artifact-tree-split"
              accessibilityLabel={t().stream.artifactTreeResize}
              tooltip={tip(t().stream.artifactTreeResize)}
              {...splitPan.panHandlers}
              class={`absolute top-0 bottom-0 ${treeDragging() ? "bg-accent-border" : "hover:bg-accent-border"}`}
              style={{ left: -3, width: 7, cursor: "col-resize" }}
            />
          </View>
        </If>
        <ArtifactBody
          locale={props.locale ?? "zh"}
          bots={props.bots ?? new Map()}
          api={api()}
          relpath={relpath()}
          attachment={attachment()}
          mode={mode()}
          kind={kind()}
          sourceMode={sourceMode()}
          gate={gate()}
          wrap={wrap()}
          resolvedTheme={colorScheme() === "dark" ? "dark" : "light"}
          byteSource={byteSource()}
          titleName={titleName()}
          opensOnDisk={opensOnDisk()}
          drawnRows={drawnRows()}
          viewAnnotations={viewAnnotations()}
          annot={annot}
          loader={loader}
          treeSrc={treeSrc}
          dirEntries={kind() === "directory" && mode() !== "workspace" ? treeSrc.listingOf(relpath()) : null}
          onOpenEntry={selectNode}
          onEditor={(handle) => editor.set(handle)}
          onPdfViewer={(handle) => pdfViewer.set(handle)}
          onEditorDirty={(next) => editorDirty.set(next)}
          enlarge={enlarge}
          openMarkdownPath={openMarkdownPath}
          openOnDisk={openOnDisk}
          inWorkspace={inWorkspace()}
        />
      </View>
      <If when={mode() !== "workspace"}>
        <Each of={annot.annotDrafts.slice()} key={(group) => group.sessionId}>
          {(group) => (
            <AnnotationSendBar
              count={group().drafts.length}
              destination={destinationLabel(t(), group().sessionId, props.viewedSessionId ?? null, props.bots ?? new Map(), group().botIds, props.sessions ?? [])}
              sending={annot.sendBusy}
              error={annot.sendError}
              onSend={(summary) =>
                annot.sendDrafts(
                  group().sessionId,
                  summary,
                  group()
                    .drafts.slice(0, ANNOTATION_BATCH_MAX)
                    .map((row) => row.id),
                )
              }
              onClear={() => void annot.clearDrafts(group().drafts.map((row) => row.id))}
            />
          )}
        </Each>
      </If>
      <If when={menu()}>
        {() => (
          <ArtifactTreeMenu
            x={menu()?.x ?? 0}
            y={menu()?.y ?? 0}
            onOpen={() => void openOnDisk(menu()?.node.path ?? "", false)}
            onReveal={() => void openOnDisk(menu()?.node.path ?? "", true)}
            onOpenTerminal={treeSrc.treeMenuTerminalDir && props.onOpenTerminal ? () => props.onOpenTerminal?.(treeSrc.treeMenuTerminalDir!) : undefined}
            onCopyPath={treeSrc.treeMenuInWorkspace ? () => void Clipboard.writeText(menu()?.targets.map((node) => node.path).join("\n") ?? "").catch(() => {}) : undefined}
            onCopyAbsPath={treeSrc.treeMenuAbsPaths ? () => void Clipboard.writeText(treeSrc.treeMenuAbsPaths!).catch(() => {}) : undefined}
            count={menu()?.targets.length ?? 1}
            title={(menu()?.targets.length ?? 1) > 1 ? null : (menu()?.node.name ?? null)}
            onTrash={treeSrc.treeMenuCanTrash ? () => treeSrc.askTrash(menu()?.targets ?? []) : undefined}
            onClose={() => (treeSrc.treeMenu = null)}
          />
        )}
      </If>
      <If when={treeSrc.trashAsk && treeSrc.trashCopy}>
        <DangerDialog
          copy={treeSrc.trashCopy!}
          busy={treeSrc.trashAsk?.busy}
          onDismiss={() => (treeSrc.trashAsk = null)}
          onConfirm={() => void treeSrc.confirmTrash()}
        />
      </If>
      <If when={shownEnlarged()}>
        {(shown) => (
          <MessageImageLightbox
            attachment={shown().own ? attachment() : null}
            relpath={shown().relpath}
            src={shown().own ? loader.shownBlob : null}
            srcOriginalSize={shown().own ? loader.reducedFrom : null}
            placeholder={shown().placeholder}
            origin={shown().origin}
            api={api()}
            onClose={() => enlarged.set(null)}
          />
        )}
      </If>
      <If when={pendingNav()}>
        <ArtifactDirtyDialog saving={saving()} onCancel={() => pendingNav.set(null)} onDiscard={confirmDiscard} onSave={() => void confirmSave()} />
      </If>
    </View>
  );
}
