/**
 * The wide list's bottom row (`SidebarFoot.svelte`): workspace, optional remote file-drop button,
 * tools and settings, separated from the scrolling list by a hairline seam. Its words hide once
 * they no longer fit beside each other; a list under 240px drops them even where they would fit,
 * and under 300px the row tightens.
 */
import { effect, signal, Text, View, type ViewRef } from "nsh";
import { copy, runtime } from "../../runtime";
import { formatShortcut } from "../../m/keymap";
import { unreadBadge } from "../../m/sidebar/unread";
import { updateChecker } from "../../m/update-checker.svelte";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { floor } from "../interface/floor";
import { SEAM_BORDER } from "../glass";
import { FOOT_ICONS_ONLY, FOOT_TIGHT, footActionClass, footActionInk, settingsEntryColours } from "./foot-action";
import type { MenuAt } from "./SessionRow";
import { ToolsToggle } from "./ToolsToggle";
import { foldMotion } from "./fold-motion";

const PADDING = 16;
const GAP = 4;

export function SidebarFoot(props: {
  workspaceOpen: boolean;
  workspacePath: string | null | undefined;
  onToggleWorkspace: () => void;
  /** Remote file-drop session shortcut in the desktop footer. */
  fileDropActive?: boolean;
  fileDropUnread?: number;
  onOpenFileDrop?: () => void;
  onFileDropContextMenu?: (at: MenuAt) => void;
  onOpenSettings: () => void;
  toolsMenuOpen?: boolean;
  onToolsMenuOpenChange: (open: boolean) => void;
  onToolsFocusLast?: (last: boolean) => void;
  onToolsAnchor?: (node: ViewRef) => void;
}) {
  const fold = foldMotion();
  const room = signal(0);
  const workspaceWidth = signal(0);
  const fileDropWidth = signal(0);
  const toolsWidth = signal(0);
  const settingsWidth = signal(0);
  const compact = signal(false);

  // How wide the row is while its words are showing is kept in plain variables, not signals: reading
  // them here would rerun this the moment the words hide, and forget the width.
  let labelWidth = 0;
  let isCompact = false;
  effect(() => {
    const available = room();
    if (available <= 0) return;
    const hasFileDrop = Boolean(props.onOpenFileDrop);
    const gaps = hasFileDrop ? GAP * 3 : GAP * 2;
    const extra = hasFileDrop ? fileDropWidth() : 0;
    const total = workspaceWidth() + extra + toolsWidth() + settingsWidth() + gaps + PADDING;
    if (!isCompact) {
      labelWidth = total;
      isCompact = labelWidth > available + 1;
    } else if (labelWidth > 0 && labelWidth <= available + 1) {
      isCompact = false;
    }
    compact.set(isCompact);
  });

  /** The footer's content width, which the container queries compare. */
  const content = () => room() - PADDING;
  const iconsOnly = () => compact() || (room() > 0 && content() <= FOOT_ICONS_ONLY);
  const tight = () => room() > 0 && content() <= FOOT_TIGHT;
  const settingsLabel = () => (updateChecker.updateVisible ? `${copy().sidebar.settings} · ${copy().sidebar.updateAvailable}` : copy().sidebar.settings);
  const fileDropUnread = () => props.fileDropUnread ?? 0;
  const fileDropTip = () =>
    fileDropUnread() > 0 ? `${copy().sidebar.fileDrop} · ${copy().sidebar.unread} ${fileDropUnread()}` : copy().sidebar.fileDrop;
  const workspaceInk = () => footActionInk(props.workspaceOpen);
  const fileDropInk = () => footActionInk(props.fileDropActive);
  const settingsInk = () => footActionInk(runtime.settingsOpen);

  return (
    <View
      testID="sidebar-foot"
      role="toolbar"
      class={`flex-row items-center gap-1 px-2 py-[6px] border-t ${SEAM_BORDER}`}
      onLayout={(e) => room.set(e.bounds.size.width)}
    >
      <View
        role="button"
        testID="foot-workspace"
        tooltip={tip(props.workspacePath ? `${copy().sidebar.workspace} (${formatShortcut(["mod", "O"])})` : copy().sidebar.workspaceUnset)}
        accessibilityLabel={copy().sidebar.workspace}
        accessibilityState={{ expanded: props.workspaceOpen, disabled: !props.workspacePath }}
        disabled={!props.workspacePath}
        onLayout={(e) => workspaceWidth.set(e.bounds.size.width)}
        onPress={() => props.onToggleWorkspace()}
        hoverStyle={{ boxShadow: shadow("xs") }}
        class={`cursor-pointer select-none disabled:cursor-default group ${footActionClass({ active: props.workspaceOpen, tight: tight(), iconsOnly: iconsOnly() })}`}
      >
        <Icon name="folder" class={workspaceInk().tint} />
        <If when={!iconsOnly()}>
          <Text class={`text-[12px] font-medium ${workspaceInk().text}`} style={fold?.text}>{copy().sidebar.workspace}</Text>
        </If>
      </View>
      <If when={props.onOpenFileDrop}>
        {(openFileDrop) => (
          <View
            role="button"
            testID="foot-file-drop"
            tooltip={tip(fileDropTip())}
            accessibilityLabel={copy().sidebar.fileDrop}
            accessibilityState={{ selected: props.fileDropActive === true }}
            onLayout={(e) => fileDropWidth.set(e.bounds.size.width)}
            onPress={() => openFileDrop()()}
            onContextMenu={
              props.onFileDropContextMenu
                ? (e) => props.onFileDropContextMenu?.({ x: e.pagePosition.x, y: e.pagePosition.y })
                : undefined
            }
            hoverStyle={{ boxShadow: shadow("xs") }}
            class={`cursor-pointer select-none group ${footActionClass({ active: props.fileDropActive, tight: tight(), iconsOnly: iconsOnly() })}`}
          >
            <Icon name="file-down" class={fileDropInk().tint} />
            <If when={!iconsOnly()}>
              <Text class={`text-[12px] font-medium ${fileDropInk().text}`} style={fold?.text}>{copy().sidebar.fileDrop}</Text>
            </If>
            <If when={fileDropUnread() > 0}>
              <View
                testID="foot-file-drop-unread"
                accessible={false}
                class="absolute top-[2px] right-[2px] min-w-[14px] h-[14px] px-[3px] rounded-full bg-mustard items-center justify-center"
              >
                <Text class="text-[9px] font-bold text-on-mustard">{unreadBadge(fileDropUnread())}</Text>
              </View>
            </If>
          </View>
        )}
      </If>
      <ToolsToggle
        phone={false}
        open={props.toolsMenuOpen}
        onOpenChange={props.onToolsMenuOpenChange}
        onFocusLast={props.onToolsFocusLast}
        onAnchor={props.onToolsAnchor}
        tight={tight()}
        iconsOnly={iconsOnly()}
        onWidth={(w) => toolsWidth.set(w)}
      />
      <View
        role="button"
        ref={floor("settings-entry", () => settingsEntryColours(runtime.settingsOpen))}
        testID="foot-settings"
        tooltip={tip(settingsLabel())}
        accessibilityLabel={settingsLabel()}
        accessibilityState={{ selected: runtime.settingsOpen }}
        onLayout={(e) => settingsWidth.set(e.bounds.size.width)}
        onPress={() => props.onOpenSettings()}
        hoverStyle={{ boxShadow: shadow("xs") }}
        class={`cursor-pointer select-none group ml-auto ${footActionClass({ active: runtime.settingsOpen, tight: tight(), iconsOnly: iconsOnly() })}`}
      >
        <Icon name="settings" class={settingsInk().tint} />
        <If when={!iconsOnly()}>
          <Text class={`text-[12px] font-medium ${settingsInk().text}`} style={fold?.text}>{copy().sidebar.settings}</Text>
        </If>
        <If when={updateChecker.updateVisible}>
          <View testID="foot-update-dot" accessible={false} class="absolute top-[3px] right-[3px] w-[8px] h-[8px] rounded-full bg-brand border-[1.5px] border-sidebar-bg" />
        </If>
      </View>
    </View>
  );
}
