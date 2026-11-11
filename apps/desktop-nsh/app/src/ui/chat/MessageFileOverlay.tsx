/**
 * A file opened from its chip, over the whole app (`MessageFileOverlay.svelte`): a framed page with
 * the file's icon and name and a ✕, the preview inside it. On a phone the frame is the whole window
 * and the preview's own bar replaces the head.
 *
 * The preview itself (`overlays/ArtifactPreview.svelte`) is a port of its own and not in this job:
 * the frame hands what it would be given (`ctx`: the file shown, its annotation target, `select`
 * for a link to another file) to `children`, which draws it. Escape and the phone's Back close the
 * frame (`holdFullscreenPreview`); a preview with an unsaved edit calls `ctx.holdClose` to ask first.
 */
import { cleanup, Overlay, Text, View, windowSize, signal, type JSX } from "nsh";
import type { Attachment } from "@real-bot/protocol";
import { targetFor } from "../../m/annotations/model.ts";
import { isPlaceholderAttachment } from "../../m/overlays/artifacts.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { holdFullscreenPreview } from "../../m/overlays/fullscreen-preview.ts";
import { copy, runtime } from "../../runtime";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { FileIcon } from "../overlays/FileIcon";
import { shadow } from "../styles";
import { WheelLayer } from "../../platform/wheel-layer";

export type FileOverlayContext = {
  attachment: () => Attachment | null;
  relpath: () => string;
  target: () => ReturnType<typeof targetFor>;
  /** A link in the file to another one turns the preview to it. */
  select: (attachment: Attachment) => void;
  /** The preview's own close (asks about an unsaved edit); without one the frame just closes. */
  holdClose: (close: (() => void) | null) => void;
  close: () => void;
};

export function MessageFileOverlay(props: {
  /** The chip's row; null for a file only named in the message, read from the workspace. */
  attachment: Attachment | null;
  relpath: string;
  /** The message the chip sits on: what an annotation hangs on, when a Bot's does not. */
  messageId: string | null;
  onClose: () => void;
  /** The preview, drawn inside the frame. */
  children?: (ctx: FileOverlayContext) => JSX.Element;
}) {
  const picked = signal<{ relpath: string; attachment: Attachment | null } | null>(null);
  const shownPath = () => picked()?.relpath ?? props.relpath;
  const shownAttachment = () => (picked() ? picked()!.attachment : props.attachment);
  const name = () => shownAttachment()?.original_filename ?? (shownPath().split("/").pop() || shownPath());
  const owner = () => (props.messageId ? runtime.snapshot.messages.find((message) => message.id === props.messageId) : undefined);
  const sessionId = () => owner()?.session_id ?? runtime.selectedId ?? null;
  const target = () =>
    targetFor(runtime.snapshot.messages, shownPath(), owner(), { sessionId: sessionId(), taskId: owner()?.task_id ?? null });

  let preview: (() => void) | null = null;
  let release: (() => void) | null = null;

  /**
   * Escape and the phone's Back take this off the newest-first list of full-window previews and
   * call this. An unsaved edit asks first and may keep the file open, so it goes back on the list.
   */
  function close(): void {
    release?.();
    release = holdFullscreenPreview(close);
    if (preview) preview();
    else props.onClose();
  }
  release = holdFullscreenPreview(close);
  cleanup(() => {
    release?.();
    release = null;
  });

  const ctx: FileOverlayContext = {
    attachment: shownAttachment,
    relpath: shownPath,
    target,
    select: (att) => picked.set({ relpath: att.workspace_relpath, attachment: isPlaceholderAttachment(att) ? null : att }),
    holdClose: (fn) => {
      preview = fn;
    },
    close: props.onClose,
  };

  const phone = () => narrowWindow();
  return (
    <Overlay
      onCancel={close}
      style={{ width: windowSize().width, height: windowSize().height }}
    >
      <WheelLayer>
        <View
          testID="msg-file-overlay"
          onPress={() => close()}
          class={`flex-1 items-center justify-center bg-bg/90 ${phone() ? "p-0" : "p-6"}`}
        >
          <View
            role="group"
            testID="msg-file-frame"
            accessibilityLabel={name()}
            // A press inside the frame is not a press on the scrim.
            onPress={() => {}}
            focusable={false}
            class={`overflow-hidden bg-pane ${phone() ? "w-full h-full" : "border border-line rounded-(--radius-lg)"}`}
            style={
              phone()
                ? undefined
                : { width: Math.min(1100, windowSize().width - 48), height: Math.min(windowSize().height * 0.88, windowSize().height - 48), boxShadow: shadow("lg") }
            }
          >
            <If when={!phone()}>
              <View class="flex-row items-center gap-2 min-h-[48px] pl-4 pr-2 border-b border-line shrink-0">
                <FileIcon icon={fileIconFor(shownPath(), { isDir: shownAttachment()?.is_dir === true })} size={16} />
                <Text testID="msg-file-name" class="flex-1 min-w-0 text-[13px] font-semibold text-ink line-clamp-1">
                  {name()}
                </Text>
                <IconButton icon="x" size="md" label={copy().common.close} testID="msg-file-close" class="rounded-full" onPress={close} />
              </View>
            </If>
            <View testID="msg-file-body" class="flex-1 min-h-0">
              {props.children?.(ctx)}
            </View>
          </View>
        </View>
      </WheelLayer>
    </Overlay>
  );
}
