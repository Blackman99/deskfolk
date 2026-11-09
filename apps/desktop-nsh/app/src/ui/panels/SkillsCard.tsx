/**
 * The skills tab's list (`SkillsCard.svelte`). The editor's state lives in ProfilePane: its sheet
 * sits outside the pane. A row opens the editor; the desktop row also carries an enabled box and
 * edit and delete buttons, the phone row a switch.
 */
import { Text, View } from "nsh";
import type { Skill } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { Switch } from "../Switch";
import { tip } from "../tip";
import { FIELD_ERROR, PANEL_CARD, PANEL_CARD_BODY, PANEL_CARD_HEAD, PANEL_CARD_TITLE, PANEL_COUNTER } from "./panel-card";

export function SkillsCard(props: {
  profileSkills: readonly Skill[];
  skillEditor: "add" | string | null;
  skillFailed: boolean;
  openAddSkill: () => void;
  openEditSkill: (id: string) => void;
  toggleSkillEnabled: (id: string, enabled: boolean) => Promise<void>;
  openDeleteSkillConfirm: (id: string) => void;
}) {
  const phone = () => narrowWindow();
  return (
    <View testID="skills-card" class={phone() ? "" : PANEL_CARD}>
      <If when={!phone()}>
        <View class={PANEL_CARD_HEAD}>
          <View class="flex-row items-center gap-2">
            <Text class={PANEL_CARD_TITLE}>{copy().sidebar.skills}</Text>
            <View class={PANEL_COUNTER}>
              <Text testID="skills-count" class="text-[11px] font-bold text-ink-secondary">{String(props.profileSkills.length)}</Text>
            </View>
          </View>
          <View
            role="button"
            testID="skill-add"
            accessibilityLabel={copy().sidebar.skillAdd}
            tooltip={tip(copy().sidebar.skillAdd)}
            onPress={() => props.openAddSkill()}
            class="cursor-pointer select-none group flex-row items-center gap-1 px-[10px] py-1 rounded-(--radius-md) border border-line bg-btn-secondary-bg hover:bg-line-subtle hover:border-brand"
          >
            <Icon name="plus" size={12} class="tint-ink-secondary group-hover:tint-brand" />
            <Text class="text-[12px] font-semibold text-ink-secondary group-hover:text-brand">{copy().sidebar.skillAdd}</Text>
          </View>
        </View>
      </If>
      <View class={`flex-col ${phone() ? "gap-[10px]" : `gap-3 ${PANEL_CARD_BODY}`}`}>
        <If when={props.skillFailed && !props.skillEditor}>
          <Text role="alert" testID="skills-failed" class={FIELD_ERROR}>{copy().sidebar.saveFailed}</Text>
        </If>
        <If when={props.profileSkills.length === 0}>
          <View
            testID="skills-empty"
            class={`items-center justify-center text-center border border-dashed border-line rounded-(--radius-md) gap-2 ${phone() ? "py-9 px-4 gap-3 bg-pane rounded-(--radius-lg)" : "py-5 px-4 bg-sidebar-bg"}`}
          >
            <View class={phone() ? "w-[56px] h-[56px] rounded-full bg-sidebar-bg items-center justify-center" : "opacity-70"}>
              <Icon name="zap" size={32} class="tint-ink-muted" />
            </View>
            <Text class={`text-ink-muted text-center ${phone() ? "text-[14px]" : "text-[13px]"}`}>{copy().sidebar.skillsEmpty}</Text>
            <Button testID="skill-empty-add" variant="primary" size={phone() ? "lg" : "sm"} icon="plus" onPress={() => props.openAddSkill()}>
              {copy().sidebar.skillAdd}
            </Button>
          </View>
        </If>
        <Each of={props.profileSkills} key={(skill) => skill.id}>
          {(skill) => {
            const open = () => props.skillEditor === skill().id;
            const label = (base: string) => `${base}: ${skill().name}`;
            return (
              <View
                testID={`skill-row-${skill().id}`}
                class={`flex-row items-center gap-2 min-w-0 border ${skill().enabled || phone() ? "bg-pane" : "bg-sidebar-bg"} ${phone() ? "px-[14px] py-3 rounded-(--radius-lg)" : "px-[10px] py-[6px] rounded-(--radius-md) hover:border-accent-border"} ${open() ? "border-brand" : "border-line"} ${skill().enabled ? "" : "opacity-[0.65]"}`}
              >
                <View
                  role="button"
                  testID={`skill-open-${skill().id}`}
                  accessibilityLabel={label(copy().sidebar.skillEdit)}
                  onPress={() => props.openEditSkill(skill().id)}
                  class={`cursor-pointer select-none group flex-row items-center gap-[10px] flex-1 min-w-0 p-1 rounded-(--radius-sm) ${phone() ? "min-h-[52px] p-0" : ""}`}
                >
                  <View
                    class={`items-center justify-center shrink-0 ${phone() ? "w-[36px] h-[36px] rounded-(--radius-md)" : "w-[28px] h-[28px] rounded-(--radius-sm)"} ${skill().enabled ? "bg-accent-tint" : "bg-line-subtle"}`}
                  >
                    <Icon name="zap" size={phone() ? 20 : 16} class={skill().enabled ? "tint-brand" : "tint-ink-muted"} />
                  </View>
                  <View class="flex-1 min-w-0 gap-[2px]">
                    <View class="flex-row items-center gap-[6px] min-w-0">
                      <Text class={`font-semibold text-ink shrink group-hover:text-brand line-clamp-1 ${phone() ? "text-[15px]" : "text-[13px]"}`}>{skill().name}</Text>
                      <If when={skill().uses && skill().uses!.length > 0}>
                        <View tooltip={tip(skill().uses!.join(", "))} class="px-[5px] py-[1px] rounded-(--radius-xs) bg-line-subtle border border-line shrink-0">
                          <Text class="text-[10px] font-bold text-ink-secondary">MCP</Text>
                        </View>
                      </If>
                      <If when={!skill().enabled}>
                        <View class="px-[6px] py-[1px] rounded-full bg-sidebar-bg border border-line shrink-0">
                          <Text class="text-[11px] font-medium text-ink-muted">已停用</Text>
                        </View>
                      </If>
                    </View>
                    <Text class={`text-ink-muted ${phone() ? "text-[13px] line-clamp-2" : "text-[12px] line-clamp-1"}`}>{skill().description}</Text>
                    <If when={skill().learning}>
                      {(learning) => (
                        <Text class="text-[11px] text-ink-muted">
                          {learning().later === 0 ? copy().sidebar.learningNoneYet : copy().sidebar.learningLater(learning().later, learning().shorter)}
                        </Text>
                      )}
                    </If>
                  </View>
                </View>
                <If
                  when={!phone()}
                  else={
                    <Switch
                      testID={`skill-enabled-${skill().id}`}
                      label={label(copy().sidebar.skillEnabled)}
                      checked={skill().enabled}
                      onChange={() => void props.toggleSkillEnabled(skill().id, !skill().enabled)}
                    />
                  }
                >
                  <View class="flex-row items-center gap-[6px] shrink-0">
                    <Checkbox
                      testID={`skill-enabled-${skill().id}`}
                      class="pr-1"
                      checked={skill().enabled}
                      label={copy().sidebar.skillEnabled}
                      accessibilityLabel={label(copy().sidebar.skillEnabled)}
                      onChange={() => void props.toggleSkillEnabled(skill().id, !skill().enabled)}
                    />
                    <View
                      role="button"
                      testID={`skill-edit-${skill().id}`}
                      accessibilityLabel={label(copy().sidebar.skillEdit)}
                      tooltip={tip(copy().sidebar.skillEdit)}
                      onPress={() => props.openEditSkill(skill().id)}
                      class="cursor-pointer select-none group w-[26px] h-[26px] items-center justify-center rounded-(--radius-sm) border border-line bg-btn-secondary-bg hover:bg-line-subtle hover:border-brand"
                    >
                      <Icon name="edit" size={16} class="tint-ink-secondary group-hover:tint-brand" />
                    </View>
                    <View
                      role="button"
                      testID={`skill-delete-${skill().id}`}
                      accessibilityLabel={label(copy().sidebar.skillDelete)}
                      tooltip={tip(copy().sidebar.skillDelete)}
                      onPress={() => props.openDeleteSkillConfirm(skill().id)}
                      class="cursor-pointer select-none group w-[26px] h-[26px] items-center justify-center rounded-(--radius-sm) border border-line bg-btn-secondary-bg hover:bg-danger-bg hover:border-danger-line"
                    >
                      <Icon name="trash" size={16} class="tint-ink-secondary group-hover:tint-danger-text" />
                    </View>
                  </View>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
    </View>
  );
}
