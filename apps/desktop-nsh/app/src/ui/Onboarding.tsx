/**
 * The first-run wizard (`Onboarding.svelte`): language, workspace, how setup reaches a model,
 * the models, and (while the roster is empty) the first Bots. Its state and saves are in
 * `onboarding/wizard.ts`; each step is a file under `onboarding/`.
 *
 * Props: `onDismiss` (the footer's skip link; absent: no link); `holding` and `onHoldingChange`
 * (the Svelte `bind:holding`): the wizard asking to stay up. Saving the endpoint completes setup,
 * which is what takes the wizard down, but its last step, the first Bot, comes after that. Held
 * from the save on while the roster is empty; let go once the Bot is made or the step is skipped.
 * The step pane's slide between steps is not ported (no pane animation primitive).
 */
import { safeArea, Scroll, Text, View } from "nsh";
import { titleBar } from "nsh/desktop";
import { copy } from "../runtime";
import { BrandMark } from "./BrandMark";
import { narrowWindow } from "./Modal";
import { shadow } from "./styles";
import { LocaleSwitch } from "./onboarding/LocaleSwitch";
import { ModelsStep } from "./onboarding/ModelsStep";
import { ProviderStep } from "./onboarding/ProviderStep";
import { StartStep } from "./onboarding/StartStep";
import { StepBar } from "./onboarding/StepBar";
import { WorkspaceStep } from "./onboarding/WorkspaceStep";
import { createWizard } from "./onboarding/wizard";
import { runtime } from "../runtime";

export function Onboarding(props: { onDismiss?: () => void; holding?: boolean; onHoldingChange?: (holding: boolean) => void }) {
  const w = createWizard({ onHoldingChange: props.onHoldingChange });
  const t = () => copy().onboarding;
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const phone = () => narrowWindow();

  return (
    <View class="flex-1 min-h-0">
    <Scroll testID="onboarding-screen" class="flex-1 min-h-0 bg-bg" contentClass={`grow justify-center items-center ${phone() ? "" : "p-10"}`}>
      <View
        testID="onboarding-card"
        class={`flex-col gap-4 bg-pane ${phone() ? "w-full grow px-4 py-5" : "w-[620px] max-w-full px-8 py-7 border border-line rounded-(--radius-xl)"}`}
        style={{ ...(phone() ? { paddingTop: 20 + safeArea().top, paddingBottom: 20 + safeArea().bottom } : { boxShadow: shadow("lg") }) }}
      >
        <LocaleSwitch locale={locale()} />
        {/* The welcome is said once, on the first step; past it the heading shrinks to one line and
            the room goes to the step itself. */}
        <If
          when={w.step() === 1}
          else={
            // On a phone the language switch shares this band at the right: start at the left, clear of it.
            <View class={`flex-row items-center gap-[10px] min-h-[30px] ${phone() ? "justify-start pr-[110px]" : "justify-center"}`}>
              <BrandMark size={26} />
              <Text role="header" class="text-[16px] font-bold text-ink">{t().welcome}</Text>
            </View>
          }
        >
          <View class="items-center gap-3">
            <BrandMark size={52} />
            <Text role="header" class="text-[24px] font-bold text-ink text-center">{t().welcome}</Text>
            <Text class="text-[13px] text-ink-muted text-center max-w-[480px] leading-[1.45]">{t().subtitle}</Text>
          </View>
        </If>

        <StepBar w={w} />

        <If when={w.saveFailed()}>
          <View testID="onboarding-save-failed" role="alert" class="px-[14px] py-2 bg-danger-bg border border-danger-line rounded-(--radius-md)">
            <Text class="text-[13px] font-medium text-danger-text">{copy().settings.saveFailed}</Text>
          </View>
        </If>

        <View class="flex-col pt-[18px] border-t border-line-subtle">
          <If when={w.step() === 1}>
            <WorkspaceStep w={w} locale={locale()} />
          </If>
          <If when={w.step() === 2}>
            <ProviderStep w={w} />
          </If>
          <If when={w.step() === 3}>
            <ModelsStep w={w} />
          </If>
          <If when={w.step() === 4}>
            <StartStep w={w} />
          </If>
        </View>

        {/* Skip footer link: setup is still to do. Past the save it is, and the Bot step skips itself. */}
        <If when={props.onDismiss && !w.setupSaved()}>
          <View class="items-center mt-2">
            <View role="button" testID="onboarding-skip" accessibilityLabel={t().skip} onPress={() => props.onDismiss?.()} class="cursor-pointer select-none px-2 py-1">
              <Text class="text-[13px] text-ink-muted hover:text-ink">{t().skip}</Text>
            </View>
          </View>
        </If>
      </View>
    </Scroll>
    {/* The title bar's room, held to move the window: on Windows there is no system title bar and a
        mark on the Scroll is lost under its native scroller. Clear of the caption buttons
        (`titleBar().right`); 0 tall on macOS, whose transparent title bar AppKit drags by itself. */}
    <View
      testID="onboarding-drag"
      desktop={{ windowDrag: true }}
      class="absolute top-0 left-0"
      style={{ right: titleBar().right, height: titleBar().height }}
    />
    </View>
  );
}
