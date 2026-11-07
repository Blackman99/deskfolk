/**
 * The newest changes to the interface profile, who made them, and the way back: undo the latest, or
 * restore an older one (`settings/InterfaceHistoryCard.svelte`). `revisionWho` and `revisionWhen`
 * (exported from the Svelte module script) are in `interface-history.ts`.
 *
 * Props: `recent` (the newest revision heads); `bots` (to name who); `locale`. Test ids:
 * `revision-<id>`, `revision-undo-<id>`, `revision-restore-<id>`. Undo is one of the floor (ADR 0108).
 */
import { signal, Text, View } from "nsh";
import type { InterfaceRevisionHead } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import type { Snapshot } from "../../m/snapshot.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { Button } from "../Button";
import { SettingsCard } from "./SettingsCard";
import { revisionWhen, revisionWho } from "./interface-history";

const SHOWN_CHANGES = 3;

export function InterfaceHistoryCard(props: { recent: InterfaceRevisionHead[]; bots: Snapshot["bots"]; locale: "zh" | "en" }) {
  const t = () => copy();
  const c = () => t().ui.history;
  const busy = signal<string | null>(null);

  async function run(head: InterfaceRevisionHead, kind: "undo" | "restore"): Promise<void> {
    const api = runtime.client;
    if (!api || busy()) return;
    busy.set(head.id);
    try {
      if (kind === "undo") await api.undoInterfaceRevision(head.id);
      else await api.restoreInterfaceRevision(head.id);
      showToast(kind === "undo" ? c().undone : c().restored, { tone: "neutral" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { tone: "error" });
    } finally {
      busy.set(null);
    }
  }

  return (
    <SettingsCard testID="interface-history">
      <Text role="header" class="text-[14px] font-semibold text-ink">{t().ui.sections.history}</Text>
      <If when={props.recent.length > 0} else={<Text testID="history-empty" class="text-[13px] text-ink-muted">{c().empty}</Text>}>
        <View class="flex-col">
          <Each of={props.recent.slice()} key={(head) => head.id}>
            {(head) => (
              <View testID={`revision-${head().id}`} class="flex-row items-start gap-[10px] py-2 border-t border-line-subtle">
                <View class="flex-col gap-1 min-w-0 shrink grow">
                  <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-[2px]">
                    <Text class="text-[13px] font-semibold text-ink">{revisionWho(head(), props.bots, c())}</Text>
                    <Text class="text-[12px] text-ink-muted">{c().ops[head().op]}</Text>
                    <Text class="text-[12px] text-ink-muted">{revisionWhen(head().created_at, props.locale)}</Text>
                  </View>
                  <If when={head().changes.length > 0}>
                    <View class="flex-col gap-px">
                      <Each of={head().changes.slice(0, SHOWN_CHANGES)} key={(line, at) => `${at}:${line}`}>
                        {(line) => <Text class="font-mono text-[12px] leading-[1.5] text-ink-secondary">{line()}</Text>}
                      </Each>
                      <If when={head().changes.length > SHOWN_CHANGES}>
                        <Text class="text-[12px] text-ink-muted">{c().more.replace("{n}", String(head().changes.length - SHOWN_CHANGES))}</Text>
                      </If>
                    </View>
                  </If>
                </View>
                <View class="flex-row flex-wrap justify-end gap-1 shrink-0">
                  <If when={head().undoable}>
                    <Button size="sm" variant="secondary" floor="interface-undo" testID={`revision-undo-${head().id}`} disabled={busy() !== null} onPress={() => void run(head(), "undo")}>
                      {c().undo}
                    </Button>
                  </If>
                  <Button size="sm" variant="ghost" testID={`revision-restore-${head().id}`} disabled={busy() !== null} onPress={() => void run(head(), "restore")}>
                    {c().restore}
                  </Button>
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>
    </SettingsCard>
  );
}
