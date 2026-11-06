/**
 * What you asked of the job, from the requirements ledger (`overlays/PlanRequirements.svelte`, ADR 0040
 * P3): your words, a restatement beside them, how often you said each, where it holds and where you
 * said it; what the plan inherits from the rest of its conversation; what waits for you; the old
 * rules nobody found your words for. Each press goes to the daemon and the plan comes back.
 */
import { platform, signal, Text, View, type JSX } from "nsh";
import type { PlanRequirement, RequirementAction, TaskDetail } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { requirementTicket, ticketBinding } from "../../m/overlays/plan-board.ts";
import {
  requirementActions,
  requirementGroups,
  requirementScope,
  requirementSource,
  requirementTimes,
} from "../../m/overlays/plan-requirements.ts";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

/** The plan's own entries, said most often first, the first few shown; the rest a press away. */
const SHOWN = 10;

function LinkText(props: { testID?: string; label: string; tooltip?: string; onPress: () => void }) {
  return (
    <View role="button" testID={props.testID} tooltip={props.tooltip ? tip(props.tooltip) : undefined} onPress={props.onPress} class="group">
      <Text class="text-[11px] leading-[1.5] text-brand group-hover:underline">{props.label}</Text>
    </View>
  );
}

export function PlanRequirements(props: {
  api: MessengerApi | null;
  detail: TaskDetail;
  /** The plan comes back whole after a press; the parent replaces its copy. */
  onSaved: (detail: TaskDetail) => void;
  onJump: (sessionId: string, messageId: string) => void;
  /** The ticket picked on the board: entries held to it alone stand out, those held to another dim. */
  selectedTicket?: string | null;
  /** An entry held to one ticket names it; pressing the name shows that ticket. Absent, the name is plain text. */
  onShowTicket?: (ticketId: string) => void;
}) {
  const r = () => copy().plan.requirements;
  const groups = () => requirementGroups(props.detail.requirements ?? []);
  const total = () => (props.detail.requirements ?? []).filter((entry) => !entry.excluded && entry.status === "open").length;
  const pending = signal<string | null>(null);
  const failed = signal<string | null>(null);
  const showAll = signal(false);
  const ownShown = () => (showAll() || props.selectedTicket ? groups().own : groups().own.slice(0, SHOWN));
  const ownHidden = () => groups().own.length - ownShown().length;

  function label(action: RequirementAction): string {
    if (action === "confirm") return r().confirm;
    if (action === "reject") return r().reject;
    if (action === "waive") return r().waive;
    if (action === "not_here") return r().notHere;
    if (action === "here_again") return r().hereAgain;
    if (action === "keep") return r().keep;
    return r().wholeProject;
  }

  async function press(entry: PlanRequirement, action: RequirementAction): Promise<void> {
    if (!props.api || pending()) return;
    pending.set(`${entry.id}:${action}`);
    failed.set(null);
    try {
      props.onSaved(await props.api.requirementAction(entry.id, { action, task_id: props.detail.id }));
    } catch {
      failed.set(entry.id);
    } finally {
      pending.set(null);
    }
  }

  /** Two lines: your words and how often you said them; then the restatement, where they came from, where they hold and what you can do. */
  function Row(rowProps: { entry: () => PlanRequirement; excluded?: boolean }) {
    const entry = rowProps.entry;
    const times = () => requirementTimes(entry(), r());
    const ownTicket = () => requirementTicket(entry());
    const binding = () => ticketBinding(ownTicket(), props.selectedTicket ?? null);
    const actions = () => (props.api ? requirementActions(entry(), props.detail) : []);
    const settled = () => entry().status === "open" && !entry().excluded;
    // In force, the buttons wait to be pointed at (desktop), over the end of the second line; on touch they stay in the line.
    const hover = () => settled() && platform.desktop && !narrowWindow();
    const source = () => entry().source;
    return (
      <View
        testID={`requirement-${entry().id}`}
        class={`group flex-row gap-[6px] min-w-0 py-[6px] border-t border-line-subtle ${
          binding() === "mine" ? "-mx-[6px] px-[6px] rounded-(--radius-xs) bg-accent-tint border-l-2 border-l-brand" : ""
        } ${binding() === "other" ? "opacity-[0.45]" : ""}`}
      >
        <Text class="w-[34px] shrink-0 pt-[2px] text-[10px] font-bold leading-[1.45] font-mono text-ink-muted">{`R-${entry().seq}`}</Text>
        <View class="flex-1 gap-px min-w-0">
          <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-[2px] min-w-0">
            <Text class={`min-w-0 text-[13px] font-medium leading-[1.45] ${rowProps.excluded ? "text-ink-muted line-through" : "text-ink"}`}>
              {`「${entry().quote}」`}
            </Text>
            <If when={times()}>
              <View class="px-[6px] border border-warn-line rounded-full bg-warn-bg">
                <Text class="text-[10px] font-bold leading-[16px] text-warn-text">{times()}</Text>
              </View>
            </If>
          </View>
          <View class="flex-row flex-wrap items-baseline gap-x-[10px] gap-y-[2px] min-w-0">
            <If when={entry().restated}>
              <Text class="min-w-0 text-[11px] leading-[1.5] text-ink-secondary">{r().restated(entry().restated!)}</Text>
            </If>
            <If when={entry().supersedes}>
              {(old) => <Text class="min-w-0 text-[11px] leading-[1.5] text-ink-secondary">{r().replaces(old().seq, old().quote)}</Text>}
            </If>
            <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-[2px]">
              <If
                when={source()?.session_id && source()?.message_id}
                else={<Text class="text-[11px] leading-[1.5] text-ink-muted">{requirementSource(entry(), r())}</Text>}
              >
                <LinkText
                  testID="requirement-jump"
                  label={requirementSource(entry(), r())}
                  tooltip={r().jump}
                  onPress={() => props.onJump(source()!.session_id!, source()!.message_id!)}
                />
              </If>
              <If
                when={ownTicket() && props.onShowTicket && props.detail.tickets.some((ticket) => ticket.id === ownTicket())}
                else={<Text class="text-[11px] leading-[1.5] text-ink-muted">{requirementScope(entry(), props.detail, r())}</Text>}
              >
                <LinkText
                  testID="requirement-ticket"
                  label={requirementScope(entry(), props.detail, r())}
                  onPress={() => props.onShowTicket?.(ownTicket()!)}
                />
              </If>
            </View>
            <If when={actions().length > 0}>
              <View
                class={`flex-row flex-wrap items-center gap-1 ml-auto ${
                  hover() ? "absolute right-0 bottom-1 pl-3 bg-pane opacity-0 group-hover:opacity-100" : ""
                }`}
              >
                <Each of={actions()}>
                  {(action) => (
                    <View
                      role="button"
                      testID={`requirement-${entry().id}-${action()}`}
                      disabled={pending() !== null}
                      accessibilityState={{ busy: pending() === `${entry().id}:${action()}` }}
                      onPress={() => void press(entry(), action())}
                      class={`group min-h-[20px] px-[7px] justify-center rounded-(--radius-sm) border disabled:opacity-[0.55] ${narrowWindow() ? "min-h-[32px] px-[10px] py-1" : ""} ${
                        action() === "confirm" ? "border-brand bg-brand" : "border-line bg-chip hover:border-accent-border hover:bg-accent-tint"
                      }`}
                    >
                      <Text
                        class={`text-[11px] font-medium ${action() === "confirm" ? "text-on-accent" : "text-ink-secondary group-hover:text-brand"}`}
                      >
                        {label(action())}
                      </Text>
                    </View>
                  )}
                </Each>
                <If when={failed() === entry().id}>
                  <Text testID="requirement-error" class="text-[11px] text-danger-text">{r().failed}</Text>
                </If>
              </View>
            </If>
          </View>
        </View>
      </View>
    );
  }

  const list = (entries: () => readonly PlanRequirement[], excluded = false): JSX.Element => (
    <View class="min-w-0">
      <Each of={entries()} key={(entry) => entry.id}>
        {(entry) => <Row entry={entry} excluded={excluded} />}
      </Each>
    </View>
  );

  const aside = (title: string, hint: string | null, entries: () => readonly PlanRequirement[], id: string, excluded = false): JSX.Element => (
    <View testID={`requirements-${id}`} class="gap-[5px] pt-2 border-t border-dashed border-line">
      <Text class="text-[11px] font-semibold text-ink-muted">{title}</Text>
      <If when={hint}>
        <Text class="text-[11px] text-ink-muted">{hint}</Text>
      </If>
      {list(entries, excluded)}
    </View>
  );

  return (
    <View
      accessibilityLabel={r().title}
      testID="plan-requirements"
      class="gap-[7px] min-w-0 px-[11px] py-[10px] rounded-(--radius-md) border border-line bg-pane"
    >
      <View tooltip={tip(r().hint)} class="flex-row items-center gap-[6px] min-w-0 self-start">
        <Text class="text-[12px] font-semibold text-ink-muted">{r().title}</Text>
        <If when={total() > 0}>
          <View class="px-[5px] rounded-full bg-line-subtle">
            <Text testID="requirements-count" class="text-[10px] font-bold leading-[15px] font-mono text-ink-muted">{String(total())}</Text>
          </View>
        </If>
      </View>
      <If
        when={(props.detail.requirements ?? []).length > 0}
        else={<Text testID="requirements-empty" class="text-[11px] italic text-ink-muted">{r().none}</Text>}
      >
        <If when={groups().own.length > 0}>
          {list(ownShown)}
          <If when={ownHidden() > 0 || (showAll() && groups().own.length > SHOWN)}>
            <View role="button" testID="requirements-more" accessibilityState={{ expanded: showAll() }} onPress={() => showAll.set(!showAll())} class="self-start py-[2px] group">
              <Text class="text-[11px] font-semibold text-brand group-hover:underline">
                {showAll() ? r().showFewer : r().showAll(ownHidden())}
              </Text>
            </View>
          </If>
        </If>
        <Each of={groups().inherited} key={(group) => group.taskId}>
          {(group) => (
            <View testID="requirements-inherited" class="gap-[5px] pt-2 border-t border-dashed border-line">
              <Text class="text-[11px] font-semibold text-ink-muted">{r().inherited(group().title, group().entries.length)}</Text>
              {list(() => group().entries)}
            </View>
          )}
        </Each>
        <If when={groups().withdrawn.length > 0}>{aside(r().withdrawn, r().withdrawnHint, () => groups().withdrawn, "withdrawn")}</If>
        <If when={groups().proposed.length > 0}>{aside(r().proposed, r().proposedHint, () => groups().proposed, "proposed")}</If>
        <If when={groups().unverified.length > 0}>{aside(r().unverified, r().unverifiedHint, () => groups().unverified, "unverified")}</If>
        <If when={groups().excluded.length > 0}>{aside(r().excluded, null, () => groups().excluded, "excluded", true)}</If>
      </If>
    </View>
  );
}
