/**
 * The top of the spec panel (`overlays/PlanSpecPanel.svelte`): the title, the ticket picked on the
 * board, the goal (hero card, editable) and what needs you, said once under it.
 */
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import type { PlanSpec, TaskDetail } from "@real-bot/protocol";
import { badgeOf, firstReason } from "../../m/overlays/acceptance-checks.ts";
import { planAttention } from "../../m/overlays/plan-attention.ts";
import { ticketTag } from "../../m/overlays/plan-board.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { ATTENTION_CHECKS } from "./plan-spec-panel";
import { EditBtn, ErrorLine, SaveCancel, TicketRef } from "./plan-spec-parts";
import type { PlanSpecPanelProps, PlanSpecState } from "./plan-spec-state";

export function PlanSpecTitle() {
  return (
    <View class="flex-row items-center gap-[6px] min-w-0">
      <Icon name="file-text" size={16} class="tint-brand" />
      <Text role="header" class="text-[13px] font-bold text-ink">
        {copy().plan.spec.title}
      </Text>
    </View>
  );
}

/** The ticket picked on the board, read against the spec it has to meet. */
export function PlanFocus(props: { panel: PlanSpecPanelProps; ticket: TaskDetail["tickets"][number] }) {
  const l = () => copy().plan.links;
  const tk = () => props.ticket;
  const label = () => `${ticketTag(tk().seq)} ${tk().title}`;
  const body = () => (
    <>
      <TicketRef seq={tk().seq} mine />
      <Text class="shrink text-[12px] font-semibold text-ink">{tk().title}</Text>
    </>
  );
  return (
    <View testID="plan-spec-focus" class="gap-[3px] min-w-0 px-[10px] py-2 border border-accent-border rounded-(--radius-md) bg-accent-tint">
      <View class="flex-row items-center gap-[6px] min-w-0">
        <Text class="shrink-0 text-[11px] font-semibold text-brand">{l().focus}</Text>
        <If when={props.panel.onShowTicket} else={<View class="flex-row items-center gap-[5px] flex-1 min-w-0">{body()}</View>}>
          <View
            role="button"
            testID="plan-spec-focus-ticket"
            tooltip={tip(l().showTicket(label()))}
            onPress={() => props.panel.onShowTicket?.(tk().id)}
            class="flex-row items-center gap-[5px] flex-1 min-w-0"
          >
            {body()}
          </View>
        </If>
        <If when={props.panel.onClearTicket}>
          <View
            role="button"
            testID="plan-spec-focus-clear"
            accessibilityLabel={l().clearFocus}
            tooltip={tip(l().clearFocus)}
            onPress={() => props.panel.onClearTicket?.()}
            class="shrink-0 items-center justify-center w-[22px] h-[22px] rounded-full hover:bg-pane"
          >
            <Icon name="x" size={12} class="tint-ink-muted" />
          </View>
        </If>
      </View>
      <Text class="text-[11px] text-ink-muted">{l().focusHint}</Text>
    </View>
  );
}

/** The hero card: the plan's goal, with its edit box. */
export function PlanGoal(props: { panel: PlanSpecPanelProps; state: PlanSpecState; spec: PlanSpec }) {
  const t = () => copy().plan;
  const s = props.state;
  return (
    <View testID="plan-spec-goal" class="gap-[10px] px-4 py-[14px] border border-accent-border rounded-(--radius-md) bg-accent-tint">
      <View class="flex-row items-center justify-between gap-2 min-w-0">
        <View class="flex-row items-center gap-[5px]">
          <Icon name="target" size={12} class="tint-brand" />
          <Text class="text-[11px] font-bold text-brand">{t().spec.goal}</Text>
        </View>
        <If when={props.panel.api && s.editing() !== "goal"}>
          <EditBtn testID="plan-spec-edit-goal" onPress={s.startEditGoal} />
        </If>
      </View>
      <If when={s.editing() === "goal"} else={<Text testID="plan-spec-goal-text" class="text-[16px] font-semibold leading-[1.5] text-ink">{props.spec.goal}</Text>}>
        <View class="gap-[6px]">
          <Input
            testID="plan-spec-goal-input"
            accessibilityLabel={t().spec.goal}
            autoCorrect={false}
            value={s.draft()}
            readonly={s.saving()}
            onChange={(e) => s.draft.set(e.value)}
            class={`w-full border border-line rounded-(--radius-sm) bg-input-bg text-ink focus:border-field-focus-border ${
              narrowWindow() ? "px-[10px] py-2 text-[14px]" : "px-[9px] py-[6px] text-[13px]"
            }`}
          />
          <SaveCancel state={s} testID="plan-spec-goal" />
          <If when={s.saveError()}>
            <ErrorLine testID="plan-spec-error">{s.saveError() ?? ""}</ErrorLine>
          </If>
        </View>
      </If>
    </View>
  );
}

function AttentionTag(props: { warn?: boolean; children: string }) {
  return (
    <View class={`shrink-0 px-[6px] rounded-(--radius-xs) ${props.warn ? "bg-warn-text" : "bg-danger-text"}`}>
      <Text class="text-[11px] font-bold leading-[18px] text-pane">{props.children}</Text>
    </View>
  );
}

/** What needs you: drawn only when something does, so its colour means something. */
export function PlanAttention(props: { panel: PlanSpecPanelProps; spec: PlanSpec }) {
  const t = () => copy().plan;
  const detail = () => props.panel.detail;
  const attention = () => planAttention(detail());
  const failing = () => attention().failing;
  const warn = () => failing().length === 0 && props.spec.progress.blocked.length === 0;
  const owner = (ticketId: string | null | undefined) => (ticketId ? (detail().tickets.find((tk) => tk.id === ticketId) ?? null) : null);
  return (
    <If when={attention().needsYou}>
      <View
        testID="plan-spec-attention"
        accessibilityLabel={t().spec.attention}
        class={`gap-[6px] min-w-0 px-3 pt-[9px] pb-[10px] border rounded-(--radius-md) ${warn() ? "border-warn-line bg-warn-bg" : "border-danger-line bg-danger-bg"}`}
      >
        <View class="flex-row items-center gap-[5px]">
          <Icon name="alert-triangle" size={12} class={warn() ? "tint-warn-text" : "tint-danger-text"} />
          <Text class={`text-[12px] font-bold ${warn() ? "text-warn-text" : "text-danger-text"}`}>{t().spec.attention}</Text>
        </View>
        <View class="gap-1">
          {() =>
            failing()
              .slice(0, ATTENTION_CHECKS)
              .map((check) => {
                const tk = owner(check.ticket_id);
                const badge = badgeOf(check);
                const why = firstReason(check.last_run?.detail);
                const subject = tk ? (
                  <>
                    <TicketRef seq={tk.seq} />
                    <Text class="shrink text-[12px] font-semibold text-ink">{tk.title}</Text>
                  </>
                ) : (
                  <Text class="shrink text-[12px] font-semibold text-ink">{check.item}</Text>
                );
                return (
                  <View testID={`plan-spec-attention-${check.id}`} class="flex-row flex-wrap items-center gap-x-2 gap-y-[2px] min-w-0">
                    <AttentionTag>{badge === "fail" ? t().spec.attentionFail : `${t().checks.title} · ${t().checks.status[badge]}`}</AttentionTag>
                    {tk && props.panel.onShowTicket ? (
                      <View
                        role="button"
                        testID="plan-spec-attention-ticket"
                        tooltip={tip(t().links.showTicket(`${ticketTag(tk.seq)} ${tk.title}`))}
                        onPress={() => props.panel.onShowTicket?.(tk.id)}
                        class="flex-row items-center gap-[5px] shrink min-w-0"
                      >
                        {subject}
                      </View>
                    ) : (
                      <View class="flex-row items-center gap-[5px] shrink min-w-0">{subject}</View>
                    )}
                    {why ? (
                      <View tooltip={tip(check.last_run?.detail ?? why)} class="shrink min-w-0">
                        <Text class="text-[12px] text-ink-secondary">{why}</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })
          }
          <If when={failing().length > ATTENTION_CHECKS}>
            <Text testID="plan-spec-attention-more" class="pl-[2px] text-[11px] text-danger-text">
              {t().spec.attentionMore(failing().length - ATTENTION_CHECKS)}
            </Text>
          </If>
          {() =>
            props.spec.progress.blocked.map((line) => (
              <View class="flex-row items-center gap-2 min-w-0">
                <AttentionTag>{t().spec.blocked}</AttentionTag>
                <Text class="shrink text-[12px] text-ink">{line}</Text>
              </View>
            ))
          }
          <If when={attention().waitingRequirements > 0}>
            <View testID="plan-spec-attention-waiting" class="flex-row items-center gap-2 min-w-0">
              <AttentionTag warn>{t().requirements.proposed}</AttentionTag>
              <Text class="shrink text-[12px] font-semibold text-ink">{t().spec.attentionWaiting(attention().waitingRequirements)}</Text>
            </View>
          </If>
        </View>
      </View>
    </If>
  );
}
