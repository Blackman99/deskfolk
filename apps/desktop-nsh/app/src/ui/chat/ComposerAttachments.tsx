/**
 * What is staged to go with the message (`ComposerAttachments.svelte`): a chip for each pasted or
 * picked file and each workspace file dragged in from the tree, with its size and its ✕. A picture's
 * thumbnail enlarges over the whole app, the way one in a message does, growing out of the
 * thumbnail (`MessageImageLightbox`).
 */
import { Image, signal, Text, View, type ViewRef } from "nsh";
import { formatFileSize } from "../../m/chat/attachments.ts";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import type { StagedAttachment, StagedWorkspacePath } from "../../m/session-view.svelte.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { ImageContextMenu } from "../ImageContextMenu";
import { FileIcon } from "../overlays/FileIcon";
import { type ImageOrigin, originOf } from "./lightbox-fit";
import { MessageImageLightbox } from "./MessageImageLightbox";

export function ComposerAttachments(props: {
  /** A staged workspace picture enlarges from the Mac's bytes; a pasted one is already here. */
  api: MessengerApi | null;
  pendingAttachments: StagedAttachment[];
  pendingPaths: StagedWorkspacePath[];
  /** A send from this conversation is in flight: the chips stay as the sign of it and cannot be taken back. */
  sending: boolean | undefined;
  uploadedPercent: (file: File) => number | null;
  onRemoveAttachment: (id: string) => void;
  onRemovePath: (id: string) => void;
}) {
  /**
   * A staged picture enlarged. Found by its row each time: a send or ✕ drops the row, and the
   * enlargement goes with it instead of showing a picture that is no longer there.
   */
  const enlarged = signal<{ id: string; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
  const enlargedFile = () => {
    const id = enlarged()?.id;
    return id ? (props.pendingAttachments.find((row) => row.id === id && row.previewUrl) ?? null) : null;
  };
  const enlargedPath = () => {
    const id = enlarged()?.id;
    return id && !enlargedFile() ? (props.pendingPaths.find((row) => row.id === id && row.previewUrl) ?? null) : null;
  };
  const menu = signal<{ src: string; x: number; y: number } | null>(null);

  async function enlarge(id: string, node: ViewRef | null, thumbnail: string | null): Promise<void> {
    const origin = await originOf(node);
    enlarged.set({ id, origin, placeholder: thumbnail });
  }

  function Thumb(thumb: { id: string; name: string; url: string; label: string }) {
    let node: ViewRef | null = null;
    return (
      <View
        ref={(n: ViewRef) => (node = n)}
        role="button"
        testID="attachment-preview"
        accessibilityLabel={`${thumb.label} ${thumb.name}`}
        tooltip={undefined}
        onPress={() => void enlarge(thumb.id, node, thumb.url)}
        onContextMenu={(e) => menu.set({ src: thumb.url, x: e.pagePosition.x, y: e.pagePosition.y })}
        class="cursor-zoom-in select-none shrink-0 rounded-(--radius-sm)"
      >
        <Image
          src={thumb.url}
          accessibilityLabel={thumb.name}
          class="w-9 h-9 rounded-(--radius-sm) border border-line"
          style={{ objectFit: "cover" }}
        />
      </View>
    );
  }

  const Remove = (remove: { name: string; onPress: () => void }) => (
    <View
      role="button"
      testID="attachment-delete"
      accessibilityLabel={`${copy().composer.removeAttachment} ${remove.name}`}
      disabled={props.sending}
      onPress={remove.onPress}
      class="cursor-pointer select-none disabled:cursor-default w-6 h-6 rounded-full items-center justify-center shrink-0 bg-ink/10 hover:bg-danger active:scale-90 group disabled:opacity-[0.4]"
    >
      <Icon name="x" size={12} class="tint-ink-muted group-hover:tint-on-danger" />
    </View>
  );

  return (
    <>
      <View testID="composer-attachments" class="flex-row flex-wrap gap-2 px-1 py-[6px] mb-1 border-b border-line-subtle">
        <Each of={props.pendingAttachments} key={(att) => att.id}>
          {(att) => (
            <View
              testID="composer-attachment"
              class={`flex-row items-center gap-2 bg-chip border border-line rounded-(--radius-md) max-w-[220px] py-1 pr-2 ${att().isImage ? "pl-1" : "pl-[6px]"}`}
            >
              <If
                when={att().isImage ? att().previewUrl : null}
                else={
                  <View class="w-8 h-8 rounded-(--radius-sm) bg-pane border border-line items-center justify-center shrink-0">
                    <Icon name="file" size={16} class="tint-ink-muted" />
                  </View>
                }
              >
                {() => <Thumb id={att().id} name={att().name} url={att().previewUrl ?? ""} label={copy().stream.artifactEnlarge} />}
              </If>
              <View class="flex-1 min-w-0">
                <Text testID="attachment-name" class="text-[12px] font-medium text-ink line-clamp-1">
                  {att().name}
                </Text>
                <Text testID="attachment-size" class="font-mono text-[10px] text-ink-muted">
                  {`${formatFileSize(att().size)}${uploadedLabel(props.uploadedPercent(att().file))}`}
                </Text>
              </View>
              <Remove name={att().name} onPress={() => props.onRemoveAttachment(att().id)} />
            </View>
          )}
        </Each>
        <Each of={props.pendingPaths} key={(ref) => ref.id}>
          {(ref) => (
            <View
              testID="composer-path"
              tooltip={undefined}
              accessibilityLabel={`${ref().path} · ${copy().composer.workspaceRef}`}
              class={`flex-row items-center gap-2 bg-chip border border-line rounded-(--radius-md) max-w-[220px] py-1 pr-2 ${ref().previewUrl ? "pl-1" : "pl-[6px]"}`}
            >
              <If
                when={ref().previewUrl}
                else={
                  <View class="w-8 h-8 rounded-(--radius-sm) bg-pane border border-line items-center justify-center shrink-0">
                    <FileIcon icon={fileIconFor(ref().path, { isDir: ref().isDir })} size={16} />
                  </View>
                }
              >
                {/* Only a picture gets a preview (the Mac's 256 px copy); enlarged, the picture itself comes. */}
                {() => <Thumb id={ref().id} name={ref().name} url={ref().previewUrl ?? ""} label={copy().stream.artifactEnlarge} />}
              </If>
              <View class="flex-1 min-w-0">
                <Text class="text-[12px] font-medium text-ink line-clamp-1">{ref().name}</Text>
                <Text class="font-mono text-[10px] text-ink-muted line-clamp-1">{ref().path}</Text>
              </View>
              <Remove name={ref().name} onPress={() => props.onRemovePath(ref().id)} />
            </View>
          )}
        </Each>
      </View>
      <If when={enlargedFile() || enlargedPath()}>
        <MessageImageLightbox
          src={enlargedFile()?.previewUrl ?? null}
          label={enlargedFile()?.name ?? null}
          relpath={enlargedPath()?.path ?? null}
          placeholder={enlargedPath() ? (enlarged()?.placeholder ?? null) : null}
          origin={enlarged()?.origin ?? null}
          api={props.api}
          onClose={() => enlarged.set(null)}
        />
      </If>
      <If when={menu()}>
        {(at: () => { src: string; x: number; y: number }) => <ImageContextMenu src={at().src} x={at().x} y={at().y} onClose={() => menu.set(null)} />}
      </If>
    </>
  );
}

const uploadedLabel = (percent: number | null) => (percent === null ? "" : ` · ${copy().composer.uploaded(percent)}`);
