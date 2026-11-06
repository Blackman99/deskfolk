/**
 * Settings › Behavior (`settings/BehaviorTab.svelte`): how the app itself behaves on this machine,
 * apart from what it talks to. For now, where each kind of window opens on the desktop workbench,
 * so the tab is there only while the workbench is (the caller decides, as SettingsNav does).
 */
import { View } from "nsh";
import { OpenPlacementCard } from "./OpenPlacementCard";

export function BehaviorTab() {
  return (
    <View testID="settings-behavior" class="flex-col gap-[14px]">
      <OpenPlacementCard />
    </View>
  );
}
