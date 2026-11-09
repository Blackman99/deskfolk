/**
 * The relay setup walk-through under the remote card's connect form (`settings/RelayGuide.svelte`):
 * a block that is closed until its summary is pressed, with the five steps and the command to copy
 * for each, and a button to the full guide. One copied mark at a time, like the pairing code's.
 *
 * Not carried over: the commands keep their lines in a block that scrolls sideways (`Scroll
 * horizontal`) as the `<pre>` did; the disclosure arrow is the chevron icon, rotated by state.
 *
 * Props: `locale` (picks the guide's language). Strings come from `copy()`.
 */
import { Clipboard, Scroll, signal, Text, View } from "nsh";
import { copy } from "../../runtime";
import { openExternalLink } from "../../m/open-link.ts";
import { RELAY_GUIDE_COMMANDS, relayGuideUrl, type RelayGuideStep } from "../../m/settings/relay-guide.ts";
import { Button } from "../Button";
import { Icon } from "../Icon";

type Step = { text: string; command?: RelayGuideStep; note?: string };

export function RelayGuide(props: { locale: "zh" | "en" }) {
  const t = () => copy();
  const open = signal(false);
  /** The block whose button last copied. */
  const copied = signal<RelayGuideStep | null>(null);
  /** Step 4 is the form above, so it has words and no command. */
  const steps = (): Step[] => [
    { text: t().remote.relayGuidePrepare, command: "prepare" },
    { text: t().remote.relayGuideEnv, command: "env" },
    { text: t().remote.relayGuideUp, command: "up", note: t().remote.relayGuideUpNote },
    { text: t().remote.relayGuideFill },
    { text: t().remote.relayGuidePairingOff, command: "pairingOff" },
  ];
  return (
    <View testID="relay-guide" class="flex-col min-w-0 border border-line rounded-(--radius-md) bg-pane">
      <View
        role="button"
        testID="relay-guide-summary"
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="cursor-pointer select-none flex-row items-center gap-[6px] px-3 py-2"
      >
        <Icon name={open() ? "chevron-down" : "chevron-right"} size={12} class="tint-brand" />
        <Text class="text-[13px] font-semibold text-brand">{t().remote.relayGuideSummary}</Text>
      </View>
      <If when={open()}>
        <View testID="relay-guide-body" class="flex-col gap-3 px-3 pb-3">
          <Text class="text-[13px] leading-[1.55] text-ink-secondary">{t().remote.relayGuideLead}</Text>
          <View class="flex-col gap-[14px]">
            <Each of={steps()} key={(_, index) => index}>
              {(step, index) => (
                <View class="flex-col gap-[6px] min-w-0 pl-[26px] relative">
                  <View class="absolute left-0 top-px w-[18px] h-[18px] rounded-full border border-line bg-sidebar-bg items-center justify-center">
                    <Text class="text-[11px] font-semibold text-ink-secondary">{String(index() + 1)}</Text>
                  </View>
                  <Text class="text-[13px] leading-[1.55] text-ink">{step().text}</Text>
                  <If when={step().command}>
                    {(command) => (
                      <View class="flex-row items-start gap-2 min-w-0">
                        <Scroll horizontal class="grow shrink min-w-0 border border-line rounded-(--radius-sm) bg-input-bg">
                          <Text testID={`relay-guide-${command()}`} class="px-[10px] py-2 font-mono text-[11px] leading-[1.55] text-ink-secondary">
                            {RELAY_GUIDE_COMMANDS[command()]}
                          </Text>
                        </Scroll>
                        <Button
                          size="sm"
                          testID={`relay-guide-copy-${command()}`}
                          onPress={() => {
                            void Clipboard.writeText(RELAY_GUIDE_COMMANDS[command()]).catch(() => {});
                            copied.set(command());
                          }}
                        >
                          {copied() === command() ? t().chat.copied : t().remote.relayGuideCopy}
                        </Button>
                      </View>
                    )}
                  </If>
                  <If when={step().note}>
                    <Text class="text-[12px] leading-[1.5] text-ink-muted">{step().note}</Text>
                  </If>
                </View>
              )}
            </Each>
          </View>
          <View class="flex-col items-start gap-[6px]">
            <Button size="sm" testID="relay-guide-full" onPress={() => void openExternalLink(relayGuideUrl(props.locale))}>
              {t().remote.relayGuideFull}
            </Button>
            <Text class="text-[12px] leading-[1.5] text-ink-muted">{t().remote.relayGuideFullNote}</Text>
          </View>
        </View>
      </If>
    </View>
  );
}
