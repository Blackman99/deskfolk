/**
 * The spend ledger as a page (`SpendOverlay.svelte`): it fills its host, over the sidebar's colour,
 * with the runtime's figures, Bots and endpoints. The messenger slides it in; here it just appears.
 */
import { View } from "nsh";
import { runtime } from "../../runtime";
import { SpendView } from "./SpendView";

export function SpendOverlay(props: { backLabel: string }) {
  return (
    <View testID="spend-page" class="absolute inset-0 min-w-0 min-h-0 bg-sidebar-bg" style={{ zIndex: 2 }}>
      <SpendView
        api={runtime.client}
        revision={runtime.spendRevision}
        locale={runtime.snapshot.settings.locale === "en" ? "en" : "zh"}
        capUsd={runtime.snapshot.settings.spend_cap_usd ?? null}
        onSetCap={(usd) => runtime.patchSettings({ spend_cap_usd: usd })}
        bots={runtime.snapshot.bots}
        providers={runtime.snapshot.providers}
        backLabel={props.backLabel}
        onClose={() => runtime.closeSpend()}
        onOpenSession={(sessionId) => void runtime.openChat(sessionId)}
        onOpenTrigger={(sessionId, messageId) => void runtime.openChat(sessionId, { messageId })}
      />
    </View>
  );
}
