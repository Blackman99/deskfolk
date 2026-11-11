/**
 * The picked ticket, below its card (`overlays/TicketDetail.svelte`): what it answers to (the spec,
 * as every ticket does, and what is held to it alone) and its own settings: who reviews it, the
 * model it runs on, what it waits for. In the inspector it also says who actually ran its turns, with
 * a press to make the Bot that has been reviewing it in all but name its reviewer.
 */
import { Text, View } from "nsh";
import type { Bot, TaskDetail, TicketWithArtifacts } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { badgeOf, describeCheck } from "../../m/overlays/acceptance-checks.ts";
import { actorFace, actorName, dependsTags, ticketObligations, type TicketObligations } from "../../m/overlays/plan-board.ts";
import type { TicketEdits } from "../../m/overlays/ticket-edits.svelte.ts";
import { reviewerHint } from "../../m/overlays/ticket-lanes.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { ModelPicker } from "../ModelPicker";
import { Select } from "../Select";
import { tip } from "../tip";
import { ActorDot } from "./ticket-parts";

const CHECK_TONE: Record<string, { box: string; text: string }> = {
  pass: { box: "border-ok-line bg-ok-bg", text: "text-ok-text" },
  fail: { box: "border-danger-line bg-danger-bg", text: "text-danger-text" },
  blocked: { box: "border-warn-line bg-warn-bg", text: "text-warn-text" },
  error: { box: "border-warn-line bg-warn-bg", text: "text-warn-text" },
};

export function TicketDetail(props: {
  api: MessengerApi | null;
  detail: TaskDetail;
  ticket: TicketWithArtifacts;
  bots: readonly Bot[];
  youLabel: string;
  deletedLabel: string;
  edits: TicketEdits;
  /** Open the spec the tickets answer to, keeping the picked ticket picked. */
  onShowSpec?: () => void;
  /** The ticket whose list of what it waits for is open. */
  dependsOpen: string | null;
  onDependsOpenChange: (id: string | null) => void;
  /**
   * Who actually ran the ticket's turns, and how many (ADR 0086), where the inspector shows it:
   * said under the settings, with a press to make the Bot that has been reviewing it in all but
   * name its reviewer. Left out on the board.
   */
  ranBy?: ReadonlyMap<string, number> | null;
}) {
  const t = () => copy();
  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot] as const));
  const owes = () => ticketObligations(props.detail, props.ticket.id);
  const ran = () => (props.ranBy ? [...props.ranBy].sort((a, b) => b[1] - a[1]) : []);
  const nameOf = (id: string) => actorName(id, botsById(), props.youLabel, props.deletedLabel);

  /** Who may review a ticket (ADR 0046, from level 5): a Bot of the plan's conversation, never the one on it. */
  const reviewerOptions = (): Array<{ value: string; label: string }> => {
    const ticket = props.ticket;
    const owner = ticket.owner_bot_id ?? ticket.worker;
    const able = new Set(props.detail.reviewer_ids ?? []);
    const options = props.bots.filter((bot) => able.has(bot.id) && bot.id !== owner).map((bot) => ({ value: bot.id, label: bot.name }));
    // The one set now stays readable by name even once it left the plan's conversation.
    const current = ticket.reviewer_bot_id;
    if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: nameOf(current) });
    return options;
  };

  /** Offered only where reviews are on (level 5) and the Bot may review it. */
  const hint = () =>
    props.ranBy && props.api && props.detail.submissions_on
      ? reviewerHint(props.ticket, props.ranBy, new Set(reviewerOptions().map((option) => option.value)))
      : null;

  /** What every ticket meets from the spec, in words: 「验收 4 条、规则 13 条、你的要求 20 条」. */
  const planWideLine = (o: TicketObligations): string => {
    const links = t().plan.links;
    const parts: string[] = [];
    if (o.acceptance > 0) parts.push(links.acceptanceCount(o.acceptance));
    if (o.rules > 0) parts.push(links.rulesCount(o.rules));
    if (o.planRequirements > 0) parts.push(links.requirementsCount(o.planRequirements));
    return parts.length > 0 ? links.planWide(parts.join(links.join)) : links.planWideNone;
  };

  const settingLabel = (text: string) => <Text class="text-[11px] font-semibold text-ink-muted">{text}</Text>;
  const depends = () => props.dependsOpen === props.ticket.id;

  return (
    <>
      {/* What the picked ticket answers to: the spec, as every ticket does, and what is held to it alone. */}
      <View
        role="group"
        accessibilityLabel={t().plan.links.heldTo}
        testID="ticket-owes"
        class="gap-1 px-[9px] py-[7px] min-w-0 rounded-(--radius-sm) border border-accent-border bg-accent-tint"
      >
        <View class="flex-row items-center justify-between gap-[6px]">
          <Text class="text-[11px] font-bold text-brand">{t().plan.links.heldTo}</Text>
          <If when={props.onShowSpec}>
            <View
              role="button"
              testID="ticket-owes-spec"
              onPress={() => props.onShowSpec?.()}
              class="cursor-pointer select-none group flex-row items-center gap-1 px-[7px] py-1 min-h-[22px] rounded-(--radius-sm) border border-accent-border bg-pane hover:bg-brand hover:border-brand"
            >
              <Icon name="file" size={12} class="tint-brand group-hover:tint-on-accent" />
              <Text class="text-[11px] font-medium text-brand group-hover:text-on-accent">{t().plan.links.showSpec}</Text>
            </View>
          </If>
        </View>
        <Text testID="ticket-owes-plan" class="text-[11.5px] leading-[1.45] text-ink-secondary">{planWideLine(owes())}</Text>
        <If when={owes().requirements.length > 0 || owes().checks.length > 0}>
          <Text class="mt-[2px] text-[11px] font-semibold text-ink-muted">{t().plan.links.onlyThis}</Text>
          <View class="gap-[3px]">
            <Each of={owes().requirements.slice()} key={(entry) => entry.id}>
              {(entry) => (
                <View class="flex-row items-baseline gap-[5px] min-w-0">
                  <Text class="shrink-0 text-[10px] font-mono font-bold text-ink-muted">{`R-${entry().seq}`}</Text>
                  <Text class="flex-1 min-w-0 text-[11.5px] text-ink-secondary">{`「${entry().quote}」`}</Text>
                </View>
              )}
            </Each>
            <Each of={owes().checks.slice()} key={(check) => check.id}>
              {(check) => {
                const badge = () => badgeOf(check());
                const tone = () => CHECK_TONE[badge()] ?? { box: "border-line bg-chip", text: "text-ink-muted" };
                return (
                  <View class="flex-row items-baseline gap-[5px] min-w-0">
                    <View class={`shrink-0 px-[6px] rounded-full border ${tone().box}`}>
                      <Text class={`text-[10px] font-semibold leading-[15px] ${tone().text}`}>{t().plan.checks.status[badge()]}</Text>
                    </View>
                    <Text class="flex-1 min-w-0 text-[11.5px] text-ink-secondary">{describeCheck(check(), t())}</Text>
                  </View>
                );
              }}
            </Each>
          </View>
        </If>
      </View>
      <If when={props.api && props.edits.hasSettings}>
        {/* Who reviews it, the model it runs on, what it waits for: set on the picked ticket only. */}
        <View testID="ticket-settings" class="gap-[5px] min-w-0">
          <If when={props.detail.submissions_on}>
            <View class="flex-row items-center gap-[10px]">
              <View class="w-[64px]">{settingLabel(t().plan.reviewer)}</View>
              <View class="flex-1 min-w-0" testID="ticket-reviewer">
                <Select
                  value={props.ticket.reviewer_bot_id ?? ""}
                  options={reviewerOptions()}
                  emptyLabel={t().plan.noReviewer}
                  size="sm"
                  ariaLabel={t().plan.reviewer}
                  disabled={props.edits.patchingId === props.ticket.id}
                  onChange={(value) => void props.edits.changeReviewer(props.ticket, value)}
                />
              </View>
            </View>
          </If>
          <If when={props.detail.routing_on && props.edits.modelData.sources.length > 0}>
            <View class="flex-row items-center gap-[10px]">
              <View class="w-[64px]">{settingLabel(t().plan.modelShort)}</View>
              <View class="flex-1 min-w-0" testID="ticket-model">
                <ModelPicker
                  value={props.edits.modelValue(props.ticket)}
                  data={props.edits.modelDataFor(props.ticket)}
                  size="sm"
                  ariaLabel={t().plan.modelOverride}
                  title={t().plan.modelOverride}
                  disabled={props.edits.patchingId === props.ticket.id}
                  onChange={(value) => void props.edits.changeModel(props.ticket, value)}
                />
              </View>
            </View>
          </If>
          <If when={props.detail.supervision_on && props.detail.tickets.length > 1}>
            <View class="flex-row items-center gap-[10px]">
              <View class="w-[64px]">{settingLabel(t().plan.editDepends)}</View>
              <View
                role="button"
                testID="ticket-depends-toggle"
                accessibilityState={{ expanded: depends() }}
                tooltip={tip(t().plan.dependsHint)}
                onPress={() => props.onDependsOpenChange(depends() ? null : props.ticket.id)}
                class={`cursor-pointer select-none flex-1 min-w-0 flex-row items-center justify-between gap-[6px] px-2 py-[3px] rounded-(--radius-sm) border bg-input-bg hover:border-accent-border ${depends() ? "border-accent-border" : "border-line"}`}
              >
                <Text class="flex-1 min-w-0 text-[12px] text-ink line-clamp-1">
                  {dependsTags(props.ticket, props.detail.tickets) ?? t().plan.dependsNothing}
                </Text>
                <Icon name="chevron-down" size={12} class={depends() ? "tint-brand rotate-180" : "tint-ink-muted"} />
              </View>
            </View>
          </If>
        </View>
      </If>
      <If when={props.ranBy}>
        {/* Who ran it beside who is written down for it: the division as it happened. */}
        <View testID="ticket-ran" class="flex-row items-baseline gap-[10px] min-w-0">
          <Text class="text-[11px] font-semibold text-ink-muted">{t().plan.job.ran}</Text>
          <View class="flex-1 min-w-0 flex-row flex-wrap gap-x-3 gap-y-[3px]">
            <If when={ran().length > 0} else={<Text class="text-[12px] text-ink-muted">{t().plan.job.ranNone}</Text>}>
              <Each of={ran()} key={(row) => row[0]}>
                {(row) => (
                  <View testID={`ran-bot-${row()[0]}`} class="flex-row items-center gap-1">
                    <ActorDot face={actorFace(row()[0], botsById(), props.youLabel, props.deletedLabel)} size={15} font={9} />
                    <Text class="text-[12px] text-ink">{nameOf(row()[0])}</Text>
                    <Text class="text-[12px] font-mono font-bold text-ink">{String(row()[1])}</Text>
                  </View>
                )}
              </Each>
            </If>
          </View>
        </View>
        <If when={hint()}>
          {(h) => (
            <View testID="ticket-reviewer-hint" class="items-start gap-[6px] px-[9px] py-[7px] rounded-(--radius-sm) bg-warn-bg">
              <Text class="text-[11.5px] leading-[1.45] text-ink-secondary">{t().plan.job.reviewerHint(nameOf(h().bot), h().turns)}</Text>
              <View
                role="button"
                testID="ticket-reviewer-hint-go"
                disabled={props.edits.patchingId === props.ticket.id}
                onPress={() => void props.edits.changeReviewer(props.ticket, h().bot)}
                class="cursor-pointer select-none disabled:cursor-default group px-2 py-[2px] rounded-(--radius-sm) border border-accent-border bg-pane hover:bg-brand hover:border-brand disabled:opacity-[0.5]"
              >
                <Text class="text-[11.5px] font-semibold text-brand group-hover:text-on-accent">{t().plan.job.makeReviewer(nameOf(h().bot))}</Text>
              </View>
            </View>
          )}
        </If>
      </If>
    </>
  );
}
