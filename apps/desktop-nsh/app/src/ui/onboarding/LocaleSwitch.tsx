/**
 * The wizard's language. A new install starts in the system's (the daemon reads it when it makes
 * the database); this is the way out when that is not the one you read, before Settings is in
 * reach. It writes the same setting as Settings › General, so the whole app follows. It ends the
 * welcome's row at the card's top, in the flow: in the card's corner over the welcome, it had to
 * stand above it, or the English half took no click.
 */
import { signal, Text, View } from "nsh";
import { copy, runtime } from "../../runtime";

export function LocaleSwitch(props: { locale: "zh" | "en" }) {
  const busy = signal(false);
  const options = () =>
    [
      ["zh", copy().settings.localeZh],
      ["en", copy().settings.localeEn],
    ] as const;

  async function pick(next: "zh" | "en"): Promise<void> {
    if (next === props.locale || busy()) return;
    busy.set(true);
    try {
      await runtime.patchSettings({ locale: next });
    } finally {
      busy.set(false);
    }
  }

  return (
    <View
      testID="onboarding-locale"
      role="group"
      accessibilityLabel={copy().settings.language}
      class="shrink-0 flex-row items-center gap-[2px] p-[2px] bg-chip border border-chip-line rounded-(--radius-md)"
    >
      <Each of={options().slice()} key={(o) => o[0]}>
        {(option) => (
          <View
            role="button"
            testID={`locale-${option()[0]}`}
            accessibilityLabel={option()[1]}
            accessibilityState={{ selected: props.locale === option()[0], disabled: busy() }}
            disabled={busy()}
            onPress={() => void pick(option()[0])}
            class={`cursor-pointer select-none disabled:cursor-default px-[9px] py-[3px] rounded-(--radius-sm) disabled:opacity-[0.7] ${props.locale === option()[0] ? "bg-pane" : "hover:bg-line-subtle"}`}
          >
            <Text class={`text-[12px] ${props.locale === option()[0] ? "text-brand font-semibold" : "text-ink-muted font-medium"}`}>{option()[1]}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}
