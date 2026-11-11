/**
 * Design tokens you set, by look (`settings/InterfaceTokensCard.svelte`): a list with a swatch, the
 * name, the look it is for and its value; a row's button puts it back to the app's own; a form adds
 * one for light, dark or both.
 *
 * Differs: the Svelte swatch asked the browser's `CSS.supports('color', value)`. NSH has no CSS
 * engine to ask, so a value draws a swatch when it is a hex colour or an rgb/hsl/hwb/lab/lch/oklab/oklch
 * function (`showsColour`); any other value (a named colour, `var(--x)`, `color-mix(...)`) gets the
 * dashed empty swatch, though it is saved and sent just the same.
 *
 * Props: `tokens` (the profile's). Test ids: `token-<side>-<name>` (row), `token-remove-<side>-<name>`,
 * `token-swatch-<side>-<name>`, `token-name`, `token-value`, `token-look-<light|dark|both>`,
 * `token-add`, `token-problem`.
 */
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { InterfaceTokens } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { editInterface, editInterfaceOrToast } from "../../m/settings/interface-edit.ts";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { InterfaceSegmented } from "./InterfaceSegmented";
import { SettingsCard } from "./SettingsCard";

type Look = "light" | "dark" | "both";
const LOOKS: Look[] = ["light", "dark", "both"];

const FIELD = "h-7 min-w-0 px-2 border border-line rounded-(--radius-sm) bg-pane text-ink font-mono text-[13px] focus:border-field-focus-border";

/** Whether a token value is a colour this card can draw (see the file comment). */
export function showsColour(text: string): boolean {
  return /^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch)a?\([^)]*\))$/i.test(text.trim());
}

export function InterfaceTokensCard(props: { tokens: InterfaceTokens }) {
  const t = () => copy();
  const c = () => t().ui.tokens;
  const entries = () =>
    (["light", "dark"] as const).flatMap((side) =>
      Object.entries(props.tokens[side])
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => ({ side, name, value })),
    );

  const name = signal("");
  const value = signal("");
  const look = signal<Look>("both");
  const problem = signal<string | null>(null);
  const busy = signal(false);

  const lookLabel = (side: Look) => (side === "light" ? c().light : side === "dark" ? c().dark : c().both);
  const canAdd = () => !busy() && !!name().trim() && !!value().trim();

  function remove(side: "light" | "dark", token: string): void {
    void editInterfaceOrToast(runtime, { tokens: { [side]: { [token]: null } } });
  }

  async function add(): Promise<void> {
    if (!canAdd()) return;
    busy.set(true);
    problem.set(null);
    const result = await editInterface(runtime, { tokens: { [look()]: { [name().trim()]: value().trim() } } });
    busy.set(false);
    if (result.ok) {
      name.set("");
      value.set("");
    } else problem.set(result.message);
  }

  return (
    <SettingsCard testID="interface-tokens">
      <Text role="header" class="text-[14px] font-semibold text-ink">{t().ui.sections.tokens}</Text>
      <If when={entries().length > 0} else={<Text testID="tokens-empty" class="text-[13px] text-ink-muted">{c().empty}</Text>}>
        <View class="flex-col">
          <Each of={entries()} key={(entry) => `${entry.side}:${entry.name}`}>
            {(entry) => (
              <View testID={`token-${entry().side}-${entry().name}`} class="flex-row flex-wrap items-center gap-2 py-[6px] border-t border-line-subtle min-w-0">
                <View
                  testID={`token-swatch-${entry().side}-${entry().name}`}
                  class={`w-4 h-4 shrink-0 rounded-(--radius-xs) border ${showsColour(entry().value) ? "border-line" : "border-dashed border-line"}`}
                  style={showsColour(entry().value) ? { backgroundColor: entry().value } : undefined}
                />
                <Text class="shrink-0 font-mono text-[12px] text-ink line-clamp-1">{entry().name}</Text>
                <View class="shrink-0 px-[6px] rounded-full bg-chip">
                  <Text class="text-[11px] leading-4 text-ink-secondary">{lookLabel(entry().side)}</Text>
                </View>
                <Text class="grow shrink min-w-0 font-mono text-[12px] text-ink-secondary line-clamp-1">{entry().value}</Text>
                <IconButton
                  icon="x"
                  size="sm"
                  testID={`token-remove-${entry().side}-${entry().name}`}
                  label={`${c().remove} ${entry().name}`}
                  onPress={() => remove(entry().side, entry().name)}
                />
              </View>
            )}
          </Each>
        </View>
      </If>

      <View class="flex-col gap-2 pt-[10px] border-t border-line-subtle">
        <Text class="text-[12px] font-semibold text-ink-secondary">{c().add}</Text>
        <View class="flex-row flex-wrap items-center gap-2">
          <Input
            testID="token-name"
            accessibilityLabel={c().name}
            placeholder="--accent"
            autoCapitalize="none"
            autoCorrect={false}
            value={name()}
            onChange={(e) => name.set(e.value)}
            onSubmit={() => void add()}
            class={`grow basis-[140px] ${FIELD}`}
          />
          <Input
            testID="token-value"
            accessibilityLabel={c().value}
            placeholder={c().value}
            autoCapitalize="none"
            autoCorrect={false}
            value={value()}
            onChange={(e) => value.set(e.value)}
            onSubmit={() => void add()}
            class={`grow basis-[140px] ${FIELD}`}
          />
          <InterfaceSegmented
            testID="token-looks"
            ariaLabel={c().add}
            value={look()}
            onPick={(next) => look.set(next)}
            options={LOOKS.map((option) => ({ value: option, label: lookLabel(option), testID: `token-look-${option}` }))}
          />
          <Button size="sm" variant="secondary" testID="token-add" disabled={!canAdd()} onPress={() => void add()}>{c().add}</Button>
        </View>
        <If when={problem()}>
          <Text testID="token-problem" role="alert" class="text-[12px] text-danger-text">{problem() ?? ""}</Text>
        </If>
      </View>
    </SettingsCard>
  );
}
