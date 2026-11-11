/**
 * The way into a Bot↔Bot direct and the job it belongs to, side by side on one row, centred under
 * the line that opened it (`BotDmEntry.svelte`): one direct is a pill naming both Bots, several a card
 * of chips with a count, the rest past `inlineLimit` folded into a +N chip.
 */
import { Text, View } from "nsh";
import type { Approval, Bot, PendingJudgement, SessionSummary, Turn } from "@real-bot/protocol";
import { sessionTitle } from "../../m/sidebar/session-title";
import { sidebarStatus, type StatusLabels } from "../../m/sidebar/session-status";
import { SessionAvatar } from "../SessionAvatar";
import { shadow } from "../styles";
import { tip } from "../tip";
import { enterMotion, pulseMotion } from "./labels";

export function BotDmEntry(props: {
  sessions: readonly SessionSummary[];
  botsById: Map<string, Bot>;
  turns: readonly Turn[];
  approvals?: readonly Approval[];
  pendingJudgements?: readonly PendingJudgement[];
  isUser?: boolean;
  statusLabels: StatusLabels;
  rosterLabels: { deleted: string; archived: string; fileDrop?: string };
  openedText: string;
  /** How many chips sit inline before the rest collapse into a +N. */
  inlineLimit?: number;
  onOpen: (sessionId: string) => void;
  /** Opens the job the message this entry hangs under belongs to. */
  onShowTrace?: () => void;
  traceLabel?: string;
}) {
  const shown = () => props.sessions.slice(0, props.inlineLimit ?? 3);
  const overflow = () => props.sessions.length - shown().length;
  const newest = () => props.sessions[props.sessions.length - 1];
  const titleOf = (session: SessionSummary) => sessionTitle(session, props.botsById, props.rosterLabels);
  const statusOf = (session: SessionSummary) =>
    sidebarStatus(session, props.turns, props.approvals ?? [], props.statusLabels, props.pendingJudgements ?? []);
  const enter = enterMotion();
  const live = pulseMotion(() => true, 1800);

  const Dot = () => (
    <View class="shrink-0 w-[5px] h-[5px] rounded-full bg-brand" style={{ opacity: live.opacity }} accessible={false} />
  );

  const chip = (session: SessionSummary, plain: boolean) => (
    <View
      role="button"
      testID={`bot-dm-chip-${session.id}`}
      accessibilityLabel={titleOf(session)}
      tooltip={tip(titleOf(session))}
      onPress={() => props.onOpen(session.id)}
      class={`cursor-pointer select-none flex-row items-center ${plain ? "gap-[6px]" : "gap-[5px]"} ${
        plain ? "" : "pl-[3px] pr-[8px] py-[2.5px] bg-bg border border-line rounded-full hover:bg-line-hover hover:border-muted-light active:scale-[0.98]"
      }`}
    >
      <SessionAvatar session={session} bots={props.botsById} size="sm" />
      <Text class="max-w-[180px] text-[12px] font-medium text-ink line-clamp-1">{titleOf(session)}</Text>
      <If when={!plain && statusOf(session).isBusy}>
        <Dot />
      </If>
    </View>
  );

  return (
    <If when={props.sessions.length > 0}>
      <View testID="bot-dm-entry" class="flex-row flex-wrap items-center justify-center self-stretch gap-x-[10px] gap-y-[4px] my-[10px]">
        <If when={props.onShowTrace && props.traceLabel}>
          <View role="button" testID="bot-dm-trace" onPress={() => props.onShowTrace?.()} class="cursor-pointer select-none px-[4px]">
            <Text class="text-[12px] text-brand">{props.traceLabel}</Text>
          </View>
        </If>
        <If
          when={props.sessions.length === 1 ? props.sessions[0] : null}
          else={
            <View
              testID="bot-dm-card"
              class="max-w-full gap-[7px] pl-[10px] pr-[10px] pt-[7px] pb-[9px] bg-pane border border-line rounded-(--radius-lg)"
              style={{ boxShadow: shadow("xs"), opacity: enter.opacity, transform: [...enter.transform] }}
            >
              <View class="flex-row items-center gap-[6px] px-[4px]">
                <Text class="text-[12px] text-brand">↔</Text>
                <Text class="text-[12px] font-medium text-ink-muted">{props.openedText}</Text>
                <View class="px-[6px] py-[1px] rounded-full bg-chip border border-line">
                  <Text class="font-mono text-[10px] font-semibold text-ink-muted">{props.sessions.length}</Text>
                </View>
              </View>
              <View class="flex-row flex-wrap items-center gap-[5px]">
                <Each of={shown()} key={(s) => s.id}>{(session) => chip(session(), false)}</Each>
                <If when={overflow() > 0 ? newest() : null}>
                  {(last) => (
                    <View
                      role="button"
                      testID="bot-dm-overflow"
                      accessibilityLabel={titleOf(last())}
                      tooltip={tip(titleOf(last()))}
                      onPress={() => props.onOpen(last().id)}
                      class="cursor-pointer select-none px-[8px] py-[2.5px] bg-bg border border-line rounded-full hover:bg-line-hover hover:border-muted-light"
                    >
                      <Text class="text-[12px] font-medium text-ink-muted">+{overflow()}</Text>
                    </View>
                  )}
                </If>
              </View>
            </View>
          }
        >
          {(session) => (
            <View
              testID="bot-dm-card"
              class="flex-row items-center gap-[6px] max-w-full pl-[4px] pr-[10px] py-[3px] bg-pane border border-line rounded-full"
              style={{ boxShadow: shadow("xs"), opacity: enter.opacity, transform: [...enter.transform] }}
            >
              {chip(session(), true)}
              <If when={statusOf(session()).isBusy}>
                <Dot />
                <Text class="text-[12px] text-ink-muted">{statusOf(session()).label}</Text>
              </If>
            </View>
          )}
        </If>
      </View>
    </If>
  );
}
