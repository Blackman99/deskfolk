/**
 * The app's words you (or a Bot) changed, in the language shown (`settings/InterfaceCopyCard.svelte`):
 * a Bot adds them; here you put one back. Each row's `testID` is `copy-row-<key>`, its button
 * `copy-remove-<key>`.
 *
 * Props: `words` (the profile's `copy`); `locale`.
 */
import { Text, View } from "nsh";
import type { InterfaceProfile } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { editInterfaceOrToast } from "../../m/settings/interface-edit.ts";
import { Button } from "../Button";
import { SettingsCard } from "./SettingsCard";

export function InterfaceCopyCard(props: { words: InterfaceProfile["copy"]; locale: "zh" | "en" }) {
  const t = () => copy();
  const c = () => t().ui.copyWords;
  const entries = () => Object.entries(props.words[props.locale] ?? {}).sort(([a], [b]) => a.localeCompare(b));
  function putBack(key: string): void {
    void editInterfaceOrToast(runtime, { copy: { [props.locale]: { [key]: null } } });
  }
  return (
    <SettingsCard testID="interface-copy">
      <Text role="header" class="text-[14px] font-semibold text-ink">{t().ui.sections.copy}</Text>
      <If when={entries().length > 0} else={<Text testID="copy-empty" class="text-[13px] text-ink-muted">{c().empty}</Text>}>
        <View class="flex-col">
          <Each of={entries()} key={([key]) => key}>
            {(entry) => (
              <View testID={`copy-row-${entry()[0]}`} class="flex-row items-center gap-[10px] py-[6px] border-t border-line-subtle">
                <View class="flex-col gap-[2px] min-w-0 shrink grow">
                  <Text class="font-mono text-[12px] leading-[1.5] text-ink-muted">{entry()[0]}</Text>
                  <Text class="text-[13px] text-ink">{entry()[1]}</Text>
                </View>
                <Button size="sm" variant="ghost" testID={`copy-remove-${entry()[0]}`} onPress={() => putBack(entry()[0])}>{c().remove}</Button>
              </View>
            )}
          </Each>
        </View>
      </If>
    </SettingsCard>
  );
}
