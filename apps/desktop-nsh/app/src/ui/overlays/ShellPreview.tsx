/**
 * The shell's artifact preview (`ShellPreview.svelte`): a column beside the conversation on the
 * workbench, with the handle that drags its width, and a sheet over the conversation everywhere
 * else. What it shows and the actions on it are `ShellArtifact`'s.
 *
 * `ArtifactPreview` (a later job) mounts where the Svelte lazy-loads it: `children` is a render
 * function given every prop the Svelte passes it (`ArtifactPreviewProps`, with getters, so reading
 * one inside the preview follows the runtime) and `ref`, which the preview calls with its pane
 * handle; `onPane` hands that handle to the shell (the Svelte's `bind:previewPane`).
 *
 * The width handle is a PanResponder here: `artifact.startPreviewResize` listens to DOM pointer
 * events on `window`, so the same drag (width = width at the press − distance, clamped, saved on
 * release) is written against the responder.
 */
import { PanResponder, View, windowSize, type JSX } from "nsh";
import type { Attachment, SessionSummary } from "@real-bot/protocol";
import type { Annotation } from "@real-bot/protocol";
import { projectDirOf } from "../../m/overlays/artifact-lookup.ts";
import { clampPreviewWidth, savePreviewWidth } from "../../m/overlays/preview-width.ts";
import type { ShellArtifact } from "../../m/overlays/shell-artifact.svelte.ts";
import { copy, runtime } from "../../runtime";
import { tip } from "../tip";

/** What the shell asks of an open preview before it leaves: both panes can ask first. */
export type ArtifactPane = {
  requestCloseFromParent: (afterClose?: () => void) => void;
  requestLeaveFromParent?: (after: () => void) => void;
  closeFind: () => boolean;
  blocksClose: () => boolean;
};

type Preview = NonNullable<ShellArtifact["artifactPreview"]>;

/** The props the Svelte gives `ArtifactPreview` (no `runtime` and `t`: components read those themselves). */
export type ArtifactPreviewProps = {
  attachment: Attachment | null;
  relpath: string;
  siblings: Attachment[];
  api: typeof runtime.client;
  workspacePath: string | null | undefined;
  forceTree: boolean;
  taskId: string | null;
  projectDir: string | null;
  target: Preview["target"];
  /** A sheet over the conversation (not the workbench's column). */
  sheet: boolean;
  annotations: Annotation[];
  annotationFocusId: string | null;
  annotationFileKey: string | null;
  bots: ReadonlyMap<string, { name: string }>;
  locale: "zh" | "en";
  sessions: SessionSummary[];
  viewedSessionId: string | null;
  onLoadAnnotations: (path: string) => void;
  onCreateAnnotation: (input: Parameters<typeof runtime.createAnnotation>[0]) => ReturnType<typeof runtime.createAnnotation>;
  onPatchAnnotation: (id: string, patch: Parameters<typeof runtime.patchAnnotation>[1]) => ReturnType<typeof runtime.patchAnnotation>;
  onDeleteAnnotation: (id: string) => ReturnType<typeof runtime.deleteAnnotation>;
  onSendAnnotations: (sessionId: string, summary: string, ids: string[]) => ReturnType<typeof runtime.sendAnnotations>;
  onOpenTerminal: (dir: string) => void;
  onClose: () => void;
  onSelect: (attachment: Attachment) => void;
  onSelectWorkspacePath: (path: string) => void;
  /** The preview calls this with its pane handle once it is up. */
  ref: (pane: ArtifactPane | null) => void;
};

export function ShellPreview(props: {
  /** The workbench's column (true) or a sheet over the conversation. */
  wide: boolean;
  locale: "zh" | "en";
  botsById: ReadonlyMap<string, { name: string }>;
  artifact: ShellArtifact;
  /** Mounts `ArtifactPreview`. */
  children: (preview: ArtifactPreviewProps) => JSX.Element;
  /** The shell's `bind:previewPane`. */
  onPane?: (pane: ArtifactPane | null) => void;
  /** The shell's width, for clamping the column (default: the window's). */
  shellWidth?: () => number;
}) {
  const artifact = () => props.artifact;
  const snapshot = () => runtime.snapshot;
  let originWidth = 0;

  const resizePan = PanResponder.create({
    onStartShouldSetPanResponder: () => props.wide && artifact().artifactPreview !== null,
    onPanResponderGrant: () => {
      originWidth = artifact().previewWidth;
      artifact().previewDragging = true;
    },
    onPanResponderMove: (_e, g) => {
      artifact().previewPreferred = clampPreviewWidth(originWidth - g.dx, props.shellWidth?.() ?? windowSize().width);
    },
    onPanResponderRelease: () => {
      artifact().previewDragging = false;
      savePreviewWidth(artifact().previewPreferred);
    },
    onPanResponderTerminate: () => {
      artifact().previewDragging = false;
      savePreviewWidth(artifact().previewPreferred);
    },
    onPanResponderTerminationRequest: () => false,
  });

  const open = (path: string) =>
    artifact().openArtifactPath(path, undefined, runtime.previewMessageId, runtime.forceArtifactTree, runtime.previewTaskId, runtime.previewSiblings);

  /** Every prop of the preview, read from the runtime where it is used. */
  const previewProps = (preview: () => Preview): ArtifactPreviewProps => ({
    get attachment() {
      return preview().attachment;
    },
    get relpath() {
      return preview().relpath;
    },
    get siblings() {
      return preview().siblings;
    },
    get api() {
      return runtime.client;
    },
    get workspacePath() {
      return snapshot().settings.workspace_path;
    },
    get forceTree() {
      return preview().forceTree;
    },
    get taskId() {
      return preview().taskId;
    },
    get projectDir() {
      return projectDirOf(snapshot().sessions, runtime.selectedId);
    },
    get target() {
      return preview().target;
    },
    get sheet() {
      return !props.wide;
    },
    get annotations() {
      return snapshot().annotations;
    },
    get annotationFocusId() {
      return runtime.annotationFocusId;
    },
    get annotationFileKey() {
      return runtime.annotationFileKeys[preview().relpath] ?? null;
    },
    get bots() {
      return props.botsById;
    },
    get locale() {
      return props.locale;
    },
    get sessions() {
      return snapshot().sessions;
    },
    get viewedSessionId() {
      return runtime.selectedId;
    },
    onLoadAnnotations: (path) => void runtime.loadAnnotations({ relpath: path }),
    onCreateAnnotation: (input) => runtime.createAnnotation(input),
    onPatchAnnotation: (id, patch) => runtime.patchAnnotation(id, patch),
    onDeleteAnnotation: (id) => runtime.deleteAnnotation(id),
    onSendAnnotations: (sessionId, summary, ids) => runtime.sendAnnotations(sessionId, summary, ids),
    onOpenTerminal: (dir) => artifact().openTerminalFromPreview(dir),
    onClose: () => artifact().closeArtifactPreview(),
    onSelect: (att) => open(att.workspace_relpath),
    onSelectWorkspacePath: open,
    ref: (pane) => props.onPane?.(pane),
  });

  return (
    <If when={artifact().artifactPreview}>
      {(preview: () => Preview) => (
        <>
          <If when={props.wide}>
            <View class="w-px bg-line" style={{ cursor: "col-resize" }}>
              <View
                role="button"
                testID="preview-split"
                accessibilityLabel={copy().stream.artifactResize}
                tooltip={tip(copy().stream.artifactResize)}
                {...resizePan.panHandlers}
                class={`absolute top-0 bottom-0 ${artifact().previewDragging ? "bg-accent-border" : "hover:bg-accent-border"}`}
                style={{ left: -3, width: 7, cursor: "col-resize" }}
              />
            </View>
          </If>
          {props.children(previewProps(preview))}
        </>
      )}
    </If>
  );
}
