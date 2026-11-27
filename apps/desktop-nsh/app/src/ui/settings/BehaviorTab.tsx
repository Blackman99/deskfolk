/**
 * Settings › Behavior (`settings/BehaviorTab.svelte`): how the app itself behaves on this machine,
 * apart from what it talks to — how external links open on desktop (in-app WebView vs system
 * browser) and where each kind of window opens on the desktop workbench.
 */
import { View } from "nsh";
import { ExternalLinkCard } from "./ExternalLinkCard";
import { OpenPlacementCard } from "./OpenPlacementCard";

export function BehaviorTab() {
  return (
    <View testID="settings-behavior" class="flex-col gap-[14px]">
      <ExternalLinkCard />
      <OpenPlacementCard />
    </View>
  );
}
