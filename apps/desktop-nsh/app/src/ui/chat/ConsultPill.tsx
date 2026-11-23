/**
 * The composer's consultant switch (ADR 0116 addendum 2026-11-23), a pill beside Plan mode: on, every
 * line you send makes the agent first ask the chosen consultants, each on its own, and then sum up
 * their views with its own. Pressed it opens a small popover (an nsh/base `Popover`, as the
 * picker's columns): the switch, one row per consultant (its logo, model and level, and a × to
 * take it out), and "add a consultant", which is the cascading picker (`TunePicker`) over agent,
 * model and level (`consult-tune-tree.ts`). At most three; what a press comes to is
 * `consult.ts`'s, and the owner sends it (`PATCH consult`).
 */
import { signal, Text, View, type ViewRef } from "nsh";
import { Popover } from "nsh/base";
import { CONSULT_MEMBERS_MAX, type AgentsStatusResponse, type ConsultMember, type ProjectConsultSetting } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api";
import { canAddMember, withMember, withoutMember, withSwitch } from "../../m/chat/consult";
import { modelLabel } from "../../m/taskmap/model-label";
import { frameOf, onPressOutside } from "../../platform/press";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { AgentLogo } from "../settings/AgentLogo";
import { shadow } from "../styles";
import { Switch } from "../Switch";
import { tip } from "../tip";
import { consultTuneTree } from "./consult-tune-tree";
import { TunePicker } from "./TunePicker";

export function ConsultPill(props: {
  setting: ProjectConsultSetting | null | undefined;
  /** The session's agent: whose line the consultants are asked about, in the tooltip. */
  agentName: string;
  disabled: boolean;
  agents: AgentsStatusResponse | null;
  client: Pick<MessengerApi, "claudeCodeModels"> | null;
  /** Called as the menu opens, to ask again for the agents and models the picker lists. */
  onOpen?: () => void;
  onChange: (next: ProjectConsultSetting) => void;
}) {
  const t = () => copy();
  const open = signal(false);
  /** The add picker's columns are out: a press there is the picker's, not outside this menu. */
  const adding = signal(false);
  let menuRef: ViewRef | null = null;
  let triggerRef: ViewRef | null = null;
  // A press outside the menu and its pill puts it away, as the model picker's does; the pill toggles it
  // itself. Whether to is read at the press: a pick in the add picker closes that picker before the
  // frames are measured, and must not take the menu with it.
  let armed = false;
  onPressOutside(
    async () => {
      armed = open() && !adding();
      return armed ? Promise.all([menuRef, triggerRef].map((view) => frameOf(view))) : [];
    },
    () => {
      if (armed && open()) open.set(false);
    },
  );
  /** A copy: the setting comes from the runtime's store, whose arrays an `Each` must not draw directly. */
  const members = (): ConsultMember[] => (props.setting?.members ?? []).map((member) => ({ ...member }));
  const on = () => Boolean(props.setting?.on) && members().length > 0;
  const nameOf = (member: ConsultMember) => modelLabel(member.model) || t().project.agentNames[member.agent];
  /** The model and, quieter, its level. */
  const levelOf = (member: ConsultMember) => (member.effort ? (t().sidebar.thinkingLevels[member.effort as keyof ReturnType<typeof copy>["sidebar"]["thinkingLevels"]] ?? member.effort) : null);

  const tree = consultTuneTree({
    get t() {
      return copy();
    },
    get agents() {
      return props.agents;
    },
    get client() {
      return props.client;
    },
    onPick: (member) => {
      if (canAddMember(props.setting, member)) props.onChange(withMember(props.setting, member));
    },
  });

  const trigger = (
    <View
      ref={(node: ViewRef) => (triggerRef = node)}
      role="button"
      testID="project-consult"
      tooltip={open() ? undefined : tip(on() ? t().project.consultOnHint(props.agentName, members().length) : t().project.consultOffHint(props.agentName))}
      accessibilityLabel={t().project.consult}
      accessibilityState={{ selected: on(), expanded: open(), disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => {
        if (!open()) props.onOpen?.();
        open.set(!open());
      }}
      class={`cursor-pointer select-none disabled:cursor-default group shrink-0 flex-row items-center gap-1 h-[28px] pl-[7px] pr-[9px] rounded-full border disabled:opacity-[0.4] ${on() ? "bg-accent-tint border-accent-border" : "border-transparent hover:bg-line-subtle"}`}
    >
      <Icon name="users" size={16} class={on() ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"} />
      <Text class={`text-[12px] font-medium ${on() ? "text-brand" : "text-ink-muted group-hover:text-ink"}`}>{t().project.consult}</Text>
      <If when={on()}>
        <View testID="consult-logos" class="flex-row items-center gap-[3px]">
          <Each of={members()} key={(member) => `${member.agent}|${member.model ?? ""}|${member.effort ?? ""}`}>
            {(member) => <AgentLogo runner={member().agent} size={14} />}
          </Each>
        </View>
      </If>
    </View>
  );

  return (
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
        <View
          ref={(node: ViewRef) => (menuRef = node)}
          testID="consult-menu"
          accessibilityLabel={t().project.consultMenu}
          class="w-[300px] p-1 bg-pane border border-line rounded-(--radius-md)"
          style={{ boxShadow: shadow("menu") }}
        >
          <View class="flex-row items-center gap-2 px-[10px] py-[6px]">
            <Text class="flex-1 min-w-0 text-[13px] font-medium text-ink">{t().project.consultSwitch}</Text>
            <Switch
              testID="consult-switch"
              label={t().project.consultSwitch}
              checked={on()}
              disabled={members().length === 0}
              onChange={(checked) => props.onChange(withSwitch(props.setting, checked))}
            />
          </View>
          <Each of={members()} key={(member) => `${member.agent}|${member.model ?? ""}|${member.effort ?? ""}`}>
            {(member, index) => (
              <View testID={`consult-member-${index()}`} class="flex-row items-center gap-2 px-[10px] py-[5px] rounded-(--radius-sm)">
                <AgentLogo runner={member().agent} size={18} />
                <Text class="flex-1 shrink min-w-0 text-[13px] font-medium text-ink line-clamp-1">
                  <Text>{nameOf(member())}</Text>
                  <If when={levelOf(member())}>{(level) => <Text class="text-ink-muted">{` · ${level()}`}</Text>}</If>
                </Text>
                <View
                  role="button"
                  testID={`consult-remove-${index()}`}
                  tooltip={tip(t().project.consultRemove(nameOf(member())))}
                  accessibilityLabel={t().project.consultRemove(nameOf(member()))}
                  onPress={() => props.onChange(withoutMember(props.setting, index()))}
                  class="cursor-pointer select-none group shrink-0 w-[22px] h-[22px] items-center justify-center rounded-full hover:bg-line-subtle"
                >
                  <Icon name="x" size={12} class="tint-ink-muted group-hover:tint-ink" />
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
              onOpenChange={(out) => adding.set(out)}
              testID="consult-add"
            />
          </If>
          <If when={members().length >= CONSULT_MEMBERS_MAX}>
            <Text testID="consult-full" class="px-[10px] py-[6px] text-[12px] text-ink-muted">{t().project.consultFull}</Text>
          </If>
        </View>
      </Popover>
    </View>
  );
}
