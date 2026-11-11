/**
 * Settings › Models in two sections: the endpoints and the speech recognition behind the message
 * box's microphone (ADR 0073; `settings/ModelsTab.svelte`). The models of the calls the app makes on
 * its own, with their prompts, and the model ladder (ADR 0054) are on Settings › Roles (ADR 0082). A
 * wide window shows the sections as tabs over one page. A phone lists them with what each is set to
 * and opens one as a page of its own, one level deeper.
 *
 * Props: `endpoints` (the endpoint list, wired by the dialog to its editor); `notices` (what the dialog
 * says over any page: pending credentials, a failed save, setup not done); `state` (from
 * `createModelsState`, so the dialog can read the open section's title and go Back; the tab makes its
 * own when it is not given one). Test ids: `models-tab-<section>` (the tabs), `section-<section>` (the
 * phone's list), `models-panel`, `models-intro`.
 */
import { Scroll, Text, View, type JSX, type ScrollRef } from "nsh";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { MODELS_SECTIONS, createModelsState, modelsPhone, type ModelsSection, type ModelsState } from "./models-tab";
import { SettingsSectionList } from "./SettingsSectionList";
import { SettingsSectionTabs } from "./SettingsSectionTabs";
import { SpeechCard, speechMissing } from "./SpeechCard";

export type { ModelsSection };

export function ModelsTab(props: { endpoints: JSX.Element; notices?: JSX.Element; state?: ModelsState }) {
  const snapshot = () => runtime.snapshot;
  const providers = () => snapshot().providers;
  const label = (of: ModelsSection) => (of === "endpoints" ? copy().settings.modelsSectionEndpoints : copy().speech.title);
  const state = props.state ?? createModelsState(label);
  let scroller: ScrollRef | null = null;

  const defaultProvider = () => providers().find((provider) => provider.id === snapshot().settings.default_provider_id) ?? null;

  /** What a section is set to, under its name on the phone's list. */
  function summary(of: ModelsSection): string {
    const t = copy();
    if (of === "endpoints") {
      return providers().length === 0 ? t.settings.providerEmpty : t.settings.modelsEndpointsSummary(providers().length, defaultProvider()?.name ?? null);
    }
    const speech = snapshot().settings.speech ?? null;
    if (!speech) return t.speech.unset;
    if (!speech.enabled) return t.speech.offShort;
    return speechMissing(speech, t.speech) ?? [t.speech.presets[speech.preset], speech.model].filter(Boolean).join(" · ");
  }

  const count = (of: ModelsSection) => (of === "endpoints" ? providers().length : 0);

  function open(next: ModelsSection): void {
    state.open(next);
    scroller?.scrollTo({ y: 0, animated: false });
  }

  const icon = (of: ModelsSection, size: number, active = false) => (
    <Icon name={of === "endpoints" ? "plug" : "mic"} size={size >= 18 ? 20 : 16} class={active ? "tint-brand" : "tint-ink-muted"} />
  );
  const tabs = () => !modelsPhone() && MODELS_SECTIONS.length > 1;

  return (
    <View testID="settings-models" class="flex-1 min-h-0 flex-col">
      <If when={tabs()}>
        <SettingsSectionTabs id="models" sections={MODELS_SECTIONS} active={state.section()} label={label} count={count} icon={icon} ariaLabel={copy().settings.tabModels} onPick={open} />
      </If>

      <Scroll ref={(node) => (scroller = node)} class="flex-1 min-h-0">
        <View class={`flex-col ${modelsPhone() ? "gap-4 px-4 pt-5 pb-7" : "gap-[14px] px-6 py-5"}`}>
          {props.notices}
          <If
            when={state.listing()}
            else={
              <View testID="models-panel" accessibilityLabel={label(state.section())} class={`flex-col min-w-0 ${modelsPhone() && MODELS_SECTIONS.length > 1 ? "gap-4" : "gap-[14px]"}`}>
                <If
                  when={state.section() === "endpoints"}
                  else={
                    <>
                      <Text testID="models-intro" class={`leading-[1.6] text-ink-muted ${modelsPhone() ? "text-[14px]" : "text-[13px]"}`}>
                        {copy().speech.hint}
                      </Text>
                      <SpeechCard speech={snapshot().settings.speech ?? null} providers={providers()} patch={(patch) => runtime.patchSpeech(patch)} />
                    </>
                  }
                >
                  {props.endpoints}
                </If>
              </View>
            }
          >
            <SettingsSectionList
              sections={MODELS_SECTIONS}
              label={label}
              summary={summary}
              icon={(of, size) => icon(of, size)}
              ariaLabel={copy().settings.tabModels}
              onPick={open}
            />
          </If>
        </View>
      </Scroll>
    </View>
  );
}
