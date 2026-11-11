/**
 * The menu of a conversation's row (`sidebar/SessionContextMenu.svelte`): pin, info, its job and
 * task map, a project session's directory and terminal, rename, clear history, archive and delete.
 * Mount it while it is open. On a desktop it is a menu at the pointer (`x`, `y` in the window), kept
 * inside it, closed by a press elsewhere or Escape; on a phone (a long press) a `BottomSheet` named
 * after the conversation, which closes itself.
 *
 * Not ported: the Svelte menu also closes when something behind it scrolls. A popup does not hear the
 * scrolling behind it in NSH; a press outside and Escape close it.
 */
import { Overlay, Text, View, type JSX } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { deriveSessionContextMenu } from "../../m/sidebar/session-context-menu";
import { sessionTitle } from "../../m/sidebar/session-title";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem, SheetSeparator } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";

export function SessionContextMenu(props: {
  session: SessionSummary;
  botsById: ReadonlyMap<string, Bot>;
  isPinned: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onTogglePin: () => void;
  onViewInfo: () => void;
  onClearHistory: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  /** Open the conversation's latest job: its one flow tab on a wide window, its page on a phone. */
  onShowJobView?: () => void;
  /** Open a project session's task map (ADR 0096); given only where a workbench can hold it. */
  onShowMap?: () => void;
  /** Open a project session's directory in the preview, the project's tree beside it. */
  onOpenProjectDir?: () => void;
  /** Start a terminal in a project session's directory. */
  onOpenProjectTerminal?: () => void;
  /** Rename a project session on its sidebar row; given only while the sidebar shows its rows. */
  onRename?: () => void;
}) {
  const t = () => copy();
  const data = () => deriveSessionContextMenu(props.session, props.isPinned, props.botsById);
  const title = () =>
    sessionTitle(props.session, props.botsById, {
      deleted: t().top.deleted,
      archived: t().top.archived,
      fileDrop: t().sidebar.fileDrop,
      projectUntitled: t().project.untitled,
    });
  /** An entry runs its action, then the menu goes. */
  const run = (action: () => void) => () => {
    action();
    props.onClose();
  };

  function Item(p: {
    sheet: boolean;
    icon: IconName;
    filled?: boolean;
    label: string;
    testID: string;
    danger?: boolean;
    disabled?: boolean;
    onPress: () => void;
  }): JSX.Element {
    return (
      <If
        when={p.sheet}
        else={
          <View
            role="menuitem"
            testID={p.testID}
            accessibilityLabel={p.label}
            accessibilityState={{ disabled: p.disabled }}
            disabled={p.disabled}
            onPress={p.onPress}
            class={`cursor-pointer select-none disabled:cursor-default group flex-row items-center gap-2 w-full px-[10px] py-[6px] rounded-(--radius-sm) disabled:opacity-[0.4] ${p.danger ? "hover:bg-danger-bg" : "hover:bg-line-subtle"}`}
          >
            <Icon
              name={p.icon}
              filled={p.filled}
              size={16}
              class={p.danger ? "tint-ink opacity-75 group-hover:tint-danger" : "tint-ink opacity-75 group-hover:tint-brand"}
            />
            <Text class={`text-[13px] font-medium text-ink ${p.danger ? "group-hover:text-danger-text" : "group-hover:text-brand"}`}>{p.label}</Text>
          </View>
        }
      >
        <SheetItem role="menuitem" testID={p.testID} icon={p.icon} label={p.label} danger={p.danger} disabled={p.disabled} onPress={p.onPress} />
      </If>
    );
  }

  function Divider(p: { sheet: boolean }): JSX.Element {
    return (
      <If when={p.sheet} else={<View class="h-[1px] bg-line-subtle my-[3px] mx-2" />}>
        <SheetSeparator />
      </If>
    );
  }

  const items = (sheet: boolean): JSX.Element => {
    const showMap = () => Boolean(data().canShowMap && props.onShowMap);
    return (
      <>
        <Item
          sheet={sheet}
          testID="session-menu-pin"
          icon="pin"
          filled={data().isPinned}
          label={data().isPinned ? t().sidebar.unpin : t().sidebar.pin}
          onPress={run(props.onTogglePin)}
        />
        <If when={data().canViewInfo}>
          <Item sheet={sheet} testID="session-menu-info" icon="info" label={t().sidebar.viewInfo} onPress={run(props.onViewInfo)} />
        </If>
        <If when={data().canShowJob && props.onShowJobView}>
          <Divider sheet={sheet} />
          {/* The latest job's one tab: its tickets, flow and spec (ADR 0086). */}
          <Item sheet={sheet} testID="session-menu-job" icon="hierarchy" label={t().plan.segmentTrace} onPress={run(() => props.onShowJobView?.())} />
        </If>
        <If when={showMap()}>
          <Divider sheet={sheet} />
          {/* The conversation's work drawn as a town: a project session's agent (ADR 0096), a conversation's Bots (ADR 0097). */}
          <Item sheet={sheet} testID="session-menu-map" icon="minimap" label={t().taskmap.openLong} onPress={run(() => props.onShowMap?.())} />
        </If>
        <If when={data().canOpenProjectDir && props.onOpenProjectDir}>
          <If when={!showMap()}>
            <Divider sheet={sheet} />
          </If>
          {/* The project's directory in the preview, listed a level at a time as the workspace explorer is (ADR 0095). */}
          <Item sheet={sheet} testID="session-menu-project-dir" icon="folder" label={t().project.openDir} onPress={run(() => props.onOpenProjectDir?.())} />
        </If>
        <If when={data().canOpenProjectDir && props.onOpenProjectTerminal}>
          <If when={!showMap() && !props.onOpenProjectDir}>
            <Divider sheet={sheet} />
          </If>
          {/* A shell in the project's directory: a tab of its own on the workbench, the terminal page on a phone. */}
          <Item
            sheet={sheet}
            testID="session-menu-project-terminal"
            icon="terminal"
            label={t().project.openTerminal}
            onPress={run(() => props.onOpenProjectTerminal?.())}
          />
        </If>
        <Divider sheet={sheet} />
        <If when={data().canRename && props.onRename}>
          <Item sheet={sheet} testID="session-menu-rename" icon="edit" label={t().project.rename} onPress={run(() => props.onRename?.())} />
        </If>
        <If when={data().canClearHistory}>
          <Item sheet={sheet} testID="session-menu-clear" icon="rotate-ccw" label={t().sidebar.clearHistory} onPress={run(props.onClearHistory)} />
        </If>
        <Item
          sheet={sheet}
          testID="session-menu-archive"
          icon={data().archive.isArchived ? "rotate-ccw" : "archive"}
          label={data().archive.isArchived ? t().sidebar.unarchive : t().sidebar.archive}
          disabled={!data().archive.enabled}
          onPress={() => {
            if (!data().archive.enabled) return;
            props.onToggleArchive();
            props.onClose();
          }}
        />
        <Divider sheet={sheet} />
        <Item
          sheet={sheet}
          testID="session-menu-delete"
          icon="trash"
          danger
          label={t().sidebar.delete}
          disabled={!data().delete.enabled}
          onPress={() => {
            if (!data().delete.enabled) return;
            props.onDelete();
            props.onClose();
          }}
        />
      </>
    );
  };

  return (
    <If
      when={narrowWindow()}
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
            testID="session-context-menu"
            accessibilityLabel={title()}
            class="min-w-[168px] p-[5px] gap-[2px] bg-pane border border-line rounded-(--radius-md)"
            style={{ boxShadow: shadow("menu") }}
          >
            {items(false)}
          </View>
        </Overlay>
      }
    >
      <BottomSheet title={title()} closeLabel={t().common.close} onClose={props.onClose}>
        <View role="menu" testID="session-context-menu" accessibilityLabel={title()}>
          {items(true)}
        </View>
      </BottomSheet>
    </If>
  );
}
