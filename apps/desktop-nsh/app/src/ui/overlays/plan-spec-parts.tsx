/**
 * Small pieces the spec panel's sections share (`overlays/PlanSpecPanel.svelte`): the small
 * outlined button, edit / save / cancel, the error line, a ticket's number tag, the edit box for a
 * field's lines, and one acceptance check with the ticket it is filed under.
 */
import { Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import type { AcceptanceCheck, TaskDetail } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { ticketBinding, ticketTag } from "../../m/overlays/plan-board.ts";
import { copy } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { AcceptanceCheckRow } from "./AcceptanceCheckRow";
import type { PlanSpecState } from "./plan-spec-state";

/** The outlined chip button of the panel: edit, run, add. */
export function SmallBtn(props: {
  testID?: string;
  label: string;
  icon?: IconName;
  tooltip?: string;
  disabled?: boolean;
  accent?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={props.tooltip ? tip(props.tooltip) : undefined}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`cursor-pointer select-none disabled:cursor-default group shrink-0 flex-row items-center justify-center gap-[3px] border rounded-(--radius-sm) px-[7px] py-[3px] hover:border-accent-border hover:bg-accent-tint disabled:opacity-[0.55] ${
        narrowWindow() ? "min-h-[30px]" : "min-h-[24px]"
      } ${props.accent ? "border-accent-border bg-accent-tint" : "border-line bg-chip"}`}
    >
      <If when={props.icon}>{(name) => <Icon name={name()} size={12} class="tint-ink-secondary group-hover:tint-brand" />}</If>
      <Text class={`text-[11px] font-medium ${props.accent ? "text-brand" : "text-ink-secondary"} group-hover:text-brand`}>{props.label}</Text>
    </View>
  );
}

export function EditBtn(props: { testID: string; tooltip?: string; onPress: () => void }) {
  return <SmallBtn testID={props.testID} icon="edit" label={copy().plan.edit} tooltip={props.tooltip ?? copy().plan.edit} onPress={props.onPress} />;
}

/** A link-looking text button. */
export function LinkBtn(props: { testID?: string; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <SmallBtn testID={props.testID} label={props.label} disabled={props.disabled} onPress={props.onPress} />
  );
}

export function ErrorLine(props: { testID?: string; children?: JSX.Element }) {
  return (
    <Text testID={props.testID} role="alert" class="text-[12px] text-danger-text">
      {props.children}
    </Text>
  );
}

export function SaveCancel(props: { state: PlanSpecState; disabledSave?: boolean; testID: string }) {
  const t = () => copy().plan;
  const s = props.state;
  return (
    <View class="flex-row gap-[6px]">
      <View
        role="button"
        testID={`${props.testID}-save`}
        disabled={s.saving() || props.disabledSave}
        onPress={() => void s.save()}
        class={`cursor-pointer select-none disabled:cursor-default items-center justify-center border border-brand rounded-(--radius-sm) bg-brand px-[11px] py-[5px] hover:bg-accent-hover disabled:opacity-[0.55] ${narrowWindow() ? "min-h-[36px]" : "min-h-[28px]"}`}
      >
        <Text class="text-[12px] font-medium text-on-accent">{t().save}</Text>
      </View>
      <View
        role="button"
        testID={`${props.testID}-cancel`}
        disabled={s.saving()}
        onPress={s.cancelEdit}
        class={`cursor-pointer select-none disabled:cursor-default items-center justify-center border border-line rounded-(--radius-sm) bg-chip px-[11px] py-[5px] hover:bg-line-subtle hover:border-line-hover disabled:opacity-[0.55] ${narrowWindow() ? "min-h-[36px]" : "min-h-[28px]"}`}
      >
        <Text class="text-[12px] font-medium text-ink-secondary">{t().cancel}</Text>
      </View>
    </View>
  );
}

/** A ticket's number tag; pressable when the panel can show that ticket. */
export function TicketRef(props: { seq: number; mine?: boolean; tooltip?: string; testID?: string; onPress?: () => void }) {
  const body = (
    <Text class={`text-[10px] font-bold font-mono leading-[14px] ${props.mine ? "text-on-accent" : "text-muted group-hover:text-brand"}`}>
      {ticketTag(props.seq)}
    </Text>
  );
  const box = `shrink-0 border rounded-(--radius-xs) px-[5px] py-[2px] ${props.mine ? "border-brand bg-brand" : "border-line bg-line-subtle"}`;
  return props.onPress ? (
    <View
      role="button"
      testID={props.testID}
      tooltip={props.tooltip ? tip(props.tooltip) : undefined}
      onPress={props.onPress}
      class={`cursor-pointer select-none group ${box} ${props.mine ? "" : "hover:border-accent-border"}`}
    >
      {body}
    </View>
  ) : (
    <View testID={props.testID} tooltip={props.tooltip ? tip(props.tooltip) : undefined} class={`group ${box}`}>
      {body}
    </View>
  );
}

/** The lines of a field in one edit box (one line each). */
export function LinesBox(props: { state: PlanSpecState; testID: string }) {
  const s = props.state;
  return (
    <Input
      testID={props.testID}
      accessibilityLabel={copy().plan.linesHint}
      multiline
      autoCorrect={false}
      value={s.draft()}
      placeholder={copy().plan.linesHint}
      disabled={s.saving()}
      onChange={(e) => s.draft.set(e.value)}
      class={`w-full min-h-[68px] border border-line rounded-(--radius-sm) bg-input-bg text-ink focus:border-field-focus-border ${
        narrowWindow() ? "px-[10px] py-2 text-[14px]" : "px-[9px] py-[7px] text-[13px]"
      }`}
    />
  );
}

/** A bulleted list of written lines; `after` draws what hangs under a line (its checks). */
export function Lines(props: { lines: readonly string[]; bullet?: string; after?: (line: string) => JSX.Element }) {
  return (
    <View class="gap-1 pl-[2px]">
      <Each of={props.lines.slice()}>
        {(line) => (
          <View class="flex-row flex-wrap items-baseline gap-x-[6px] gap-y-1 min-w-0">
            <Text class={`text-[12px] leading-[1.45] ${props.bullet ?? "text-muted"}`}>•</Text>
            <Text class="shrink text-[12px] leading-[1.45] text-ink-secondary">{line()}</Text>
            {props.after?.(line())}
          </View>
        )}
      </Each>
    </View>
  );
}

/** One check; filed under a ticket it names it (the rest hold for the whole plan). */
export function CheckItem(props: {
  api: MessengerApi | null;
  detail: TaskDetail;
  check: AcceptanceCheck;
  focusTicketId: string | null;
  onSaved: (detail: TaskDetail) => void;
  onShowTicket?: (ticketId: string) => void;
}) {
  const owner = () => (props.check.ticket_id ? (props.detail.tickets.find((tk) => tk.id === props.check.ticket_id) ?? null) : null);
  const binding = () => ticketBinding(owner()?.id, props.focusTicketId);
  return (
    <View testID={`plan-spec-check-${props.check.id}`} class={`flex-row items-start gap-1 max-w-full ${binding() === "other" ? "opacity-[0.45]" : ""}`}>
      <If when={owner()}>
        {(tk) => (
          <TicketRef
            testID="plan-spec-ticket-ref"
            seq={tk().seq}
            mine={binding() === "mine"}
            tooltip={props.onShowTicket ? copy().plan.links.showTicket(`${ticketTag(tk().seq)} ${tk().title}`) : tk().title}
            onPress={props.onShowTicket ? () => props.onShowTicket?.(tk().id) : undefined}
          />
        )}
      </If>
      <AcceptanceCheckRow api={props.api} detail={props.detail} check={props.check} onSaved={props.onSaved} />
    </View>
  );
}
