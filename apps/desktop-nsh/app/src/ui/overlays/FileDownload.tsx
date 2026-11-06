/**
 * Download for a file seen remotely (`FileDownload.svelte`). Its bytes cross only when asked for,
 * unless the whole file is already here, and leaving the file cancels them, as it cancels a
 * preview's read. On a phone a picture goes to the share sheet when it takes that type, and every
 * other file to the downloads in the same tap (see `saveFile`).
 *
 * `bind:note` is `note` (what the caller holds) plus `onNoteChange`; without `note` the component
 * keeps its own.
 */
import { cleanup, signal, Text, View } from "nsh";
import { formatFileSize } from "../../m/chat/attachments.ts";
import { fileProgressPercent, formatFileProgress, type FileProgress } from "../../m/file-progress.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { saveFile } from "../../m/save-file.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";

/** How a download ended when it did not end in the file: the share sheet wants a fresh tap for a picture, or it failed. */
export type FileDownloadNote = "tap" | "failed" | null;

export function FileDownload(props: {
  api: MessengerApi | null;
  path: string;
  /** Read from the attachment rather than the workspace path, as the preview does. */
  attachmentId?: string | null;
  name: string;
  /**
   * The whole file, when it is already here: saved in the same tap, so the share sheet opens
   * on the first one. Never a scaled copy or a piece of a stream.
   */
  ready?: Blob | null;
  /** `pill` in the middle of a pane, `compact` in a bar, `icon` in a header. */
  variant?: "pill" | "compact" | "icon";
  /** Set for the caller to show; the pill and compact buttons also show it themselves unless `quiet`. */
  note?: FileDownloadNote;
  onNoteChange?: (note: FileDownloadNote) => void;
  quiet?: boolean;
  /** The icon variant's side (the Svelte's `--file-download-size`, 32 by default). */
  size?: number;
  testID?: string;
}) {
  const busy = signal(false);
  const progress = signal<FileProgress | null>(null);
  const ownNote = signal<FileDownloadNote>(null);
  /** A picture the share sheet turned away because the tap was spent: the next tap hands it over. */
  let held: Blob | null = null;
  const abort = new AbortController();
  cleanup(() => abort.abort());

  const note = (): FileDownloadNote => (props.note !== undefined ? props.note : ownNote());
  const setNote = (next: FileDownloadNote) => {
    ownNote.set(next);
    props.onNoteChange?.(next);
  };
  const variant = () => props.variant ?? "pill";
  const t = () => copy().stream;
  const label = () => (busy() ? t().artifactDownloading(progress() ? formatFileProgress(progress()!, formatFileSize) : null) : t().artifactDownload);
  const percent = () => (progress() ? fileProgressPercent(progress()!) : null);

  async function download(): Promise<void> {
    const client = props.api;
    if (!client || busy()) return;
    setNote(null);
    try {
      // No await when the bytes are here: the share sheet has to open inside the tap.
      let blob = held ?? props.ready ?? null;
      if (!blob) {
        busy.set(true);
        progress.set(null);
        const onProgress = (next: FileProgress) => progress.set(next);
        blob = props.attachmentId
          ? await client.getAttachmentBlob(props.attachmentId, onProgress, { signal: abort.signal })
          : await client.getWorkspaceFileBlob(props.path, onProgress, { signal: abort.signal });
        held = blob;
      }
      if (abort.signal.aborted) return;
      const outcome = await saveFile(blob, props.name);
      if (outcome === "needs-tap") setNote("tap");
      else held = null;
    } catch {
      if (!abort.signal.aborted) setNote("failed");
    } finally {
      busy.set(false);
    }
  }

  const iconSize = () => props.size ?? 32;

  return (
    <If
      when={variant() === "icon"}
      else={
        <>
          <View
            role="button"
            testID={props.testID}
            accessibilityLabel={label()}
            accessibilityState={{ busy: busy(), disabled: busy() }}
            disabled={busy()}
            onPress={() => void download()}
            class={
              variant() === "compact"
                ? `shrink-0 h-[26px] px-[10px] items-center justify-center border rounded-full disabled:opacity-80 ${note() === "tap" ? "bg-brand border-brand" : "border-line bg-btn-secondary-bg hover:border-accent-border hover:bg-accent-tint"}`
                : `mt-[6px] h-[32px] px-4 items-center justify-center border rounded-full disabled:opacity-80 ${note() === "tap" ? "bg-brand border-brand" : "border-accent-border bg-accent-tint hover:border-brand"}`
            }
          >
            <Text
              class={
                variant() === "compact"
                  ? `text-[12px] font-medium ${note() === "tap" ? "text-on-accent" : "text-ink-secondary"}`
                  : `text-[13px] font-semibold ${note() === "tap" ? "text-on-accent" : "text-brand"}`
              }
            >
              {label()}
            </Text>
          </View>
          <If when={note() && !props.quiet}>
            <Text testID="file-download-note" role="text" class={`text-ink-muted ${variant() === "compact" ? "text-[11px]" : "text-[12px]"}`}>
              {note() === "tap" ? t().imageSaveTapAgain : t().artifactDownloadFailed}
            </Text>
          </If>
        </>
      }
    >
      <View
        role="button"
        testID={props.testID}
        accessibilityLabel={t().artifactDownload}
        tooltip={tip(label())}
        accessibilityState={{ busy: busy(), disabled: busy() }}
        disabled={busy()}
        onPress={() => void download()}
        class={`shrink-0 items-center justify-center rounded-(--radius-md) ${note() === "tap" ? "bg-brand" : "bg-transparent hover:bg-line-subtle active:bg-line-subtle"}`}
        style={{ width: iconSize(), height: iconSize() }}
      >
        <If
          when={busy()}
          else={<Icon name="download" size={20} class={note() === "tap" ? "tint-on-accent" : "tint-ink-secondary"} />}
        >
          <If when={percent() !== null} else={<Icon name="spinner" size={16} class="animate-spin tint-brand" />}>
            <Text class="text-[11px] font-semibold text-brand">{`${percent()}%`}</Text>
          </If>
        </If>
      </View>
    </If>
  );
}
