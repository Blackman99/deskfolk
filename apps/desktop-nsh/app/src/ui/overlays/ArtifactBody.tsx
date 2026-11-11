/**
 * The file on screen, by its kind (`ArtifactBody.svelte`): Markdown (`MarkdownAnnotator`), code
 * (`ArtifactCodeEditor`), pictures (`ImageAnnotator`), media (`MediaAnnotator`), HTML
 * (`HtmlAnnotator`, the one WebView), PDF (`PdfViewer`), Office (`OfficeViewer`), a cited folder's
 * page, and for any other file the download (`FileDownload`). Over it: the load progress, the
 * offer of a picture's original, the composer of the annotation being written; beside it
 * (below, in a narrow pane): the annotation list.
 *
 * Differences from the Svelte:
 * - `bind:editor` / `bind:pdfViewer` are `onEditor` / `onPdfViewer` (called with the handle).
 * - A picture and its SVG are shown from a `data:` URL: the loader's object URL (`shownBlob`) is
 *   read back into one, since NSH's `Image` takes no object URLs.
 * - `enlarge` hands the lightbox where the picture sits (it grows out of it) and what it shows
 *   there as a `data:` URL (the loader's object URL is nothing `Image` shows): the file's own
 *   picture, or a picture's chip in the Markdown, whose thumbnail the enlargement starts from.
 * - The PDF is fetched by the native module from `pdfSourceFor(relpath)` (a workspace file) or the
 *   attachment's content URL, both on the local runtime; a remote runtime gives no source.
 * - An Office file is read by path (a local workspace file) or from the loader's bytes as Base64.
 * - The composer sits at the top of the pane: `annot.composerTop` is measured from a DOM element
 *   (`bodyEl`) NSH does not have, so it is not followed.
 * - The pane's width query (`@container artifact-main`, 720) is the body's own measured width.
 */
import { cleanup, computed, effect, platform, Scroll, signal, Text, View } from "nsh";
import type { Annotation, Attachment } from "@real-bot/protocol";
import { describeAnchor } from "@real-bot/protocol";
import { formatFileSize } from "../../m/chat/attachments.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import type { annotateGate } from "../../m/annotations/model.ts";
import type { ArtifactAnnotations } from "../../m/overlays/artifact-annotations.svelte.ts";
import type { ArtifactLoader } from "../../m/overlays/artifact-loader.svelte.ts";
import type { ArtifactTreeNode } from "../../m/overlays/artifact-tree.ts";
import type { ArtifactTreeSource } from "../../m/overlays/artifact-tree-source.svelte.ts";
import { artifactByteSource, isInAppPreviewKind, isOfficeKind, type ArtifactKind } from "../../m/overlays/artifacts.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { copy, runtime } from "../../runtime";
import { base64, blobDataUrl } from "../data-url";
import { Icon } from "../Icon";
import { AnnotationComposer } from "../annotations/AnnotationComposer";
import { AnnotationList } from "../annotations/AnnotationList";
import { HtmlAnnotator } from "../annotations/HtmlAnnotator";
import { ImageAnnotator } from "../annotations/ImageAnnotator";
import { MarkdownAnnotator } from "../annotations/MarkdownAnnotator";
import { MediaAnnotator } from "../annotations/MediaAnnotator";
import { imageOrigin } from "../chat/image-origin";
import type { ImageOrigin } from "../chat/lightbox-fit";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { ArtifactCodeEditor, type ArtifactEditorHandle } from "./ArtifactCodeEditor";
import { FileDownload } from "./FileDownload";
import { FileIcon } from "./FileIcon";
import { OfficeViewer } from "./OfficeViewer";
import { PdfViewer, type PdfViewerHandle } from "./PdfViewer";
import { mediaSource } from "./media-source";
import { pdfSourceFor, type PdfSource } from "./pdf-pages";
import { settled } from "../workbench/drag-settle";

export type { ArtifactEditorHandle };
export type ArtifactPdfHandle = { openFind: () => void; closeFind: () => boolean };

/** The pane's narrow layout starts here (the Svelte's `@container artifact-main (max-width: 720px)`). */
const STACK_WIDTH = 720;

/** A loader URL as something `Image` shows: an object URL is read back into a `data:` URL. */
function dataUrlOf(url: () => string | null) {
  const shown = signal<string | null>(null);
  let gen = 0;
  effect(() => {
    const next = url();
    const mine = ++gen;
    if (!next || next.startsWith("data:")) {
      shown.set(next);
      return;
    }
    shown.set(null);
    void fetch(next)
      .then((response) => response.blob())
      .then(blobDataUrl)
      .then((data) => {
        if (mine === gen) shown.set(data);
      })
      .catch(() => {
        if (mine === gen) shown.set(next);
      });
  });
  return shown;
}

/** Why the list cannot take a note here, when it is about where the note would go. */
function noTargetOf(gate: { ok: boolean; reason?: string | null }): "no-target" | "no-agent-line" | null {
  return !gate.ok && (gate.reason === "no-target" || gate.reason === "no-agent-line") ? gate.reason : null;
}

export function ArtifactBody(props: {
  locale: "zh" | "en";
  bots: ReadonlyMap<string, { name: string }>;
  api: MessengerApi | null;
  relpath: string;
  attachment: Attachment | null;
  mode: "cited" | "workspace";
  kind: ArtifactKind;
  sourceMode: boolean;
  gate: ReturnType<typeof annotateGate>;
  wrap: boolean;
  resolvedTheme: "light" | "dark";
  byteSource: ReturnType<typeof artifactByteSource>;
  titleName: string;
  opensOnDisk: boolean;
  drawnRows: Annotation[];
  viewAnnotations: Annotation[];
  annot: ArtifactAnnotations;
  loader: ArtifactLoader;
  treeSrc: ArtifactTreeSource;
  onEditor?: (handle: ArtifactEditorHandle | null) => void;
  onPdfViewer?: (handle: ArtifactPdfHandle | null) => void;
  onEditorDirty: (next: boolean) => void;
  /**
   * Grows a picture in the lightbox: `origin` is where it grows from, `shown` what is on screen
   * there (the file's own picture, or a Markdown chip's thumbnail), a `data:` URL.
   */
  enlarge: (image: string, own: boolean, origin: ImageOrigin | null, shown: string | null) => void;
  openMarkdownPath: (path: string) => void;
  openOnDisk: (path: string, reveal: boolean) => Promise<void>;
  /** A cited folder's entries, once the Mac listed it; the folder's page lists them. */
  dirEntries?: ArtifactTreeNode[] | null;
  onOpenEntry?: (node: ArtifactTreeNode) => void;
  /** Whether this file can be saved from here (the workspace's, or a project session's); one elsewhere on the Mac is only read. */
  writable?: boolean;
}) {
  const t = () => copy().stream;
  const loader = () => props.loader;
  const annot = () => props.annot;
  const gate = () => {
    const g = props.gate;
    return { ok: g.ok, adapter: g.ok ? g.adapter : null, reason: g.ok ? null : g.reason };
  };
  const width = signal(0);
  const stacked = settled(() => width() > 0 && width() <= STACK_WIDTH);
  const annotsOpen = () => annot().annotOpen && props.mode !== "workspace";
  const editing = () => props.sourceMode && loader().text !== null;
  /**
   * What makes the body (`body()`, a tracked insert) again: the workspace's empty state, and in the
   * workspace another file of a kind not shown as source, as reading the path there always did.
   * Another file in the source editor keeps the editor, which takes the file once its text has
   * arrived (`textPath`): made again on the pick, it held the last file's text under the new name
   * and was made once more when the text came.
   */
  const noFile = computed(() => props.mode === "workspace" && !props.relpath);
  const bodyPath = computed(() => (props.mode === "workspace" && !props.sourceMode ? props.relpath : null));
  // A picture's bytes only: any other file's (a video, a PDF) were read into a `data:` URL too, the
  // whole file Base64'd on the JS thread, and the window hung for a minute on a 100 MB video.
  const picture = dataUrlOf(() => (props.kind === "image" || props.kind === "svg" ? loader().shownBlob : null));

  /** An Office file's bytes as Base64, when it is not a local workspace file the viewer can read by path. */
  const officeBase64 = signal<string | null>(null);
  let officeGen = 0;
  const officeByPath = () => props.byteSource !== "attachment" && props.api?.kind === "local";
  effect(() => {
    const blob = loader().shownOffice;
    const mine = ++officeGen;
    if (!blob || officeByPath()) {
      officeBase64.set(null);
      return;
    }
    void blob.arrayBuffer().then((bytes) => {
      if (mine === officeGen) officeBase64.set(base64(new Uint8Array(bytes)));
    });
  });

  /** Where the native PDF module reads from: the workspace file, or the attachment's content. */
  const pdfSource = (): PdfSource | null => {
    const client = runtime.client;
    if (props.byteSource === "attachment" && props.attachment) {
      if (!client || client.kind !== "local") return null;
      return { url: `${client.endpoint.origin}/v1/attachments/${props.attachment.id}/content`, token: client.endpoint.token };
    }
    return pdfSourceFor(props.relpath);
  };

  cleanup(() => {
    props.onEditor?.(null);
    props.onPdfViewer?.(null);
  });

  const muted = (text: () => string, testID?: string) => (
    <Text testID={testID} class="text-[13px] text-ink-muted">
      {text()}
    </Text>
  );

  /** What fills the pane for the cases that scroll as text (the Svelte's `<p class="muted">` and lists). */
  const scrolling = (content: () => unknown) => <Scroll class="flex-1 min-h-0 p-4">{content() as never}</Scroll>;

  const unsupported = () => (
    <View class="items-center gap-2 px-4 py-12">
      <Text testID="artifact-unsupported-name" class="max-w-full text-[14px] font-semibold text-ink text-center">
        {props.titleName}
      </Text>
      <Text class="text-[13px] text-ink-muted text-center">
        {props.attachment?.exists === false ? t().artifactMissing : t().artifactUnsupported}
      </Text>
      <If when={props.attachment?.exists !== false}>
        <If
          when={props.opensOnDisk}
          else={
            <Each of={[`${props.byteSource}:${props.attachment?.id ?? ""}:${props.relpath}`]}>
              {() => (
                <FileDownload
                  api={props.api}
                  path={props.relpath}
                  attachmentId={props.byteSource === "attachment" ? (props.attachment?.id ?? null) : null}
                  name={props.titleName}
                />
              )}
            </Each>
          }
        >
          <View
            role="button"
            testID="artifact-unsupported-open"
            onPress={() => void props.openOnDisk(props.relpath, false)}
            class="cursor-pointer select-none mt-[6px] h-[32px] px-4 items-center justify-center border border-accent-border rounded-full bg-accent-tint hover:border-brand"
          >
            <Text class="text-[13px] font-semibold text-brand">{t().artifactOpenSystem}</Text>
          </View>
        </If>
      </If>
    </View>
  );

  /** One body per kind, in the Svelte's order. */
  const body = () => {
    if (loader().missing) return scrolling(() => muted(() => t().artifactMissing));
    void bodyPath();
    if (noFile()) return scrolling(() => muted(() => t().workspacePickFile));
    if (props.kind === "directory") {
      return scrolling(() => (
        <If when={props.dirEntries && props.dirEntries.length > 0} else={muted(() => (props.mode === "workspace" ? t().workspaceEmpty : t().artifactDirectory))}>
          <View role="list" accessibilityLabel={props.titleName} class="gap-[2px] max-w-[640px]">
            <Each of={(props.dirEntries ?? []).slice()} key={(entry: ArtifactTreeNode) => entry.path}>
              {(entry: () => ArtifactTreeNode) => (
                <View
                  role="button"
                  testID="artifact-dir-entry"
                  onPress={() => props.onOpenEntry?.(entry())}
                  class="cursor-pointer select-none flex-row items-center gap-[10px] w-full min-h-[36px] px-[10px] py-[6px] rounded-(--radius-md) hover:bg-row-hover"
                >
                  <FileIcon icon={fileIconFor(entry().path, { isDir: entry().kind === "dir" })} />
                  <Text class="flex-1 min-w-0 text-[13px] text-ink line-clamp-1">{entry().name}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
      ));
    }
    if (props.sourceMode) {
      return (
        <If when={loader().text !== null}>
          <ArtifactCodeEditor
            code={loader().text ?? ""}
            baseline={loader().diskText}
            path={loader().textPath ?? props.relpath}
            wrap={props.wrap}
            onDirty={props.onEditorDirty}
            annotations={props.drawnRows}
            focusAnnotationId={annot().annotFocus}
            focusAnnotationSeq={annot().annotFocusSeq}
            annotateEnabled={gate().ok && gate().adapter === "text" && !annot().pendingDraft}
            annotateLabel={t().annotationAdd}
            onAnnotate={annot().offerAnnotation}
            onPickAnnotation={annot().pickAnnotation}
            readOnly={props.writable === false || loader().textEncoding !== "utf-8"}
            handle={(handle) => props.onEditor?.(handle)}
          />
        </If>
      );
    }
    if (props.kind === "image" || props.kind === "svg") {
      return (
        <If when={loader().shownBlob && picture() !== null}>
          <ImageAnnotator
            src={picture() ?? ""}
            alt={props.relpath}
            isSvg={props.kind === "svg"}
            svgText={loader().svgRaw}
            annotations={props.viewAnnotations}
            focusId={annot().annotFocus}
            focusSeq={annot().annotFocusSeq}
            active={annot().annotMode}
            enabled={gate().ok && gate().adapter === "image" && !annot().pendingDraft && loader().reducedFrom === null}
            labels={t().annotImage}
            onDraft={(draft) => annot().offerDraft("image_region", draft.anchor, draft.crop)}
            onPick={annot().pickAnnotation}
            pending={annot().pendingOf("image_region")}
            onPendingChange={annot().movePending}
            onCancel={annot().escapeAnnotation}
            openLabel={`${t().artifactEnlarge} ${props.relpath.split("/").pop() ?? props.relpath}`}
            onOpen={(from) => {
              const shown = picture();
              void imageOrigin(from).then((origin) => props.enlarge(props.relpath, true, origin, shown));
            }}
          />
        </If>
      );
    }
    if ((props.kind === "audio" || props.kind === "video") && loader().shownBlob) {
      return (
        <MediaAnnotator
          src={mediaSource({
            web: platform.os === "web",
            local: props.api?.kind === "local",
            relpath: props.relpath,
            workspaceRoot: runtime.snapshot.settings.workspace_path,
            blobUrl: loader().shownBlob,
          })}
          kind={props.kind as "audio" | "video"}
          annotations={props.viewAnnotations}
          focusId={annot().annotFocus}
          focusSeq={annot().annotFocusSeq}
          enabled={gate().ok && gate().adapter === "media" && !annot().pendingDraft && loader().contentSha !== null}
          labels={t().annotMedia}
          onDraft={(draft) => annot().offerDraft("media_time", draft.anchor, draft.crop)}
          onPick={annot().pickAnnotation}
          pending={annot().pendingOf("media_time")}
          onPendingChange={annot().movePending}
          onCancel={annot().escapeAnnotation}
          onError={() => {
            loader().missing = true;
            loader().loadAbort?.abort();
          }}
        />
      );
    }
    if (isOfficeKind(props.kind)) {
      return (
        <If when={loader().shownOffice && !loader().loading && (officeByPath() || officeBase64() !== null)}>
          <OfficeViewer
            kind={props.kind as "word" | "spreadsheet" | "presentation"}
            title={props.relpath}
            {...(officeByPath() ? { path: props.relpath } : { base64: officeBase64() ?? "" })}
          />
        </If>
      );
    }
    if (props.kind === "pdf" && loader().shownPdf) {
      return (
        <PdfViewer
          source={pdfSource()}
          theme={props.resolvedTheme}
          annotations={props.viewAnnotations}
          focusId={annot().annotFocus}
          focusSeq={annot().annotFocusSeq}
          active={annot().annotMode}
          enabled={gate().ok && gate().adapter === "pdf" && !annot().pendingDraft}
          onDraft={(draft) => annot().offerDraft("pdf_region", draft.anchor, draft.crop)}
          onPick={annot().pickAnnotation}
          pending={annot().pendingOf("pdf_region")}
          onPendingChange={annot().movePending}
          onCancel={annot().escapeAnnotation}
          onHandle={(handle: PdfViewerHandle) =>
            props.onPdfViewer?.({
              openFind: handle.openFind,
              closeFind: handle.closeFind,
            })
          }
        />
      );
    }
    if (props.kind === "html" && loader().text !== null) {
      return (
        <HtmlAnnotator
          html={loader().text ?? ""}
          scheme={props.resolvedTheme}
          title={props.relpath}
          annotations={props.viewAnnotations}
          focusId={annot().annotFocus}
          focusSeq={annot().annotFocusSeq}
          active={annot().annotMode && gate().ok && gate().adapter === "html"}
          enabled={gate().ok && gate().adapter === "html" && (!annot().pendingDraft || annot().pendingDraft?.kind === "html_element")}
          labels={t().annotHtml}
          onDraft={(draft) => annot().offerDraft("html_element", draft.anchor)}
          onPick={annot().goToAnnotation}
          pending={annot().pendingOf("html_element")}
          onPendingChange={annot().movePending}
          onCancel={annot().escapeAnnotation}
        />
      );
    }
    if (props.kind === "markdown" && loader().text !== null) {
      return scrolling(() => (
        <MarkdownAnnotator
          source={loader().text ?? ""}
          annotations={props.viewAnnotations}
          focusId={annot().annotFocus}
          focusSeq={annot().annotFocusSeq}
          active={gate().ok && gate().adapter === "markdown"}
          enabled={gate().ok && gate().adapter === "markdown" && !annot().pendingDraft}
          labels={t().annotMarkdown}
          onDraft={(draft) => annot().offerDraft("text_range", draft.anchor)}
          onPick={annot().pickAnnotation}
          pending={annot().pendingOf("text_range")}
          onCancel={annot().escapeAnnotation}
          copyLabel={copy().chat.copyCode}
          copiedLabel={copy().chat.copied}
          onOpenArtifact={props.openMarkdownPath}
          onOpenImage={(path, from) => void imageOrigin(from?.view).then((origin) => props.enlarge(path, false, origin, from?.shown ?? null))}
          loadArtifactImage={(path, signal) => {
            if (!props.api) return Promise.reject(new Error("API unavailable"));
            // A picture inside a note is a 72 px chip: the 256 px copy is plenty, and tapping it
            // enlarges to the 1600 px copy with the original on offer.
            return props.api.getWorkspaceFileBlob(path, undefined, { size: "thumb", signal });
          }}
        />
      ));
    }
    if (!isInAppPreviewKind(props.kind)) return scrolling(unsupported);
    return scrolling(() => muted(() => props.attachment?.original_filename ?? props.relpath));
  };

  const loadingOverlay = () => (
    <View testID="artifact-loading" role="text" class="absolute inset-0 z-[3] items-center justify-center gap-[10px] p-6 bg-pane/90">
      <Icon name="spinner" size={32} class="animate-spin tint-brand" />
      <Text class="text-[13px] font-semibold text-ink">{t().artifactLoading}</Text>
      <If when={loader().loadBytes}>
        <Text testID="artifact-loading-bytes" class="font-mono text-[12px] text-ink-muted">{loader().loadBytes ?? ""}</Text>
      </If>
      <View
        role="progressbar"
        accessibilityLabel={t().artifactLoading}
        class="w-[220px] max-w-[70%] h-[5px] rounded-full bg-line-subtle overflow-hidden"
      >
        <View class="h-full rounded-full bg-brand" style={{ width: `${loader().loadPercent ?? 40}%` }} />
      </View>
    </View>
  );

  return (
    <View onLayout={(e) => width.set(e.bounds.size.width)} class={`flex-1 min-h-0 min-w-0 ${stacked() ? "" : "flex-row"}`}>
      <View
        testID="artifact-pane-body"
        class={`relative min-h-0 min-w-0 overflow-hidden ${stacked() && annotsOpen() ? "flex-[1_1_55%]" : "flex-1"}`}
      >
        <If when={props.kind === "image" && loader().shownBlob && !loader().loading && loader().reducedFrom !== null}>
          <View
            role="button"
            testID="artifact-original-toggle"
            accessibilityState={{ busy: loader().originalProgress !== null, disabled: loader().originalProgress !== null }}
            disabled={loader().originalProgress !== null}
            onPress={() => void loader().loadOriginal()}
            style={{ boxShadow: shadow("xs") }}
            class={`cursor-pointer select-none disabled:cursor-default absolute top-3 self-center z-[4] flex-row items-center gap-[5px] px-[10px] pl-2 rounded-full border border-line bg-pane/90 hover:border-accent-border hover:bg-accent-tint ${narrowWindow() ? "h-[36px]" : "h-[28px]"}`}
          >
            <Icon name="image" size={16} class="tint-ink-secondary" />
            <Text class="text-[12px] font-semibold text-ink-secondary">
              {loader().originalProgress ? t().imageOriginalLoading(loader().originalBytes) : t().imageOriginal(formatFileSize(loader().reducedFrom ?? 0))}
            </Text>
          </View>
        </If>
        <View class={`flex-1 min-h-0 ${editing() ? "" : narrowWindow() ? "p-3" : "p-4"}`}>
          <If when={loader().loadingLong}>{loadingOverlay()}</If>
          <If when={props.treeSrc.truncatedHint && props.mode === "workspace"}>{muted(() => t().workspaceTruncated)}</If>
          {() => body()}
          <If when={loader().openHint}>{muted(() => t().artifactOpenUnavailable)}</If>
        </View>
        {/* Pinned to the frame, over the file: it stays in view while the file scrolls under it. */}
        <If when={annot().pendingDraft}>
          <View class={`absolute z-[6] ${narrowWindow() ? "top-2 right-2 left-2" : "top-3 right-3"}`}>
            <AnnotationComposer
              position={describeAnchor(annot().pendingDraft!.kind, annot().pendingDraft!.anchor, props.locale)}
              busy={annot().annotBusy}
              error={annot().annotError}
              onSave={(text) => void annot().saveDraft(text)}
              onCancel={annot().cancelDraft}
            />
          </View>
        </If>
      </View>
      <If when={annotsOpen()}>
        <View
          testID="artifact-annot-col"
          class={`shrink-0 min-h-0 ${stacked() ? "border-t border-line" : ""}`}
          style={stacked() ? { height: "45%", maxHeight: "45%" } : { width: Math.min(320, width() * 0.45) }}
        >
          <AnnotationList
            annotations={annot().fileAnnotations}
            locale={props.locale}
            bots={props.bots}
            focusId={annot().annotFocus}
            busy={annot().annotBusy}
            error={annot().annotError}
            onReveal={annot().revealAnnotation}
            onEdit={(row, text) => void annot().editDraft(row, text)}
            onDelete={(row) => void annot().deleteDraft(row)}
            onToggleStatus={(row, status) => void annot().toggleAnnotation(row, status)}
            onClose={() => {
              annot().annotOpen = false;
            }}
            noTarget={noTargetOf(gate())}
          />
        </View>
      </If>
    </View>
  );
}
