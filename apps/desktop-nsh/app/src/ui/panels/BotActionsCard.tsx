/**
 * The actions tab (`BotActionsCard.svelte`): archive, the session mute, the direct's engine
 * (ADR 0085), and the danger zone.
 */
import { Text, View } from "nsh";
import type { Bot } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { PlaybookPicker } from "./PlaybookPicker";
import { SessionMuteRow } from "./SessionMuteRow";
import { PANEL_CARD, PANEL_CARD_BODY, PANEL_CARD_HEAD, PANEL_CARD_TITLE, PANEL_SECTION } from "./panel-card";

/** `.action-btn`: a small button beside what it does; `deny` is the red one. */
function ActionButton(props: { testID: string; icon: IconName; deny?: boolean; onPress: () => void; children: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.children}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none group flex-row items-center justify-center gap-[6px] px-[14px] py-[6px] rounded-(--radius-md) border shrink-0 ${
        props.deny
          ? "bg-danger-bg border-danger-line hover:bg-danger hover:border-danger"
          : "bg-btn-secondary-bg border-line hover:bg-line-subtle hover:border-line-hover"
      }`}
    >
      <Icon name={props.icon} size={16} class={props.deny ? "tint-danger-text group-hover:tint-on-danger" : "tint-ink-secondary group-hover:tint-ink"} />
      <Text
        class={`text-[12px] font-semibold ${props.deny ? "text-danger-text group-hover:text-on-danger" : "text-ink-secondary group-hover:text-ink"}`}
      >
        {props.children}
      </Text>
    </View>
  );
}

function ActionInfo(props: { title: string; desc: string; danger?: boolean }) {
  return (
    <View class="flex-1 min-w-0 gap-[2px]">
      <Text class={`text-[13px] font-semibold ${props.danger ? "text-danger-text" : "text-ink"}`}>{props.title}</Text>
      <Text class="text-[12px] text-ink-muted">{props.desc}</Text>
    </View>
  );
}

export function BotActionsCard(props: {
  bot: Bot;
  selectedKind: string | null;
  archiveProfile: () => Promise<void>;
  restoreProfile: () => Promise<void>;
  onDeleteBot: () => void;
  onClearHistory: () => void;
  /** Edge to edge, with no gutter round it (ProfilePane on a wider window). */
  flush?: boolean;
}) {
  const t = () => copy();
  return (
    <>
      <View testID="bot-actions-card" class={props.flush ? PANEL_SECTION : PANEL_CARD}>
        <View class={PANEL_CARD_HEAD}>
          <Text class={PANEL_CARD_TITLE}>{t().detail.sessionActions}</Text>
        </View>
        <View class={PANEL_CARD_BODY}>
          <View class="flex-row items-center justify-between gap-[14px]">
            <ActionInfo
              title={props.bot.archived_at ? t().sidebar.restore : t().sidebar.archive}
              desc={props.bot.archived_at ? t().sidebar.restoreBody : t().sidebar.archiveBody}
            />
            <If
              when={props.bot.archived_at}
              else={
                <ActionButton testID="bot-archive" icon="archive" onPress={() => void props.archiveProfile()}>
                  {t().sidebar.archive}
                </ActionButton>
              }
            >
              <ActionButton testID="bot-restore" icon="rotate-ccw" onPress={() => void props.restoreProfile()}>
                {t().sidebar.restore}
              </ActionButton>
            </If>
          </View>
          <If when={runtime.selectedId}>
            {(sessionId) => (
              <>
                <View class="mt-4 pt-4 border-t border-line">
                  <SessionMuteRow sessionId={sessionId()} />
                </View>
                <If when={props.selectedKind === "you-bot"}>
                  <View class="mt-4 pt-4 border-t border-line">
                    <PlaybookPicker sessionId={sessionId()} />
                  </View>
                </If>
              </>
            )}
          </If>
        </View>
      </View>

      {/* A card even where the sections run edge to edge: set off from the sides, so the red band reads as a warning, not a divider. */}
      <View testID="bot-danger-zone" class={`bg-pane border border-danger-line rounded-(--radius-lg) min-w-0 ${props.flush ? "mx-4 mb-4" : ""}`}>
        <View class="flex-row items-center justify-between px-4 py-3 border-b border-danger-line bg-danger-bg rounded-t-(--radius-lg)">
          <Text class="text-[12px] font-semibold text-danger-text">{t().detail.dangerZone}</Text>
        </View>
        <View class={`${PANEL_CARD_BODY} gap-6`}>
          <If when={props.selectedKind === "you-bot"}>
            <View class="flex-row items-center justify-between gap-[14px]">
              <ActionInfo title={t().detail.clearHistory} desc={t().detail.clearHistoryBody} />
              <ActionButton testID="bot-clear-history" icon="rotate-ccw" onPress={props.onClearHistory}>
                {t().detail.clearHistory}
              </ActionButton>
            </View>
          </If>
          <View class={`flex-row items-center justify-between gap-[14px] ${props.selectedKind === "you-bot" ? "pt-3 border-t border-line-subtle" : ""}`}>
            <ActionInfo danger title={t().sidebar.delete} desc={t().sidebar.deleteBody} />
            <ActionButton testID="bot-delete" icon="trash" deny onPress={props.onDeleteBot}>
              {t().sidebar.delete}
            </ActionButton>
          </View>
        </View>
      </View>
    </>
  );
}
