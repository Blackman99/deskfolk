/**
 * One row of the session list (`sidebar/SessionRow.svelte`): avatar, title, time, status and the
 * last line. Desktop Bot rows use `compact` mode (28px avatar, single-line ~38px when idle,
 * expanding cleanly for unread previews, live statuses, or elsewhere activity); phone, archived,
 * and standalone rows keep the two-line layout.
 *
 * Under the pointer a row offers its two most used actions without a right-click: pin, and ⋯ for the
 * rest of its menu. They sit beside the row's pressable view, never inside it.
 */
import { platform, signal, Text, token, View } from "nsh";
import type { Bot, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import { sessionPan, type SessionDrag } from "./session-drag";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { unreadBadge } from "../../m/sidebar/unread";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { SessionAvatar } from "../SessionAvatar";
import { shadow } from "../styles";
import { tip } from "../tip";
import { AgentAvatar, rowAvatarEdge } from "./AgentAvatar";
import { SIDE_MUTED_TEXT, SIDE_MUTED_TINT, windowGlass } from "../glass";
import { foldMotion } from "./fold-motion";

export type MenuAt = { x: number; y: number };

const STATUS_DOT: Record<string, string> = {
  running: "bg-brand",
  replying: "bg-brand",
  waiting_approval: "bg-warn",
  waiting_ask: "bg-purple",
  failed: "bg-danger",
  interrupted: "bg-danger",
};
const STATUS_TEXT: Record<string, string> = {
  running: "text-brand font-semibold",
  replying: "text-brand font-semibold",
  waiting_approval: "text-warn-text font-semibold",
  waiting_ask: "text-purple-text font-semibold",
  failed: "text-danger-text font-semibold",
  interrupted: "text-danger-text font-semibold",
};

/** The file drop's mark where the avatar goes. */
function FileDropMark(props: { compact?: boolean }) {
  const edge = () => (props.compact ? 28 : rowAvatarEdge());
  return (
    <View
      testID="file-drop-mark"
      accessible={false}
      class="items-center justify-center shrink-0 bg-accent-tint"
      style={{ width: edge(), height: edge(), borderRadius: edge() * 0.3 }}
    >
      <Icon name="file-down" size={props.compact ? 16 : 20} class="tint-brand" />
    </View>
  );
}

export function SessionRow(props: {
  session: SessionSummary;
  /** The open conversation. */
  on: boolean;
  /** The row the context menu belongs to. */
  contextOpen: boolean;
  /** Compact desktop Bot row: 28px avatar, single line when idle, expands for unread or live status. */
  compact?: boolean;
  /** The archived list dims its rows. */
  archived?: boolean;
  /** The file drop's row has a mark of its own where the avatar goes. */
  fileDrop?: boolean;
  /** A project session's row (ADR 0095) wears its agent's mark there, its status dot the run's. */
  agent?: ProjectAgent | null;
  title: string;
  time: string;
  status: SessionStatusResult;
  /** The file drop's status has no count beside it. */
  showCount?: boolean;
  preview: string;
  /** In your direct with a Bot that works elsewhere, where: said in place of the last line. */
  elsewhere?: string | null;
  unread: number;
  bots: ReadonlyMap<string, Bot>;
  botStatus: (botId: string) => SessionStatusResult | undefined;
  onSelect: () => void;
  /** The menu was asked for (right click, a long press, ⋯), at this place in the window. */
  onContextMenu: (at: MenuAt) => void;
  /** The row pulled onto the workbench: only where there is one. A press that does not travel is still `onSelect`. */
  onDrag?: SessionDrag;
  /** Whether the row is pinned; with `onTogglePin`, the row offers pin and ⋯ under the pointer. */
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const fold = foldMotion();
  const t = () => copy();
  const phone = () => narrowWindow();
  const compact = () => Boolean(props.compact) && !phone();
  const hovered = signal(false);
  const idle = () => props.status.kind === "idle";
  const unreadOn = () => props.unread > 0;
  const activeNow = () => !idle() || Boolean(props.elsewhere);
  const showSecondLine = () => !compact() || activeNow() || unreadOn();
  const showActions = () => Boolean(props.onTogglePin) && hovered() && !phone() && platform.desktop;
  const avatarEdge = () => (compact() ? 28 : rowAvatarEdge());
  /** The ring that cuts the status dot out of the avatar: the surface the row stands on. */
  const ring = () => (props.on ? token("pane") : phone() ? token("sidebar-bg") : token("ground"));
  const at = (e: { pagePosition: { x: number; y: number } }): MenuAt => ({ x: e.pagePosition.x, y: e.pagePosition.y });

  const rowClass = () => {
    const base = phone()
      ? "px-[14px] py-[10px] gap-3"
      : compact()
        ? "mx-0 my-[1px] px-[8px] py-[5px] gap-[9px] rounded-(--radius-md) border"
        : "mx-0 my-[1px] px-[10px] py-2 gap-[10px] rounded-(--radius-md) border";
    if (props.on) {
      if (phone()) return `${base} bg-accent-tint`;
      return windowGlass ? `${base} bg-ink/10 border-ink/10` : `${base} bg-pane border-line`;
    }
    if (props.contextOpen) return `${base} ${windowGlass && !phone() ? "bg-ink/6" : "bg-line-subtle"} ${phone() ? "" : "border-transparent"}`;
    return `${base} hover:bg-row-hover ${phone() ? "" : "border-transparent"}`;
  };

  /** Hover preview tooltip for compact idle rows so users can peek at the last line without layout jank. */
  const rowTip = () => {
    if (!compact() || showSecondLine()) return undefined;
    return props.preview ? tip(`${props.title}\n${props.preview}`) : undefined;
  };

  /** Only hide the time while hover actions (pin / more) sit in its slot. */
  const hideTime = () => showActions();

  return (
    <View
      class="relative"
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
    >
      <View
        role="button"
        testID={`session-${props.session.id}`}
        accessibilityLabel={props.title}
        accessibilityState={{ selected: props.on }}
        tooltip={rowTip()}
        onPress={() => props.onSelect()}
        onContextMenu={(e) => props.onContextMenu(at(e))}
        onLongPress={phone() || !platform.desktop ? (e) => props.onContextMenu(at(e)) : undefined}
        {...sessionPan(() => props.onDrag)}
        delayLongPress={450}
        class={`cursor-pointer select-none flex-row items-center active:scale-[0.985] ${rowClass()} ${props.archived ? "opacity-[0.85]" : ""}`}
        style={props.on && !phone() && !windowGlass ? { boxShadow: shadow("xs") } : undefined}
      >
        <If
          when={!props.fileDrop}
          else={<FileDropMark compact={compact()} />}
        >
          <If
            when={props.agent}
            else={
              <View class="items-center justify-center shrink-0" style={{ width: avatarEdge(), height: avatarEdge() }}>
                <SessionAvatar
                  session={props.session}
                  bots={props.bots}
                  botStatus={props.botStatus}
                  statusNote={props.elsewhere}
                  size={compact() ? "sm" : "md"}
                  hideStatusDot={compact()}
                  ringColor={ring()}
                />
              </View>
            }
          >
            {(agent) => <AgentAvatar agent={agent()} title={t().project.agentNames[agent()]} status={props.status} ringColor={ring()} />}
          </If>
        </If>
        <View class="flex-1 min-w-0" style={fold?.text}>
          <View class="flex-row items-center gap-[8px]">
            <Text
              testID="row-title"
              class={`flex-1 min-w-0 text-ink line-clamp-1 ${
                phone() ? "text-[16px] leading-6" : compact() ? "text-[13.5px] leading-[19px]" : "text-[14px] leading-[21px]"
              } ${unreadOn() || props.on ? "font-semibold" : compact() ? "font-medium" : "font-semibold"}`}
            >
              {props.title}
            </Text>
            <If when={!hideTime()}>
              <Text
                testID="row-time"
                class={`shrink-0 ${phone() ? "text-[12px]" : "text-[11px]"} leading-[17px] ${unreadOn() ? "text-mustard-ink font-semibold" : SIDE_MUTED_TEXT}`}
              >
                {props.time}
              </Text>
            </If>
          </View>
          <If when={showSecondLine()}>
            <View class={`flex-row items-center gap-[5px] mt-[2px] ${phone() ? "h-[18px]" : "h-[17px]"}`}>
              <If
                when={!idle()}
                else={
                  <If
                    when={props.elsewhere}
                    else={
                      <Text
                        testID="row-preview"
                        class={`flex-1 min-w-0 line-clamp-1 ${phone() ? "text-[13px]" : "text-[12px]"} ${SIDE_MUTED_TEXT}`}
                      >
                        {props.preview}
                      </Text>
                    }
                  >
                    {(where) => (
                      <View testID="row-elsewhere" class="flex-1 min-w-0 flex-row items-center gap-[5px]">
                        <View accessible={false} class="w-[6px] h-[6px] rounded-full shrink-0 bg-brand" />
                        <Text testID="row-preview" class={`flex-1 min-w-0 line-clamp-1 ${phone() ? "text-[13px]" : "text-[12px]"} text-brand font-medium`}>
                          {where()}
                        </Text>
                      </View>
                    )}
                  </If>
                }
              >
                <View testID="row-status" class="flex-1 min-w-0 flex-row items-center gap-[5px]">
                  <View class={`w-[6px] h-[6px] rounded-full shrink-0 ${STATUS_DOT[props.status.kind] ?? "bg-ok"}`} />
                  <Text class={`min-w-0 line-clamp-1 ${phone() ? "text-[13px]" : "text-[12px]"} ${STATUS_TEXT[props.status.kind] ?? SIDE_MUTED_TEXT}`}>
                    {props.status.label}
                  </Text>
                  <If when={(props.showCount ?? true) && props.status.count}>
                    {(count) => (
                      <View class="h-[16px] min-w-[16px] px-[4px] ml-[2px] rounded-full bg-warn-text items-center justify-center">
                        <Text class="text-[10px] font-bold text-on-warn">{String(count())}</Text>
                      </View>
                    )}
                  </If>
                </View>
              </If>
            </View>
          </If>
        </View>
        <If when={unreadOn()}>
          {/* Its own opacity says when the pointer's actions cover it, so the fold moves a box around it. */}
          <View style={fold?.text}>
            <View
              testID="unread-dot"
              tooltip={tip(t().sidebar.unread)}
              class={`items-center justify-center rounded-full bg-mustard ${phone() ? "min-w-[18px] h-[18px] px-[5px]" : "min-w-[16px] h-[16px] px-[4px]"} ${showActions() ? "opacity-0" : ""}`}
            >
              <Text class={`font-bold text-on-mustard ${phone() ? "text-[11px]" : "text-[10px]"}`}>{unreadBadge(props.unread)}</Text>
            </View>
          </View>
        </If>
      </View>
      <If when={showActions()}>
        <View
          testID={`session-actions-${props.session.id}`}
          class="absolute right-2 top-0 bottom-0 justify-center"
          style={{ pointerEvents: "box-none" }}
        >
          <View
            class="flex-row gap-[2px] p-[2px] rounded-(--radius-pill-group) bg-pane border border-line"
            style={{ boxShadow: shadow("md") }}
          >
            <View
              role="button"
              testID={`session-pin-${props.session.id}`}
              accessibilityLabel={props.pinned ? t().sidebar.unpin : t().sidebar.pin}
              accessibilityState={{ selected: props.pinned === true }}
              tooltip={tip(props.pinned ? t().sidebar.unpin : t().sidebar.pin)}
              onPress={() => props.onTogglePin?.()}
              class={`cursor-pointer select-none group rounded-(--radius-control-sm) items-center justify-center hover:bg-row-hover active:scale-[0.9] ${compact() ? "w-[24px] h-[24px]" : "w-[26px] h-[26px]"}`}
            >
              <Icon name="pin" size={compact() ? 12 : 16} class={props.pinned ? "tint-brand" : `${SIDE_MUTED_TINT} group-hover:tint-ink`} />
            </View>
            <View
              role="button"
              testID={`session-more-${props.session.id}`}
              accessibilityLabel={t().chat.moreActions}
              tooltip={tip(t().chat.moreActions)}
              onPress={(e) => props.onContextMenu(at(e))}
              class={`cursor-pointer select-none group rounded-(--radius-control-sm) items-center justify-center hover:bg-row-hover active:scale-[0.9] ${compact() ? "w-[24px] h-[24px]" : "w-[26px] h-[26px]"}`}
            >
              <Icon name="more" size={compact() ? 12 : 16} class={`${SIDE_MUTED_TINT} group-hover:tint-ink`} />
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}
