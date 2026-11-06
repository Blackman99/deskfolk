/**
 * The Bot settings' sections (`BotTabNav.svelte`): a tab strip in a wide window, a list of rows
 * with a chevron on a phone (each row opens its section's screen).
 */
import { Text, View } from "nsh";
import type { Memory, Skill } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";

export type BotTab = "basics" | "skills" | "routines" | "memory" | "actions";

export function BotTabNav(props: {
  activeTab: BotTab;
  basicsHasError: boolean;
  profileSkills: readonly Skill[];
  routineCount: number;
  profileMemories: readonly Memory[];
  switchTab: (tab: BotTab) => void;
}) {
  const tabs = (): { id: BotTab; icon: IconName; name: string; count: number; error?: boolean }[] => [
    { id: "basics", icon: "user", name: copy().detail.botTabBasics, count: 0, error: props.basicsHasError },
    { id: "skills", icon: "zap", name: copy().detail.botTabSkills, count: props.profileSkills.length },
    { id: "routines", icon: "calendar", name: copy().detail.botTabRoutines, count: props.routineCount },
    { id: "memory", icon: "book", name: copy().detail.botTabMemory, count: props.profileMemories.length },
    { id: "actions", icon: "settings", name: copy().detail.botTabActions, count: 0 },
  ];
  return (
    <View
      role="tablist"
      testID="bot-tabs"
      accessibilityLabel={copy().detail.titleBot}
      class={narrowWindow() ? "flex-col rounded-(--radius-lg) overflow-hidden" : "flex-row w-full"}
    >
      <Each of={tabs()} key={(tab) => tab.id}>
        {(tab, index) => {
          const active = () => props.activeTab === tab().id;
          const phone = () => narrowWindow();
          return (
            <View
              role="tab"
              testID={`bot-tab-${tab().id}`}
              accessibilityLabel={tab().name}
              accessibilityState={{ selected: active() }}
              onPress={() => props.switchTab(tab().id)}
              class={
                phone()
                  ? `relative flex-row items-center gap-[10px] min-h-[54px] px-[14px] bg-pane active:bg-row-hover ${index() > 0 ? "border-t border-line" : ""}`
                  : `flex-1 min-w-0 flex-row items-center justify-center gap-[5px] min-h-[40px] pt-[10px] pb-[8px] px-1 border-b-2 hover:bg-row-hover ${active() ? "border-brand" : "border-transparent"}`
              }
            >
              <Icon name={tab().icon} size={phone() ? 20 : 16} class={active() && !phone() ? "tint-brand" : "tint-ink-muted"} />
              <Text
                class={`${phone() ? "flex-1 min-w-0 text-[15px] font-medium text-ink" : `text-[12px] ${active() ? "font-semibold text-brand" : "font-medium text-ink-secondary"}`} line-clamp-1`}
              >
                {tab().name}
              </Text>
              <If when={tab().error}>
                <View testID="bot-tab-error" accessibilityLabel="error" class="w-[14px] h-[14px] rounded-full bg-danger items-center justify-center ml-[2px]">
                  <Text class="text-[10px] font-bold text-on-danger">!</Text>
                </View>
              </If>
              <If when={tab().count > 0}>
                <View class={`px-[5px] rounded-full ${phone() ? "ml-2" : ""} ${active() && !phone() ? "bg-line-subtle" : "bg-chip"}`}>
                  <Text class={`text-[11px] font-semibold ${active() && !phone() ? "text-ink" : "text-ink-secondary"}`}>{String(tab().count)}</Text>
                </View>
              </If>
              <If when={phone()}>
                <Icon name="chevron-right" size={16} class="tint-ink-muted ml-2" />
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
