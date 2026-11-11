/**
 * One routine, read-only (`.detail`): whose it is, its title, when and whether it runs, and what
 * it tells the Bot. A press on the scrim, Escape and the Close buttons close it. A routine that is
 * gone from the snapshot while it is open reads "missing".
 */
import type { Bot, Routine } from "@real-bot/protocol";
import { Scroll, Text, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";
import { copy } from "../../runtime";
import { routineScheduleLabel } from "../../m/panels/routine-form.ts";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { SmallFace } from "./EventFace";
import type { CalLocale } from "./calendar-dates";

export function RoutineDetail(props: {
  routine: Routine | null;
  bot: Bot | null;
  /** This block is the latest time the routine was due. */
  wasDue: boolean;
  locale: CalLocale;
  onClose: () => void;
}) {
  const t = () => copy();
  const width = () => Math.min(440, windowSize().width - (narrowWindow() ? 32 : 40));
  return (
    <Dialog
      open
      animation="fade"
      onCancel={props.onClose}
      onOpenChange={(e) => {
        if (!e.open) props.onClose();
      }}
      backdropClass="bg-modal-backdrop"
      class="m-auto bg-pane overflow-hidden rounded-(--radius-lg) border border-line"
      style={{ width: width(), maxHeight: Math.round(windowSize().height * 0.9), boxShadow: shadow("lg") }}
    >
      <Scroll class="shrink min-h-0">
        <View testID="routine-detail" role="group" accessibilityLabel={t().calendar.detail} class="flex-col gap-[14px] p-[22px]">
          <If
            when={props.routine && props.bot}
            else={<Text testID="detail-missing" class="text-[13px] text-ink-muted">{t().routines.missing}</Text>}
          >
            <View class="flex-row items-center justify-between">
              <View class="flex-row items-center gap-[10px]">
                <SmallFace bot={props.bot!} size={32} />
                <View class="gap-[2px]">
                  <Text class="text-[14px] font-semibold text-ink">{props.bot!.name}</Text>
                  <If when={props.bot!.archived_at}>
                    <Text class="text-[11px] text-ink-muted">{t().top.archived}</Text>
                  </If>
                </View>
              </View>
              <IconButton icon="x" size="sm" label={t().common.close} testID="detail-x" onPress={props.onClose} />
            </View>

            <Text role="header" testID="detail-title" class="text-[18px] font-semibold text-ink">{props.routine!.title}</Text>

            <View class="flex-row flex-wrap items-center gap-[6px]">
              <View class="flex-row items-center gap-1 px-2 py-[3px] rounded-full bg-chip">
                <Icon name="clock" size={12} class="tint-ink-muted" />
                <Text class="text-[12px] text-ink-secondary">{routineScheduleLabel(props.routine!.schedule, t())}</Text>
              </View>
              <View class="flex-row items-center gap-1 px-2 py-[3px] rounded-full bg-chip">
                <View class={`w-[6px] h-[6px] rounded-full ${props.routine!.enabled ? "bg-ok-text" : "bg-ink-muted"}`} accessible={false} />
                <Text class="text-[12px] text-ink-secondary">{props.routine!.enabled ? t().routines.active : t().routines.paused}</Text>
              </View>
              <If when={props.wasDue}>
                <View class="flex-row items-center gap-1 px-2 py-[3px] rounded-full bg-accent-tint">
                  <Icon name="check" size={12} class="tint-brand" />
                  <Text class="text-[12px] text-brand">{t().calendar.lastFired}</Text>
                </View>
              </If>
            </View>

            <If when={props.bot!.archived_at}>
              <View class="px-3 py-2 rounded-(--radius-sm) bg-warn-bg">
                <Text class="text-[12px] leading-[1.45] text-warn-text">{t().routines.availability}</Text>
              </View>
            </If>

            <View class="gap-[6px]">
              <Text class="text-[11px] font-semibold text-ink-muted">{props.locale === "en" ? "Instruction" : "任务指令"}</Text>
              <Text testID="detail-instruction" class="text-[13px] leading-[1.5] text-ink">{props.routine!.instruction.trim() || t().calendar.noInstruction}</Text>
            </View>
          </If>

          <View class="flex-row justify-end mt-1">
            <View
              role="button"
              testID="detail-close"
              accessibilityLabel={t().common.close}
              onPress={props.onClose}
              class="cursor-pointer select-none px-[18px] py-2 rounded-(--radius-md) border border-line bg-btn-secondary-bg hover:bg-line-subtle"
            >
              <Text class="text-[13px] font-semibold text-ink">{t().common.close}</Text>
            </View>
          </View>
        </View>
      </Scroll>
    </Dialog>
  );
}
