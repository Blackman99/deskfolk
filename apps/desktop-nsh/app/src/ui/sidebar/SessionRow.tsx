/**
 * One row of the session list (`sidebar/SessionRow.svelte`): avatar, title, time, status and the
 * last line. The lists (archived, file drop, groups, you↔Bot, a project's sessions) differ only in
 * what they pass: the text, whether the status carries its count, and what stands where the avatar
 * goes.
 *
 * Under the pointer a row offers its two most used actions without a right-click: pin, and ⋯ for the
 * rest of its menu. They sit beside the row's pressable view, never inside it. A phone has no hover:
 * its menu opens with a long press. The row's height is fixed by its two lines (a status replaces
 * the last line, it never adds one), so a virtualised `List` can rely on it.
 *
 * Differences from the Svelte row: `onContextMenu` and `onPointerDown` take NSH's events (the menu's
 * place is `at`, in the window), and a phone's hairline between rows (`.row-flip + .row-flip`) is not
 * drawn, the row has no sibling to ask.
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
import { SIDE_MUTED_TEXT, SIDE_MUTED_TINT } from "../glass";

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
function FileDropMark() {
  const edge = () => rowAvatarEdge();
  return (
    <View
      testID="file-drop-mark"
      accessible={false}
      class="items-center justify-center shrink-0 bg-accent-tint"
      style={{ width: edge(), height: edge(), borderRadius: edge() * 0.3 }}
    >
      <Icon name="file-down" size={20} class="tint-brand" />
    </View>
  );
}

export function SessionRow(props: {
  session: SessionSummary;
  /** The open conversation. */
  on: boolean;
  /** The row the context menu belongs to. */
  contextOpen: boolean;
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
  const t = () => copy();
  const phone = () => narrowWindow();
  const hovered = signal(false);
  const idle = () => props.status.kind === "idle";
  const unreadOn = () => props.unread > 0;
  const showActions = () => Boolean(props.onTogglePin) && hovered() && !phone() && platform.desktop;
  /** The ring that cuts the status dot out of the avatar: the surface the row stands on. */
  const ring = () => (props.on ? token("pane") : phone() ? token("sidebar-bg") : token("ground"));
  const at = (e: { pagePosition: { x: number; y: number } }): MenuAt => ({ x: e.pagePosition.x, y: e.pagePosition.y });
  const rowClass = () => {
    const base = phone() ? "px-[14px] py-[10px] gap-3" : "mx-0 my-[1px] px-[10px] py-2 gap-[10px] rounded-(--radius-md) border";
    if (props.on) return phone() ? `${base} bg-accent-tint` : `${base} bg-pane border-line`;
    if (props.contextOpen) return `${base} bg-line-subtle ${phone() ? "" : "border-transparent"}`;
    return `${base} hover:bg-row-hover ${phone() ? "" : "border-transparent"}`;
  };

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
        onPress={() => props.onSelect()}
        onContextMenu={(e) => props.onContextMenu(at(e))}
        onLongPress={phone() || !platform.desktop ? (e) => props.onContextMenu(at(e)) : undefined}
        {...sessionPan(() => props.onDrag)}
        delayLongPress={450}
        class={`cursor-pointer select-none flex-row items-center active:scale-[0.985] ${rowClass()} ${props.archived ? "opacity-[0.85]" : ""}`}
        style={props.on && !phone() ? { boxShadow: shadow("sm") } : undefined}
      >
        <If
          when={!props.fileDrop}
          else={<FileDropMark />}
        >
          <If
            when={props.agent}
            else={
              <View class="items-center justify-center shrink-0" style={{ width: rowAvatarEdge(), height: rowAvatarEdge() }}>
                <SessionAvatar session={props.session} bots={props.bots} botStatus={props.botStatus} statusNote={props.elsewhere} ringColor={ring()} />
              </View>
            }
          >
            {(agent) => <AgentAvatar agent={agent()} title={t().project.agentNames[agent()]} status={props.status} ringColor={ring()} />}
          </If>
        </If>
        <View class="flex-1 min-w-0">
          <View class="flex-row items-center gap-[10px]">
            <Text
              testID="row-title"
              class={`flex-1 min-w-0 text-ink line-clamp-1 ${phone() ? "text-[16px] leading-6" : "text-[14px] leading-[21px]"} ${unreadOn() ? "font-bold" : "font-semibold"}`}
            >
              {props.title}
            </Text>
            <Text
              testID="row-time"
              class={`${phone() ? "text-[12px]" : "text-[11px]"} leading-[17px] ${unreadOn() ? "text-mustard-ink font-semibold" : SIDE_MUTED_TEXT} ${showActions() ? "opacity-0" : ""}`}
            >
              {props.time}
            </Text>
          </View>
          <View class={`flex-row items-center gap-[5px] mt-[2px] ${phone() ? "h-[18px]" : "h-[17px]"}`}>
            <If
              when={!idle()}
              else={
                <Text
                  testID="row-preview"
                  class={`flex-1 min-w-0 line-clamp-1 ${phone() ? "text-[13px]" : "text-[12px]"} ${props.elsewhere ? "text-brand" : SIDE_MUTED_TEXT}`}
                >
                  {props.elsewhere ?? props.preview}
                </Text>
              }
            >
              <View testID="row-status" class="flex-1 min-w-0 flex-row items-center gap-[5px]">
                <View class={`w-[6px] h-[6px] rounded-full shrink-0 ${STATUS_DOT[props.status.kind] ?? "bg-ok"}`} />
                <Text class={`min-w-0 line-clamp-1 ${phone() ? "text-[13px]" : "text-[12px]"} ${STATUS_TEXT[props.status.kind] ?? SIDE_MUTED_TEXT}`}>
                  {props.status.label}
                </Text>
                <If when={(props.showCount ?? true) && props.status.count}>
                  {(count) => (
                    <View class="h-[16px] min-w-[16px] px-[4px] ml-[2px] rounded-full bg-warn items-center justify-center">
                      <Text class="text-[10px] font-bold text-on-warn">{String(count())}</Text>
                    </View>
                  )}
                </If>
              </View>
            </If>
          </View>
        </View>
        <If when={unreadOn()}>
          <View
            testID="unread-dot"
            tooltip={tip(t().sidebar.unread)}
            class={`items-center justify-center rounded-full bg-mustard ${phone() ? "min-w-[18px] h-[18px] px-[5px]" : "min-w-[16px] h-[16px] px-[4px]"} ${showActions() ? "opacity-0" : ""}`}
          >
            <Text class={`font-bold text-on-mustard ${phone() ? "text-[11px]" : "text-[10px]"}`}>{unreadBadge(props.unread)}</Text>
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
            class="flex-row gap-[2px] p-[2px] rounded-[9px] bg-pane border border-line"
            style={{ boxShadow: shadow("md") }}
          >
            <View
              role="button"
              testID={`session-pin-${props.session.id}`}
              accessibilityLabel={props.pinned ? t().sidebar.unpin : t().sidebar.pin}
              accessibilityState={{ selected: props.pinned === true }}
              tooltip={tip(props.pinned ? t().sidebar.unpin : t().sidebar.pin)}
              onPress={() => props.onTogglePin?.()}
              class="cursor-pointer select-none group w-[26px] h-[26px] rounded-[7px] items-center justify-center hover:bg-row-hover active:scale-[0.9]"
            >
              <Icon name="pin" size={16} class={props.pinned ? "tint-brand" : `${SIDE_MUTED_TINT} group-hover:tint-ink`} />
            </View>
            <View
              role="button"
              testID={`session-more-${props.session.id}`}
              accessibilityLabel={t().chat.moreActions}
              tooltip={tip(t().chat.moreActions)}
              onPress={(e) => props.onContextMenu(at(e))}
              class="cursor-pointer select-none group w-[26px] h-[26px] rounded-[7px] items-center justify-center hover:bg-row-hover active:scale-[0.9]"
            >
              <Icon name="more" size={16} class={`${SIDE_MUTED_TINT} group-hover:tint-ink`} />
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}
