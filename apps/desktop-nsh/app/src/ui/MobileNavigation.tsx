/**
 * A phone's bottom bar (`MobileNavigation.svelte`): your Bots' conversations, the project sessions
 * (ADR 0095), settings. The workspace is one of the Tools, not a destination of its own. The caller
 * mounts it on a phone; there is no media query to hide it.
 */
import { safeArea, Text, View } from "nsh";
import { copy } from "../runtime";
import { Icon, type IconName } from "./Icon";

export type Destination = "sessions" | "projects" | "settings";

export function MobileNavigation(props: {
  active: Destination;
  updateAvailable?: boolean;
  onNavigate: (destination: Destination) => void;
}) {
  const tab = (destination: Destination, icon: IconName, label: () => string, testID: string) => (
    <View
      role="button"
      testID={testID}
      accessibilityLabel={label()}
      accessibilityState={{ selected: props.active === destination }}
      onPress={() => props.onNavigate(destination)}
      class="items-center justify-center gap-1 min-w-[44px] min-h-[48px] px-2 py-[3px] rounded-(--radius-md) active:bg-row-hover active:scale-[0.96]"
    >
      <View>
        <Icon name={icon} size={24} filled={props.active === destination} class={props.active === destination ? "tint-brand" : "tint-ink-muted"} />
        <If when={destination === "settings" && props.updateAvailable}>
          <View
            testID="nav-update-dot"
            accessibilityLabel={copy().sidebar.updateAvailable}
            class="absolute top-[-1px] right-[-5px] w-[6px] h-[6px] rounded-full bg-brand"
          />
        </If>
      </View>
      <Text class={`text-[12px] ${props.active === destination ? "text-brand font-semibold" : "text-ink-muted font-medium"}`}>{label()}</Text>
    </View>
  );
  return (
    <View
      role="navigation"
      accessibilityLabel={copy().sidebar.mainNavigation}
      testID="mobile-nav"
      class="flex-row w-full px-3 pt-[3px] border-t border-line-subtle bg-pane"
      style={{ height: 60 + safeArea().bottom, paddingBottom: 3 + safeArea().bottom }}
    >
      <View class="flex-1">{tab("sessions", "message", () => copy().sidebar.botsTab, "nav-sessions")}</View>
      <View class="flex-1">{tab("projects", "folder", () => copy().project.section, "nav-projects")}</View>
      <View class="flex-1">{tab("settings", "settings", () => copy().settings.title, "nav-settings")}</View>
    </View>
  );
}
