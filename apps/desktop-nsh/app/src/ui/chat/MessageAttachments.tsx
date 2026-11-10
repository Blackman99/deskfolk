/**
 * The files a message carries (`MessageAttachments.svelte`): a chip for each, a picture's with its
 * thumbnail, the whole lot as one bundle entry when there are several (or, on the app's own cards,
 * the first few chips and then the bundle). A picture opens enlarged in the app (`onOpenImage`,
 * handed the chip's thumbnail to grow out of and to start from; its chip has the magnifier), another
 * file over the whole app (`onOpenFile`), anything else in the preview (`onPreview`).
 *
 * A chip asks for the Mac's 256 px copy as soon as it is drawn: the Svelte one waited until the chip
 * scrolled near (`whenVisible`, an IntersectionObserver); a message's few chips are cheap, and a
 * folder of pictures is a bundle that fetches nothing until opened.
 */
import { cleanup, Image, signal, Text, untracked, View, type ViewRef } from "nsh";
import type { Attachment } from "@real-bot/protocol";
import { artifactKind, handedOverPaths, isInlineImageName, svgDisplayBlob } from "../../m/overlays/artifacts.ts";
import { buildCitedPathTree, citedBundleName, countCitedFiles } from "../../m/overlays/artifact-tree.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { ImageContextMenu } from "../ImageContextMenu";
import { blobDataUrl } from "../data-url";
import { FileIcon } from "../overlays/FileIcon";
import type { PressedPicture } from "./image-origin";

/** How many files an app card shows as chips; the entry after them opens every one. */
const CARD_CHIPS = 5;

export function MessageAttachments(props: {
  attachments: Attachment[];
  /** Message body, so a bare `附件：<path>` line still becomes a chip on messages stored earlier. */
  body?: string | null;
  api: MessengerApi | null;
  onPreview: (att: Attachment) => void;
  /** A picture stays in the app. `from` is the chip's thumbnail, which the enlargement grows out of. */
  onOpenImage?: (att: Attachment, from?: PressedPicture) => void;
  /** Any other file opened from its own chip, over the whole app the way a picture is. */
  onOpenFile?: (att: Attachment) => void;
  /** The app's own cards: the first few files each a chip, and after them the entry to all of them. */
  cards?: boolean;
}) {
  const thumbs = signal<Record<string, string>>({});
  const missing = signal<Record<string, true>>({});
  /** Picture chips whose bytes are still on the way. A file icon is not a picture loading. */
  const pendingThumbs = signal<Record<string, true>>({});
  const menu = signal<{ src: string; x: number; y: number } | null>(null);

  function withHandoffRows(stored: Attachment[], source: string | null): Attachment[] {
    const paths = handedOverPaths(source ?? "", stored.map((row) => row.workspace_relpath));
    return paths.map((path) => {
      const existing = stored.find((row) => row.workspace_relpath === path);
      if (existing) return existing;
      const owner = stored[0];
      return {
        id: `handoff:${path}`,
        message_id: owner?.message_id ?? "",
        workspace_relpath: path,
        original_filename: path.split("/").pop() || path,
        created_at: owner?.created_at ?? "",
        exists: missing()[path] ? false : undefined,
      };
    });
  }

  const rows = () => withHandoffRows(props.attachments, props.body ?? null);
  const tree = () => buildCitedPathTree(rows().map((row) => row.workspace_relpath));
  const fileCount = () => countCitedFiles(tree());
  const bundle = () => citedBundleName(tree());
  const collapse = () => !props.cards && rows().length > 1;
  const chips = () => (props.cards ? rows().slice(0, CARD_CHIPS) : rows());

  /** Ids already requested. Clearing the spinner writes state, and that must not fetch again. */
  const started = new Set<string>();
  const thumbLoads = new AbortController();
  cleanup(() => thumbLoads.abort());

  async function loadThumb(att: Attachment): Promise<void> {
    const api = props.api;
    if (!api || started.has(att.id)) return;
    const kind = artifactKind(att.original_filename, { isDir: att.is_dir });
    if ((kind !== "image" && kind !== "svg") || att.exists === false || att.is_dir) return;
    started.add(att.id);
    pendingThumbs.set({ ...pendingThumbs(), [att.id]: true });
    const options = { background: true, signal: thumbLoads.signal, size: "thumb" as const };
    try {
      const blob = att.id.startsWith("handoff:")
        ? await api.getWorkspaceFileBlob(att.workspace_relpath, undefined, options)
        : await api.getAttachmentBlob(att.id, undefined, options);
      const thumb = kind === "svg" ? await svgDisplayBlob(blob) : blob;
      const url = await blobDataUrl(thumb);
      if (thumbLoads.signal.aborted) return;
      thumbs.set({ ...thumbs(), [att.id]: url });
    } catch {
      if (thumbLoads.signal.aborted) return;
      if (att.id.startsWith("handoff:")) missing.set({ ...missing(), [att.workspace_relpath]: true });
    } finally {
      if (pendingThumbs()[att.id]) {
        const next = { ...pendingThumbs() };
        delete next[att.id];
        pendingThumbs.set(next);
      }
    }
  }

  function firstPreviewable(list: Attachment[]): Attachment {
    return list.find((row) => row.exists !== false && !row.is_dir) ?? list.find((row) => row.exists !== false) ?? list[0]!;
  }

  /** A bundle is several files, so it opens the preview with its tree even when all are pictures. */
  function openBundle(): void {
    const list = rows();
    if (list.length > 0) props.onPreview(firstPreviewable(list));
  }

  /** The chip opens its picture enlarged (the rest open as files). */
  const enlarges = (att: Attachment) => Boolean(props.onOpenImage) && isInlineImageName(att.original_filename, { isDir: att.is_dir });

  function openRow(att: Attachment, from: PressedPicture): void {
    if (enlarges(att)) {
      props.onOpenImage!(att, from);
      return;
    }
    if (props.onOpenFile && !att.is_dir) {
      props.onOpenFile(att);
      return;
    }
    props.onPreview(att);
  }

  const Bundle = () => (
    <View
      role="button"
      testID="attachment-bundle"
      accessibilityLabel={rows().map((row) => row.workspace_relpath).join("\n")}
      onPress={openBundle}
      class="cursor-pointer select-none mt-4 flex-row items-center gap-2 px-3 py-2 bg-pane border border-line hover:border-brand rounded-(--radius-md) max-w-[280px]"
    >
      <Icon name="folder" size={20} class="tint-brand" />
      <View class="min-w-0 max-w-[170px]">
        <Text class="text-[12px] font-semibold text-ink line-clamp-1">{bundle() ?? copy().stream.artifactBundle}</Text>
        <Text class="text-[10px] text-ink-muted line-clamp-1">{copy().stream.artifactBundleCount(fileCount())}</Text>
      </View>
    </View>
  );

  function Chip(chip: { att: Attachment }) {
    let node: ViewRef | null = null;
    /** The thumbnail, or its spinner while it comes: the enlargement grows out of it, as the Svelte's grows out of the `img`. */
    let picture: ViewRef | null = null;
    const att = () => chip.att;
    // A picture is fetched once its chip is drawn.
    untracked(() => void loadThumb(att()));
    const thumb = () => thumbs()[att().id];
    const pending = () => !thumb() && pendingThumbs()[att().id] === true;
    return (
      <View
        ref={(n: ViewRef) => (node = n)}
        role="button"
        testID="attachment-chip"
        accessibilityLabel={att().workspace_relpath}
        accessibilityState={{ busy: pending() }}
        onPress={() => openRow(att(), { view: thumb() || pending() ? picture : node, shown: thumb() ?? null })}
        class={`${enlarges(att()) ? "cursor-zoom-in" : "cursor-pointer"} select-none flex-row items-center gap-2 px-3 py-2 bg-pane border border-line hover:border-brand rounded-(--radius-md) max-w-full`}
      >
        <If
          when={thumb()}
          else={
            <If
              when={pending()}
              else={
                <View class="items-center justify-center">
                  <FileIcon icon={fileIconFor(att().workspace_relpath, { isDir: att().is_dir })} size={16} />
                </View>
              }
            >
              <View ref={(n: ViewRef) => (picture = n)} testID="attachment-chip-pending" accessibilityLabel={copy().stream.artifactLoading} class="w-9 h-9 rounded-(--radius-sm) bg-line-subtle items-center justify-center shrink-0">
                <Icon name="spinner" size={16} class="animate-spin tint-brand" />
              </View>
            </If>
          }
        >
          {(url: () => string) => (
            <Image
              ref={(n: ViewRef) => (picture = n)}
              testID="attachment-chip-thumb"
              src={url()}
              class="w-9 h-9 rounded-(--radius-sm) bg-line-subtle shrink-0"
              style={{ objectFit: "cover" }}
              onContextMenu={(e) => menu.set({ src: url(), x: e.pagePosition.x, y: e.pagePosition.y })}
            />
          )}
        </If>
        <View class="min-w-0 max-w-[170px]">
          <Text class="text-[12px] font-semibold text-ink line-clamp-1">{att().original_filename}</Text>
          <Text class="font-mono text-[10px] text-ink-muted line-clamp-1">{att().workspace_relpath}</Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <If when={rows().length > 0}>
        <If
          when={collapse()}
          else={
            <>
              <View testID="msg-attachments-grid" class="flex-row flex-wrap gap-4 mt-4">
                <Each of={chips()} key={(att) => att.id}>
                  {(att) => <Chip att={att()} />}
                </Each>
              </View>
              <If when={props.cards}>
                <Bundle />
              </If>
            </>
          }
        >
          <Bundle />
        </If>
      </If>
      <If when={menu()}>
        {(at: () => { src: string; x: number; y: number }) => <ImageContextMenu src={at().src} x={at().x} y={at().y} onClose={() => menu.set(null)} />}
      </If>
    </>
  );
}
