/**
 * The menu of a right click (a long press on a phone) on a message (`MessageContextMenu.svelte`):
 * five quick reactions, then reply, edit, copy, select text, open the associated files, the job's
 * flow, the first few associated files, and copy the message id.
 *
 * On a desktop a small menu at the pointer (`x`, `y` in the window), kept inside the window by
 * `Overlay`, closed by a press outside or Escape. Opened by a touch (`sheet`) it is a sheet across
 * the bottom, with emoji and rows a thumb can hit. Mount it while it is open.
 *
 * Copy writes the text to the clipboard and tells `onCopy`, so the opener can say so.
 * Not carried over: the Svelte menu also closed when a scroll area behind it moved more than 6 px;
 * NSH tells an overlay nothing about scrolls elsewhere, so here a press outside closes it.
 */
import { Clipboard, Overlay, Text, View } from "nsh";
import type { Message } from "@real-bot/protocol";
import { deriveMessageContextMenu } from "../../m/chat/message-context-menu.ts";
import type { IconName } from "../Icon";
import { Icon } from "../Icon";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { shadow } from "../styles";
import { tip } from "../tip";
import { copy } from "../../runtime";

const QUICK_EMOJIS = ["👍", "❤️", "🎉", "🚀", "👀"];
/** How many associated files are listed under the file-tree row. */
const SUBLIST = 4;

export function MessageContextMenu(props: {
  message: Message;
  x: number;
  y: number;
  lockedComposer?: boolean;
  selectedText?: string | null;
  onClose: () => void;
  onReply: () => void;
  onCopy: (text: string) => void;
  onOpenFileTree: (path: string | null) => void;
  /** Open the message's job on its card, the ticket it was filed under picked; or a line's own flow. */
  onShowTrace: () => void;
  onCopyId: () => void;
  onReaction: (emoji: string) => void;
  /** Present when this is a line of yours that can still be changed (ADR 0063). */
  onEdit?: () => void;
  /** Present when the menu came from a touch: copying part of the message needs the text on a page of its own. */
  onSelectText?: () => void;
  /** Opened by a touch: drawn as a sheet across the bottom instead of a small menu at the finger. */
  sheet?: boolean;
}) {
  const data = () => deriveMessageContextMenu(props.message, { lockedComposer: props.lockedComposer ?? false });
  const t = () => copy();

  /** Runs an entry, then closes the menu. */
  const act = (run: () => void) => () => {
    run();
    props.onClose();
  };

  const rows: Array<{ id: string; icon: IconName; label: () => string; enabled: () => boolean; show?: () => boolean; hint?: () => string | undefined; run: () => void }> = [
    { id: "reply", icon: "reply", label: () => t().chat.replyMessage, enabled: () => data().canReply, run: () => props.onReply() },
    { id: "edit", icon: "edit", label: () => t().chat.editMessage, enabled: () => true, show: () => Boolean(props.onEdit), run: () => props.onEdit?.() },
    {
      id: "copy",
      icon: "copy",
      label: () => t().chat.copyMessage,
      enabled: () => data().canCopy,
      run: () => {
        const text = props.selectedText || props.message.body;
        void Clipboard.writeText(text).catch(() => {});
        props.onCopy(text);
      },
    },
    { id: "select-text", icon: "text-cursor", label: () => t().chat.selectText, enabled: () => true, show: () => Boolean(props.onSelectText) && data().canCopy, run: () => props.onSelectText?.() },
    {
      id: "file-tree",
      icon: "folder",
      label: () => t().chat.openAssociatedFileTree,
      enabled: () => data().canOpenFileTree,
      hint: () => (!data().canOpenFileTree ? t().chat.noAssociatedFiles : (data().targetPath ?? undefined)),
      run: () => props.onOpenFileTree(data().targetPath),
    },
    // The job this line is in, as one tab (ADR 0086), on this line's card; a line in no job has its own flow (ADR 0083).
    { id: "trace", icon: "hierarchy", label: () => t().chat.jobView.trace, enabled: () => true, show: () => data().canShowTrace || data().canShowLine, run: () => props.onShowTrace() },
  ];
  const visible = () => rows.filter((row) => (row.show ? row.show() : true));
  const files = () => (data().associatedFiles.length > 1 ? data().associatedFiles.slice(0, SUBLIST) : []);

  const reactions = (sheet: boolean) => (
    <View testID="msg-reaction-row" class={`flex-row items-center justify-between ${sheet ? "px-[2px] pt-[2px] pb-[10px]" : "px-1 py-[3px]"}`}>
      <Each of={QUICK_EMOJIS} key={(emoji) => emoji}>
        {(emoji) => (
          <View
            role="button"
            testID="msg-reaction"
            accessibilityLabel={emoji()}
            tooltip={sheet ? undefined : tip(emoji())}
            onPress={act(() => props.onReaction(emoji()))}
            class={`items-center justify-center ${sheet ? "w-12 h-12 rounded-full bg-line-subtle active:scale-[0.92]" : "w-7 h-7 rounded-(--radius-sm) hover:bg-line-subtle hover:scale-[1.2]"}`}
          >
            <Text class={sheet ? "text-[24px]" : "text-[16px]"}>{emoji()}</Text>
          </View>
        )}
      </Each>
    </View>
  );

  return (
    <If
      when={props.sheet}
      else={
        <Overlay
          anchor={{ x: props.x, y: props.y }}
          placement="bottom"
          align="start"
          margin={8}
          onPressOutside={() => props.onClose()}
          onCancel={() => props.onClose()}
        >
          <View
            role="menu"
            testID="msg-context-menu"
            accessibilityLabel={t().chat.copyMessage}
            class="min-w-[172px] max-w-[260px] p-[5px] gap-[2px] bg-pane border border-line rounded-(--radius-md)"
            style={{ boxShadow: shadow("menu") }}
          >
            {reactions(false)}
            <Divider />
            <Each of={visible()} key={(row) => row.id}>
              {(row) => (
                <View
                  role="menuitem"
                  testID={`msg-context-${row().id}`}
                  accessibilityLabel={row().label()}
                  accessibilityState={{ disabled: !row().enabled() }}
                  tooltip={row().hint?.() ? tip(row().hint!()!) : undefined}
                  disabled={!row().enabled()}
                  onPress={act(row().run)}
                  class="flex-row items-center gap-2 w-full px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle group disabled:opacity-[0.45]"
                >
                  <Icon name={row().icon} size={16} class="tint-ink opacity-75 group-hover:tint-brand group-hover:opacity-100" />
                  <Text class="text-[13px] font-medium text-ink group-hover:text-brand">{row().label()}</Text>
                </View>
              )}
            </Each>
            <If when={files().length > 0}>
              <View testID="msg-context-sublist" class="gap-[1px] pl-6 pr-1 pb-1">
                <Each of={files()} key={(file) => file}>
                  {(file) => (
                    <View
                      role="menuitem"
                      testID="msg-context-subitem"
                      accessibilityLabel={file()}
                      onPress={act(() => props.onOpenFileTree(file()))}
                      class="flex-row items-center gap-1 px-[6px] py-[3px] rounded-(--radius-sm) hover:bg-line-subtle group"
                    >
                      <Text class="text-[11px] font-bold text-ink-secondary opacity-60">›</Text>
                      <Text class="flex-1 min-w-0 text-[11px] text-ink-secondary group-hover:text-brand line-clamp-1">{file()}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <Divider />
            <View
              role="menuitem"
              testID="msg-context-copy-id"
              accessibilityLabel={t().chat.copyMessageId}
              onPress={act(() => props.onCopyId())}
              class="flex-row items-center gap-2 w-full px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle group"
            >
              <Icon name="hash" size={16} class="tint-ink opacity-75 group-hover:tint-brand group-hover:opacity-100" />
              <Text class="text-[13px] font-medium text-ink group-hover:text-brand">{t().chat.copyMessageId}</Text>
            </View>
          </View>
        </Overlay>
      }
    >
      <BottomSheet label={t().chat.copyMessage} closeLabel={t().common.close} onClose={props.onClose}>
        <View role="menu" testID="msg-context-menu" accessibilityLabel={t().chat.copyMessage} class="gap-1 px-1">
          {reactions(true)}
          <Each of={visible()} key={(row) => row.id}>
            {(row) => (
              <SheetItem
                role="menuitem"
                testID={`msg-context-${row().id}`}
                icon={row().icon}
                label={row().label()}
                disabled={!row().enabled()}
                onPress={act(row().run)}
              />
            )}
          </Each>
          <If when={files().length > 0}>
            <View testID="msg-context-sublist" class="gap-[1px] pl-9 pb-1">
              <Each of={files()} key={(file) => file}>
                {(file) => (
                  <View
                    role="menuitem"
                    testID="msg-context-subitem"
                    accessibilityLabel={file()}
                    onPress={act(() => props.onOpenFileTree(file()))}
                    class="flex-row items-center gap-1 px-[6px] min-h-[36px] rounded-(--radius-sm) active:bg-line-subtle"
                  >
                    <Text class="text-[12px] font-bold text-ink-secondary opacity-60">›</Text>
                    <Text class="flex-1 min-w-0 text-[13px] text-ink-secondary line-clamp-1">{file()}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <View class="h-[1px] mx-2 my-[3px] bg-line-subtle" />
          <SheetItem role="menuitem" testID="msg-context-copy-id" icon="hash" label={t().chat.copyMessageId} onPress={act(() => props.onCopyId())} />
        </View>
      </BottomSheet>
    </If>
  );
}

function Divider() {
  return <View role="none" class="h-[1px] mx-2 my-[3px] bg-line-subtle" />;
}
