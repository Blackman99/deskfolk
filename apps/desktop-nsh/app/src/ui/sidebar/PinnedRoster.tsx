/**
 * The pinned conversations, as a band above the list (`sidebar/PinnedRoster.svelte`). Nothing pinned
 * is not news worth the top of the sidebar: the sidebar only mounts it once something is. More than
 * five pins get a button that unfolds the strip into a wrapped block (at most 200 tall).
 *
 * A pin working shows the brand dot on its portrait and a brand frame; a conversation waiting on you
 * or unread shows its count on the corner. `runtime` is the window's, not a prop.
 */
import { Scroll, signal, Text, token, View } from "nsh";
import type { PressEvent } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { projectAgentOf } from "../../m/sidebar/project-groups";
import { isFileDropSession } from "../../m/sidebar/session-groups";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { unreadBadge } from "../../m/sidebar/unread";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { SessionAvatar } from "../SessionAvatar";
import { shadow } from "../styles";
import { tip } from "../tip";
import { AgentAvatar } from "./AgentAvatar";
import type { MenuAt } from "./SessionRow";

function PinnedItem(props: {
  session: SessionSummary;
  contextOpen: boolean;
  onContextMenu: (at: MenuAt, session: SessionSummary) => void;
  botsById: ReadonlyMap<string, Bot>;
  botStatusOf: (botId: string) => SessionStatusResult | undefined;
  status: SessionStatusResult;
  unread: number;
  title: string;
  archivedSuffix: string;
  onDragSession?: (event: PressEvent, session: SessionSummary) => void;
}) {
  const t = () => copy();
  const active = () => runtime.selectedId === props.session.id;
  const run = () => props.status.isBusy;
  const ring = () => (active() ? token("accent-tint") : token("btn-secondary-bg"));
  const frame = () => {
    if (run()) return "border-brand";
    if (active()) return "border-brand bg-accent-tint";
    if (props.contextOpen) return "border-accent-border bg-accent-tint";
    if (props.unread > 0) return "border-accent-border bg-btn-secondary-bg";
    return "border-line bg-btn-secondary-bg hover:border-line-hover hover:bg-btn-secondary-hover";
  };
  return (
    <View
      role="button"
      testID={`pinned-${props.session.id}`}
      accessibilityLabel={`${props.title}${props.archivedSuffix}`}
      accessibilityState={{ selected: active() }}
      tooltip={tip(`${props.title}${props.archivedSuffix}`)}
      onPress={() => void runtime.selectSession(props.session.id)}
      onContextMenu={(e) => props.onContextMenu({ x: e.pagePosition.x, y: e.pagePosition.y }, props.session)}
      onLongPress={(e) => props.onContextMenu({ x: e.pagePosition.x, y: e.pagePosition.y }, props.session)}
      onPressDown={props.onDragSession ? (e) => props.onDragSession?.(e, props.session) : undefined}
      class={`items-center justify-start gap-[3px] w-[58px] h-[60px] shrink-0 pt-1 px-[2px] pb-[2px] rounded-(--radius-md) border active:scale-[0.97] ${frame()}`}
      style={{ boxShadow: shadow("xs") }}
    >
      <View class="relative items-center justify-center shrink-0" style={{ width: 36, height: 36 }}>
        <If
          when={!isFileDropSession(props.session)}
          else={
            <View testID="file-drop-mark" accessible={false} class="items-center justify-center bg-accent-tint" style={{ width: 34, height: 34, borderRadius: 10 }}>
              <Icon name="file-down" size={16} class="tint-brand" />
            </View>
          }
        >
          <If
            when={props.session.kind === "project"}
            else={<SessionAvatar session={props.session} bots={props.botsById} botStatus={props.botStatusOf} size="top" ringColor={ring()} />}
          >
            {/* Its agent's mark, as its row under its directory wears it (ADR 0095). */}
            <AgentAvatar
              agent={projectAgentOf(props.session)}
              title={t().project.agentNames[projectAgentOf(props.session)]}
              status={props.status}
              ringColor={ring()}
              edge={34}
            />
          </If>
        </If>
        <If when={run()}>
          {/* Working is the accent everywhere: the row, the portrait dot and this. Green means done. */}
          <View testID="pinned-run-dot" class="absolute rounded-full bg-brand" style={{ top: -2, right: -2, width: 9, height: 9, borderWidth: 2, borderColor: token("sidebar-bg") }} />
        </If>
        <If
          when={props.status.count}
          else={
            <If when={props.unread > 0}>
              <View
                testID="pinned-unread"
                tooltip={tip(t().sidebar.unread)}
                class="absolute items-center justify-center min-w-[15px] h-[15px] px-[3px] rounded-(--radius-md) bg-mustard"
                style={{ top: -5, right: -5, borderWidth: 1.5, borderColor: token("sidebar-bg") }}
              >
                <Text class="text-[10px] font-bold text-on-mustard">{unreadBadge(props.unread)}</Text>
              </View>
            </If>
          }
        >
          {(count) => (
            <View
              testID="pinned-badge"
              class="absolute items-center justify-center min-w-[15px] h-[15px] px-[3px] rounded-(--radius-md) bg-warn"
              style={{ top: -4, right: -4, borderWidth: 1.5, borderColor: token("sidebar-bg") }}
            >
              <Text class="text-[10px] font-bold text-on-warn">{String(count())}</Text>
            </View>
          )}
        </If>
      </View>
      <Text class={`w-full text-[11px] leading-[13px] text-center line-clamp-1 ${active() ? "text-brand font-semibold" : "text-ink font-medium"}`}>{props.title}</Text>
    </View>
  );
}

export function PinnedRoster(props: {
  pinnedSessions: SessionSummary[];
  /** Marks the pin the context menu belongs to. */
  contextMenuSessionId: string | null;
  onOpenContextMenu: (at: MenuAt, session: SessionSummary) => void;
  botsById: ReadonlyMap<string, Bot>;
  botStatusOf: (botId: string) => SessionStatusResult | undefined;
  statusOf: (session: SessionSummary) => SessionStatusResult;
  unreadOf: (session: SessionSummary) => number;
  titleOf: (session: SessionSummary) => string;
  archivedSuffix: (session: SessionSummary) => string;
  /** A press on a pin that may become a drag into the workbench: only where there is one. */
  onDragSession?: (event: PressEvent, session: SessionSummary) => void;
}) {
  const expanded = signal(false);
  const items = () =>
    props.pinnedSessions.map((s) => (
      <PinnedItem
        session={s}
        contextOpen={props.contextMenuSessionId === s.id}
        onContextMenu={props.onOpenContextMenu}
        botsById={props.botsById}
        botStatusOf={props.botStatusOf}
        status={props.statusOf(s)}
        unread={props.unreadOf(s)}
        title={props.titleOf(s)}
        archivedSuffix={props.archivedSuffix(s)}
        onDragSession={props.onDragSession}
      />
    ));
  return (
    <View testID="pinned-roster" accessibilityLabel={copy().sidebar.pinned} class="flex-row items-center">
      <If
        when={expanded()}
        else={
          <Scroll horizontal class="flex-1 min-w-0 min-h-[72px]" contentClass="flex-row items-start gap-[6px] px-[10px] py-2">
            {items}
          </Scroll>
        }
      >
        <Scroll class="flex-1 min-w-0 max-h-[200px]" contentClass="flex-row flex-wrap items-start gap-x-[6px] gap-y-2 px-[10px] py-2">
          {items}
        </Scroll>
      </If>
      <If when={props.pinnedSessions.length > 5}>
        <View
          role="button"
          testID="pinned-expand"
          accessibilityLabel={expanded() ? copy().sidebar.collapse : copy().sidebar.expand}
          tooltip={tip(expanded() ? copy().sidebar.collapse : copy().sidebar.expand)}
          onPress={() => expanded.set(!expanded())}
          class="group w-[28px] h-[28px] mr-[10px] shrink-0 items-center justify-center rounded-(--radius-sm) border border-line bg-btn-secondary-bg hover:border-line-hover hover:bg-line-subtle"
          style={{ boxShadow: shadow("xs") }}
        >
          <Icon name={expanded() ? "chevron-up" : "chevron-down"} size={12} class="tint-ink-muted group-hover:tint-ink" />
        </View>
      </If>
    </View>
  );
}
