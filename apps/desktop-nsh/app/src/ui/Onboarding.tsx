/**
 * The first-run wizard (`Onboarding.svelte`): language, workspace, how setup reaches a model,
 * the models, and (while the roster is empty) the first Bots. Its state and saves are in
 * `onboarding/wizard.ts`; each step is a file under `onboarding/`, its fields one component and its
 * buttons another (`*Nav`), which the card's footer holds.
 *
 * One card of one size for every step: the welcome and the step bar at its top and the step's
 * buttons at its bottom stay put, and only the step between them changes, scrolling when it is
 * longer than the room. The card was as tall as the step it showed and centred, so the heading
 * and the step bar moved at every step (the welcome was larger on the first) and with every hint
 * that came and went, and the longest steps ran their buttons out of the window.
 *
 * Props: `onDismiss` (the footer's skip link; absent: no link); `holding` and `onHoldingChange`
 * (the Svelte `bind:holding`): the wizard asking to stay up. Saving the endpoint completes setup,
 * which is what takes the wizard down, but its last step, the first Bot, comes after that. Held
 * from the save on while the roster is empty; let go once the Bot is made or the step is skipped.
 * The step pane's slide between steps is not ported (no pane animation primitive).
 */
import { safeArea, Scroll, Text, View, type JSX } from "nsh";
import { titleBar } from "nsh/desktop";
import { copy } from "../runtime";
import { BrandMark } from "./BrandMark";
import { narrowWindow } from "./Modal";
import { HelpTip } from "./settings/HelpTip";
import { shadow } from "./styles";
import { LocaleSwitch } from "./onboarding/LocaleSwitch";
import { ModelsNav, ModelsStep } from "./onboarding/ModelsStep";
import { ProviderNav, ProviderStep } from "./onboarding/ProviderStep";
import { StartNav, StartStep } from "./onboarding/StartStep";
import { StepBar } from "./onboarding/StepBar";
import { WorkspaceNav, WorkspaceStep } from "./onboarding/WorkspaceStep";
import { createWizard, type Wizard } from "./onboarding/wizard";
import { runtime } from "../runtime";

/** The card's height when the window has the room: the endpoint form, the longest step that does not list things, fits. */
const CARD_MAX_HEIGHT = 680;

export function Onboarding(props: { onDismiss?: () => void; holding?: boolean; onHoldingChange?: (holding: boolean) => void }) {
  const w = createWizard({ onHoldingChange: props.onHoldingChange });
  const t = () => copy().onboarding;
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const phone = () => narrowWindow();
  // Setup is still to do. Past the save it is, and the Bot step has a skip of its own.
  const skippable = () => props.onDismiss !== undefined && !w.setupSaved();
  const skip = () => (
    <View role="button" testID="onboarding-skip" accessibilityLabel={t().skip} onPress={() => props.onDismiss?.()} class="cursor-pointer select-none shrink min-w-0 py-1">
      <Text class="text-[12px] text-ink-muted hover:text-ink line-clamp-1">{t().skip}</Text>
    </View>
  );

  return (
    <View class="flex-1 min-h-0">
      {/* The room round the card moves the window, as the messenger's whole shell is a drag region
          behind it (no title bar on Windows and Linux). The card is not. */}
      <View
        testID="onboarding-screen"
        desktop={{ windowDrag: true }}
        class={`flex-1 min-h-0 bg-bg items-center justify-center ${phone() ? "" : "p-10"}`}
      >
        <View
          testID="onboarding-card"
          desktop={{ windowDrag: false }}
          class={`flex-col flex-1 min-h-0 bg-pane overflow-hidden ${phone() ? "w-full" : "w-[620px] max-w-full border border-line rounded-(--radius-xl)"}`}
          style={phone() ? undefined : { maxHeight: CARD_MAX_HEIGHT, boxShadow: shadow("lg") }}
        >
          <View
            testID="onboarding-head"
            class={`shrink-0 flex-col gap-3 ${phone() ? "px-4 pb-3" : "px-8 pt-6 pb-4"}`}
            style={phone() ? { paddingTop: 14 + safeArea().top } : undefined}
          >
            {/* The welcome is one line on every step, the language beside it; what the app is, its "?". */}
            <View class="flex-row items-center gap-[10px] min-h-[30px]">
              <BrandMark size={phone() ? 24 : 28} />
              <Text role="header" class={`shrink min-w-0 font-bold text-ink line-clamp-1 ${phone() ? "text-[15px]" : "text-[17px]"}`}>{t().welcome}</Text>
              <HelpTip text={t().subtitle} label={t().welcome} testID="onboarding-welcome-tip" />
              <View class="flex-1" />
              <LocaleSwitch locale={locale()} />
            </View>
            <StepBar w={w} />
          </View>

          <If when={w.saveFailed()}>
            <View
              testID="onboarding-save-failed"
              role="alert"
              class={`shrink-0 mb-3 px-[14px] py-2 bg-danger-bg border border-danger-line rounded-(--radius-md) ${phone() ? "mx-4" : "mx-8"}`}
            >
              <Text class="text-[13px] font-medium text-danger-text">{copy().settings.saveFailed}</Text>
            </View>
          </If>

          {/* A scroller of its own for each step, so each opens at its top. */}
          <If when={w.step() === 1}>
            <StepBody>
              <WorkspaceStep w={w} locale={locale()} />
            </StepBody>
          </If>
          <If when={w.step() === 2}>
            <StepBody>
              <ProviderStep w={w} />
            </StepBody>
          </If>
          <If when={w.step() === 3}>
            <StepBody>
              <ModelsStep w={w} />
            </StepBody>
          </If>
          <If when={w.step() === 4}>
            <StepBody>
              <StartStep w={w} />
            </StepBody>
          </If>

          {/* The skip link at the start, the step's buttons at the end; on a phone the buttons, then the link under them. */}
          <View
            testID="onboarding-foot"
            class={`shrink-0 border-t border-line-subtle ${phone() ? "flex-col gap-2 px-4 pt-3" : "flex-row items-center gap-3 px-8 py-4"}`}
            style={phone() ? { paddingBottom: 12 + safeArea().bottom } : undefined}
          >
            <If
              when={phone()}
              else={
                <>
                  <View class="flex-1 min-w-0 flex-row items-center">
                    <If when={skippable()}>{skip()}</If>
                  </View>
                  <StepNav w={w} />
                </>
              }
            >
              <StepNav w={w} />
              <If when={skippable()}>
                <View class="items-center">{skip()}</View>
              </If>
            </If>
          </View>
        </View>
      </View>
      {/* The title bar's room, held to move the window: on Windows there is no system title bar, and on a
          phone-narrow window the card fills the room round it. Clear of the caption buttons
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

function StepBody(props: { children?: JSX.Element }) {
  return (
    <Scroll class="flex-1 min-h-0 border-t border-line-subtle" contentClass={`flex-col ${narrowWindow() ? "px-4 py-4" : "px-8 py-5"}`}>
      {props.children}
    </Scroll>
  );
}

/** The shown step's buttons. */
function StepNav(props: { w: Wizard }) {
  const w = props.w;
  return (
    <>
      <If when={w.step() === 1}>
        <WorkspaceNav w={w} />
      </If>
      <If when={w.step() === 2}>
        <ProviderNav w={w} />
      </If>
      <If when={w.step() === 3}>
        <ModelsNav w={w} />
      </If>
      <If when={w.step() === 4}>
        <StartNav w={w} />
      </If>
    </>
  );
}
