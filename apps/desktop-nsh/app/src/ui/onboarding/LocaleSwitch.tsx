/**
 * The wizard's language. A new install starts in the system's (the daemon reads it when it makes
 * the database); this is the way out when that is not the one you read, before Settings is in
 * reach. It writes the same setting as Settings › General, so the whole app follows. It sits in
 * the card's corner: the card is its positioned parent. It is the card's first child, and the
 * welcome block after it spans the card's width over the corner, so it stands above its siblings
 * (`z-[1]`): drawn under that block, the English half took no click.
 */
import { safeArea, signal, Text, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { narrowWindow } from "../Modal";

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
      class="absolute z-[1] flex-row items-center gap-[2px] p-[2px] bg-chip border border-chip-line rounded-(--radius-md)"
      style={{ top: narrowWindow() ? 10 + safeArea().top : 14, right: narrowWindow() ? 12 : 14 }}
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
