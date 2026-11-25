/**
 * Top "进行中" live mirror strip in the sidebar: surfaces every conversation currently waiting on
 * you, actively thinking/replying (including direct Bot activity elsewhere), or remote file drops
 * with unread files. Sessions remain in their home sections so the list below never jumps.
 */
import { platform, Scroll, Text, View } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { projectAgentOf } from "../../m/sidebar/project-groups";
import { unreadBadge } from "../../m/sidebar/unread";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { SessionAvatar } from "../SessionAvatar";
import { tip } from "../tip";
import { SEAM_BORDER, SIDE_MUTED_TEXT, windowGlass } from "../glass";
import { AgentAvatar } from "./AgentAvatar";
import { foldMotion } from "./fold-motion";
import type { LiveStripItem } from "./live-strip-model";
import { sessionPan, type SessionDragHandler } from "./session-drag";
import type { MenuAt } from "./SessionRow";

const STATUS_DOT: Record<string, string> = {
  running: "bg-brand",
  replying: "bg-brand",
  waiting_approval: "bg-warn",
  waiting_ask: "bg-purple",
  failed: "bg-danger",
  interrupted: "bg-danger",
};

const STATUS_TEXT: Record<string, string> = {
  running: "text-brand",
  replying: "text-brand",
  waiting_approval: "text-warn-text",
  waiting_ask: "text-purple-text",
  failed: "text-danger-text",
  interrupted: "text-danger-text",
};

export function LiveStrip(props: {
  items: readonly LiveStripItem[];
  selectedId: string | null;
  contextMenuSessionId: string | null;
  botsById: ReadonlyMap<string, Bot>;
  titleOf: (session: SessionSummary) => string;
  onSelect: (session: SessionSummary) => void;
  onOpenContextMenu: (at: MenuAt, session: SessionSummary) => void;
  onDragSession?: SessionDragHandler;
}) {
  const fold = foldMotion();
  const t = () => copy();
  const at = (e: { pagePosition: { x: number; y: number } }): MenuAt => ({ x: e.pagePosition.x, y: e.pagePosition.y });

  const rowLook = (selected: boolean, contextOpen: boolean) => {
    if (selected) return windowGlass ? "bg-ink/10 border-ink/10" : "bg-pane border-line";
    if (contextOpen) return "bg-ink/6 border-transparent";
    return "border-transparent hover:bg-row-hover";
  };

  return (
    <If when={props.items.length > 0}>
      <View
        testID="live-strip"
        role="region"
        accessibilityLabel={t().sidebar.liveSection}
        class={`mx-2 mb-[6px] px-[6px] pt-[5px] pb-[4px] rounded-(--radius-md) bg-ink/4 border ${SEAM_BORDER} shrink-0`}
        style={fold?.text}
      >
        <View class="flex-row items-center gap-[5px] px-[4px] pb-[3px]">
          <View accessible={false} class="w-[6px] h-[6px] rounded-full bg-brand shrink-0" />
          <Text class={`text-[11px] font-semibold ${SIDE_MUTED_TEXT}`}>{t().sidebar.liveSection}</Text>
          <Text testID="live-strip-count" class={`text-[11px] font-medium ${SIDE_MUTED_TEXT}`}>
            {String(props.items.length)}
          </Text>
        </View>
        <Scroll style={{ maxHeight: 160 }}>
          <Each of={props.items} key={(item) => item.session.id}>
            {(item) => {
              const session = () => item().session;
              const selected = () => props.selectedId === session().id;
              const contextOpen = () => props.contextMenuSessionId === session().id;
              const title = () => (item().kind === "file-drop" ? t().sidebar.fileDrop : props.titleOf(session()));
              const statusLabel = () => {
                if (item().kind === "file-drop") return "";
                if (item().elsewhere) return item().elsewhere!;
                return item().status.label;
              };
              const tooltipText = () => {
                const prefix = item().dirLabel ? `${item().dirLabel} / ` : "";
                const note = statusLabel();
                return note ? `${prefix}${title()} · ${note}` : `${prefix}${title()}`;
              };
              return (
                <View
                  role="button"
                  testID={`live-${session().id}`}
                  accessibilityLabel={title()}
                  accessibilityState={{ selected: selected() }}
                  tooltip={tip(tooltipText())}
                  onPress={() => props.onSelect(session())}
                  onContextMenu={(e) => props.onOpenContextMenu(at(e), session())}
                  onLongPress={!platform.desktop ? (e) => props.onOpenContextMenu(at(e), session()) : undefined}
                  {...sessionPan(() => (props.onDragSession ? (phase, point) => props.onDragSession?.(phase, point, session()) : undefined))}
                  class={`cursor-pointer select-none flex-row items-center gap-[7px] px-[6px] py-[4px] my-[1px] rounded-(--radius-sm) border active:scale-[0.985] ${rowLook(selected(), contextOpen())}`}
                >
                  <If
                    when={item().kind === "file-drop"}
                    else={
                      <If
                        when={item().kind === "project"}
                        else={<SessionAvatar session={session()} bots={props.botsById} size="tab" hideStatusDot />}
                      >
                        <AgentAvatar
                          agent={projectAgentOf(session())}
                          title={t().project.agentNames[projectAgentOf(session())]}
                          compact
                          edge={18}
                        />
                      </If>
                    }
                  >
                    <View accessible={false} class="w-[18px] h-[18px] items-center justify-center rounded-(--radius-xs) bg-accent-tint shrink-0">
                      <Icon name="file-down" size={12} class="tint-brand" />
                    </View>
                  </If>
                  <View class="flex-1 min-w-0 flex-row items-center gap-[4px]">
                    <If when={item().dirLabel}>
                      {(dir) => (
                        <Text class={`shrink-0 text-[11px] font-medium ${SIDE_MUTED_TEXT}`}>{`${dir()} /`}</Text>
                      )}
                    </If>
                    <Text class={`flex-1 min-w-0 text-[12px] leading-[17px] line-clamp-1 text-ink ${selected() ? "font-semibold" : "font-medium"}`}>
                      {title()}
                    </Text>
                  </View>
                  <If
                    when={item().kind === "file-drop"}
                    else={
                      <View class="flex-row items-center gap-[4px] shrink-0 max-w-[160px]">
                        <View
                          accessible={false}
                          class={`w-[5px] h-[5px] rounded-full shrink-0 ${item().elsewhere ? "bg-brand" : (STATUS_DOT[item().status.kind] ?? "bg-brand")}`}
                        />
                        <Text
                          class={`text-[11px] font-semibold line-clamp-1 ${item().elsewhere ? "text-brand" : (STATUS_TEXT[item().status.kind] ?? "text-brand")}`}
                        >
                          {statusLabel()}
                        </Text>
                        <If when={item().status.count}>
                          {(count) => (
                            <View class="h-[15px] min-w-[15px] px-[3px] rounded-full bg-warn-text items-center justify-center shrink-0">
                              <Text class="text-[10px] font-bold text-on-warn">{String(count())}</Text>
                            </View>
                          )}
                        </If>
                      </View>
                    }
                  >
                    <View class="min-w-[16px] h-[16px] px-[4px] rounded-full bg-mustard items-center justify-center shrink-0">
                      <Text class="text-[10px] font-bold text-on-mustard">{unreadBadge(item().unread)}</Text>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </Scroll>
      </View>
    </If>
  );
}
