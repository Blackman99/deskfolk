/**
 * The composer's consultant switch (ADR 0116 addendum 2026-11-23), a pill beside Plan mode: on, every
 * line you send makes the agent first ask the chosen consultants, each on its own, and then sum up
 * their views with its own. Pressed it opens a small popover (an nsh/base `Popover`, as the
 * picker's columns): the switch, one row per consultant (its logo, model and level, and a × to
 * take it out), and "add a consultant", which is the cascading picker (`TunePicker`) over agent,
 * model and level (`consult-tune-tree.ts`). At most three; what a press comes to is
 * `consult.ts`'s, and the owner sends it (`PATCH consult`).
 *
 * On a phone (ADR 0116 addendum 2026-11-23, the phone's +) the menu is a sheet from the bottom, its
 * rows sized for a thumb, and the add picker's sheet goes over it. There the composer keeps the pill
 * (`ConsultChip`) on its row only while the switch is on, and opens the sheet from its + as well:
 * the sheet alone (`pill={false}`, opened through `onHandle`) is held once in the +'s sheet and once
 * outside the row for the chip, so turning the switch off takes the chip away, not the sheet.
 */
import { cleanup, signal, Text, View, type ViewRef } from "nsh";
import { Popover } from "nsh/base";
import { CONSULT_MEMBERS_MAX, type AgentsStatusResponse, type ClaudeCodeStatus, type ConsultMember, type ProjectConsultSetting } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api";
import { canAddMember, withMember, withoutMember, withSwitch } from "../../m/chat/consult";
import { modelLabel } from "../../m/taskmap/model-label";
import { frameOf, onPressOutside } from "../../platform/press";
import { copy } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { AgentLogo } from "../settings/AgentLogo";
import { shadow } from "../styles";
import { Switch } from "../Switch";
import { tip } from "../tip";
import { consultAccountLabel, consultTuneTree } from "./consult-tune-tree";
import { TunePicker } from "./TunePicker";

/** What opens the menu from elsewhere: the phone's + and its chip. */
export type ConsultHandle = { open(): void };

/** A copy: the setting comes from the runtime's store, whose arrays an `Each` must not draw directly. */
const membersOf = (setting: ProjectConsultSetting | null | undefined): ConsultMember[] => (setting?.members ?? []).map((member) => ({ ...member }));
const consultOn = (setting: ProjectConsultSetting | null | undefined) => Boolean(setting?.on) && membersOf(setting).length > 0;
const memberName = (member: ConsultMember) => modelLabel(member.model) || copy().project.agentNames[member.agent];
const memberKey = (member: ConsultMember) => `${member.agent}|${member.config_dir ?? ""}|${member.model ?? ""}|${member.effort ?? ""}`;

/** Who the consultants are, in a line (the phone's + says it under 参谋); null with none. */
export function consultNames(setting: ProjectConsultSetting | null | undefined): string | null {
  const members = membersOf(setting);
  return members.length > 0 ? members.map(memberName).join(" · ") : null;
}

/** The pill: 参谋 and, while on, the consultants' logos. The desktop's trigger, and the phone row's chip while on. */
export function ConsultChip(props: {
  setting: ProjectConsultSetting | null | undefined;
  agentName: string;
  disabled: boolean;
  /** Its menu is open now (no tooltip then). */
  expanded?: boolean;
  /**
   * The phone row's chip, which must leave Send and Stop room: no word, and the logos (`logos`) or,
   * where the row has no room for them, the number of consultants (`count`; `phone-chips.ts`).
   */
  look?: "logos" | "count";
  onPress: () => void;
  ref?: (node: ViewRef) => void;
}) {
  const t = () => copy();
  const members = () => membersOf(props.setting);
  const on = () => consultOn(props.setting);
  return (
    <View
      ref={(node: ViewRef) => props.ref?.(node)}
      role="button"
      testID="project-consult"
      tooltip={props.expanded ? undefined : tip(on() ? t().project.consultOnHint(props.agentName, members().length) : t().project.consultOffHint(props.agentName))}
      accessibilityLabel={t().project.consult}
      accessibilityState={{ selected: on(), expanded: Boolean(props.expanded), disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default group shrink-0 flex-row items-center gap-1 ${narrowWindow() ? "h-[36px]" : "h-[28px]"} ${props.look ? "px-[7px]" : "pl-[7px] pr-[9px]"} rounded-full border disabled:opacity-[0.4] ${on() ? "bg-accent-tint border-accent-border" : "border-transparent hover:bg-line-subtle"}`}
    >
      <Icon name="users" size={16} class={on() ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"} />
      <If when={!props.look}>
        <Text class={`text-[12px] font-medium ${on() ? "text-brand" : "text-ink-muted group-hover:text-ink"}`}>{t().project.consult}</Text>
      </If>
      <If when={props.look === "count" && on()}>
        <Text testID="consult-count" class="text-[12px] font-medium tabular-nums text-brand">{String(members().length)}</Text>
      </If>
      <If when={props.look !== "count" && on()}>
        <View testID="consult-logos" class="flex-row items-center gap-[3px]">
          <Each of={members()} key={memberKey}>
            {(member) => <AgentLogo runner={member().agent} size={14} />}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function ConsultPill(props: {
  setting: ProjectConsultSetting | null | undefined;
  /** The session's agent: whose line the consultants are asked about, in the tooltip. */
  agentName: string;
  disabled: boolean;
  agents: AgentsStatusResponse | null;
  claude: ClaudeCodeStatus | null;
  client: Pick<MessengerApi, "claudeCodeModels"> | null;
  /** Called as the menu opens, to ask again for the agents and models the picker lists. */
  onOpen?: () => void;
  onChange: (next: ProjectConsultSetting) => void;
  /** False: no pill of its own, only the phone's sheet, which `onHandle`'s opener opens. */
  pill?: boolean;
  onHandle?: (handle: ConsultHandle | null) => void;
}) {
  const t = () => copy();
  const phone = () => narrowWindow();
  const open = signal(false);
  /** The add picker's columns are out: a press there is the picker's, not outside this menu. */
  const adding = signal(false);
  let menuRef: ViewRef | null = null;
  let triggerRef: ViewRef | null = null;
  function openMenu(): void {
    if (props.disabled || open()) return;
    props.onOpen?.();
    open.set(true);
  }
  props.onHandle?.({ open: openMenu });
  cleanup(() => props.onHandle?.(null));
  // A press outside the menu and its pill puts it away, as the model picker's does; the pill toggles it
  // itself. Whether to is read at the press: a pick in the add picker closes that picker before the
  // frames are measured, and must not take the menu with it. A phone's sheet has its own backdrop.
  let armed = false;
  onPressOutside(
    async () => {
      armed = !phone() && open() && !adding();
      return armed ? Promise.all([menuRef, triggerRef].map((view) => frameOf(view))) : [];
    },
    () => {
      if (armed && open()) open.set(false);
    },
  );
  const members = () => membersOf(props.setting);
  const on = () => consultOn(props.setting);
  /** The model and, quieter, its level and account. */
  const levelOf = (member: ConsultMember) => (member.effort ? (t().sidebar.thinkingLevels[member.effort as keyof ReturnType<typeof copy>["sidebar"]["thinkingLevels"]] ?? member.effort) : null);
  const accountOf = (member: ConsultMember) => consultAccountLabel(member, props.agents, props.claude, t());

  const tree = consultTuneTree({
    get t() {
      return copy();
    },
    get agents() {
      return props.agents;
    },
    get claude() {
      return props.claude;
    },
    get client() {
      return props.client;
    },
    onPick: (member) => {
      if (canAddMember(props.setting, member)) props.onChange(withMember(props.setting, member));
    },
  });

  const trigger = (
    <ConsultChip
      ref={(node) => (triggerRef = node)}
      setting={props.setting}
      agentName={props.agentName}
      disabled={props.disabled}
      expanded={open()}
      onPress={() => (open() ? open.set(false) : openMenu())}
    />
  );

  /** The switch, the consultants and "add one": the popover's, or on a phone the sheet's, rows a thumb's size. */
  const menu = (sheet: boolean) => (
    <View
      ref={(node: ViewRef) => (menuRef = node)}
      testID="consult-menu"
      accessibilityLabel={t().project.consultMenu}
      class={sheet ? "w-full gap-1" : "w-[300px] p-1 bg-pane border border-line rounded-(--radius-md)"}
      style={sheet ? undefined : { boxShadow: shadow("menu") }}
    >
      <View class={`flex-row items-center gap-2 ${sheet ? "min-h-[48px] px-3" : "px-[10px] py-[6px]"}`}>
        <Text class={`flex-1 min-w-0 font-medium text-ink ${sheet ? "text-[15px]" : "text-[13px]"}`}>{t().project.consultSwitch}</Text>
        <Switch
          testID="consult-switch"
          label={t().project.consultSwitch}
          checked={on()}
          disabled={members().length === 0}
          onChange={(checked) => props.onChange(withSwitch(props.setting, checked))}
        />
      </View>
      <Each of={members()} key={memberKey}>
        {(member, index) => (
          <View testID={`consult-member-${index()}`} class={`flex-row items-center gap-2 rounded-(--radius-sm) ${sheet ? "min-h-[48px] pl-3 pr-1" : "px-[10px] py-[5px]"}`}>
            <AgentLogo runner={member().agent} size={sheet ? 20 : 18} />
            <View class="flex-1 shrink min-w-0">
              <Text class={`font-medium text-ink line-clamp-1 ${sheet ? "text-[15px]" : "text-[13px]"}`}>
                <Text>{memberName(member())}</Text>
                <If when={levelOf(member())}>{(level) => <Text class="text-ink-muted">{` · ${level()}`}</Text>}</If>
              </Text>
              <If when={accountOf(member())}>
                {(acct) => (
                  <Text testID={`consult-member-account-${index()}`} class={`text-ink-muted line-clamp-1 ${sheet ? "text-[12px]" : "text-[11px]"}`}>
                    {acct()}
                  </Text>
                )}
              </If>
            </View>
            <View
              role="button"
              testID={`consult-remove-${index()}`}
              tooltip={tip(t().project.consultRemove(memberName(member())))}
              accessibilityLabel={t().project.consultRemove(memberName(member()))}
              onPress={() => props.onChange(withoutMember(props.setting, index()))}
              class={`cursor-pointer select-none group shrink-0 items-center justify-center rounded-full hover:bg-line-subtle active:bg-line-subtle ${sheet ? "w-[40px] h-[40px]" : "w-[22px] h-[22px]"}`}
            >
              <Icon name="x" size={sheet ? 16 : 12} class="tint-ink-muted group-hover:tint-ink" />
            </View>
          </View>
        )}
      </Each>
      <If when={members().length < CONSULT_MEMBERS_MAX}>
        <TunePicker
          tree={tree}
          plain={t().project.consultAdd}
          label={t().project.consultAdd}
          value=""
          title={t().project.consultAdd}
          sheetTitle={t().project.consult}
          disabled={props.disabled}
          onOpen={props.onOpen}
          onOpenChange={(out) => adding.set(out)}
          testID="consult-add"
        />
      </If>
      <If when={members().length >= CONSULT_MEMBERS_MAX}>
        <Text testID="consult-full" class={`text-ink-muted ${sheet ? "px-3 py-[10px] text-[13px]" : "px-[10px] py-[6px] text-[12px]"}`}>{t().project.consultFull}</Text>
      </If>
    </View>
  );

  return (
    <If
      when={phone()}
      else={
        <View class="shrink-0 relative">
          <Popover
            open={open()}
            placement="top"
            align="start"
            offset={6}
            closeOnEscape
            onOpenChange={(e) => open.set(e.open)}
            trigger={trigger}
            popupClass="bg-transparent"
          >
            {menu(false)}
          </Popover>
        </View>
      }
    >
      <If when={props.pill !== false}>{trigger}</If>
      <If when={open()}>
        <BottomSheet title={t().project.consultMenu} closeLabel={t().common.close} onClose={() => open.set(false)} testID="consult-sheet">
          {menu(true)}
        </BottomSheet>
      </If>
    </If>
  );
}
