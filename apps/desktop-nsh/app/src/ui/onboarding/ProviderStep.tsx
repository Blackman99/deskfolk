/** Step 2: how setup reaches a model (ADR 0078): an endpoint, with a preset to start from, or the agent on this computer. */
import { Text, View } from "nsh";
import { connectorById, connectorFor } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { runtime } from "../../runtime";
import { narrowWindow } from "../Modal";
import { ConnectorLogo } from "../settings/AgentLogo";
import { HelpTip } from "../settings/HelpTip";
import { WorkspaceField } from "../settings/WorkspaceField";
import { Chip, FetchTip, Field, FieldError, FieldHint, TextAction, TextField } from "../settings/provider-fields";
import { AgentStep } from "./AgentStep";
import { StepFooter, StepHead, StepPrimary, StepSecondary, WaySwitch } from "./parts";
import { fieldCopy, type Wizard } from "./wizard";
import { LOCAL_PRESETS, PRESETS, type Preset } from "./presets";

export function ProviderStep(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  const claude = () => w.connectMode() === "claude";
  // The heading's "?" says what the chosen way asks: an endpoint, or an agent found here and signed in.
  const desc = () =>
    claude()
      ? w.pickedOther() && w.pickedStatus()
        ? t().onboarding.agentCheckDesc.replace("{agent}", w.pickedLabel())
        : t().onboarding.claudeCheckDesc
      : t().onboarding.providerDesc;
  return (
    <View testID="onboarding-step-2" class="flex-col gap-[14px]">
      <StepHead title={t().onboarding.stepProvider} desc={desc()} tipTestID="onboarding-tip-2" />
      <If when={w.workspaceReadOnly()}>
        <FieldHint>{t().settings.workspaceHostOnly}</FieldHint>
      </If>
      <WaySwitch
        label={t().onboarding.step2Title}
        value={w.connectMode()}
        idPrefix="connect-mode"
        options={[
          ["endpoint", t().onboarding.connectEndpoint, t().onboarding.connectEndpointDesc],
          ["claude", t().onboarding.connectClaude, t().onboarding.connectClaudeDesc],
        ]}
        onPick={(mode) => w.connectMode.set(mode)}
      />

      <If when={claude()} else={<EndpointForm w={w} />}>
        <AgentStep w={w} />
      </If>
    </View>
  );
}

/** Step 2's buttons, in the card's footer. */
export function ProviderNav(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  const claude = () => w.connectMode() === "claude";
  return (
    <StepFooter>
      <If when={!w.workspaceReadOnly()}>
        <StepSecondary testID="onboarding-back-2" label={`← ${t().onboarding.prevStep}`} onPress={() => w.step.set(1)} />
      </If>
      <StepPrimary
        testID="onboarding-next-2"
        disabled={claude() ? !w.claudeOk() : !w.connectionPlan().ok}
        label={`${
          claude()
            ? w.pickedOther()
              ? t().onboarding.step2NextAgent.replace("{agent}", w.pickedLabel())
              : t().onboarding.step2NextClaude
            : t().onboarding.step2Next
        } →`}
        onPress={w.advanceFromStep2}
      />
    </StepFooter>
  );
}

/** A preset as its chip reads: a built-in connector's name in this language, else the preset's own. */
function presetLabel(preset: Preset): string {
  const t = copy();
  const connector = connectorById(preset.id as never);
  return connector ? t.connectors.name[connector.id] : preset.id === "custom" ? t.onboarding.presetCustom : preset.name;
}

function EndpointForm(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  const errors = () => w.fieldErrors();
  const phone = () => narrowWindow();
  const localPreset = () => PRESETS.find((preset) => preset.id === w.activePreset() && LOCAL_PRESETS.has(preset.id));
  return (
    <View class="flex-col gap-[14px]">
      {/* What a model server on this computer needs is the "?" at the end of the presets, there while one is picked. */}
      <View class="flex-row flex-wrap items-center gap-2">
        <Each of={PRESETS.slice()} key={(preset) => preset.id}>
          {(preset) => {
            const connector = () => connectorById(preset().id as never);
            const active = () => w.activePreset() === preset().id;
            return (
              <View
                role="button"
                testID={`preset-${preset().id}`}
                accessibilityLabel={presetLabel(preset())}
                accessibilityState={{ selected: active() }}
                onPress={() => w.applyPreset(preset())}
                class={`cursor-pointer select-none flex-row items-center gap-[6px] py-[5px] rounded-full border ${connector() ? "pl-[6px] pr-3" : "px-3"} ${
                  active() ? "bg-brand border-brand" : "bg-chip border-chip-line hover:bg-pane hover:border-line-hover"
                }`}
              >
                <If when={connector()}>
                  <ConnectorLogo id={connector()!.id} size={16} />
                </If>
                <Text class={`text-[12px] ${active() ? "font-semibold text-on-accent" : "font-medium text-ink-secondary"}`}>{presetLabel(preset())}</Text>
              </View>
            );
          }}
        </Each>
        <If when={localPreset()}>
          {(preset) => <HelpTip text={t().onboarding.localPresetHint} label={presetLabel(preset())} testID="onboarding-local-tip" />}
        </If>
      </View>

      {/* The name and the format side by side: one row less, and the form fits the card. */}
      <View class={phone() ? "flex-col gap-[14px]" : "flex-row items-start gap-4"}>
        <View class={phone() ? "flex-col" : "flex-col flex-1 min-w-0"}>
          <Field label={t().settings.providerName}>
            <TextField
              testID="onboarding-provider-name"
              label={t().settings.providerName}
              value={w.providerName()}
              onInput={(value) => {
                w.providerName.set(value);
                w.clearError("name");
              }}
            />
            <If when={errors().name}>
              <FieldError testID="onboarding-name-error">{t().settings.providerNameEmpty}</FieldError>
            </If>
          </Field>
        </View>
        <Field label={t().settings.apiFormat} labelID="onboarding-format-label">
          <View role="radiogroup" accessibilityLabel={t().settings.apiFormat} class={`flex-row flex-wrap items-center gap-2 ${phone() ? "min-h-11" : "min-h-[38px]"}`}>
            <Each
              of={[["openai", t().settings.apiFormatOpenai], ["anthropic", t().settings.apiFormatAnthropic]] as const}
              key={(format) => format[0]}
            >
              {(format) => (
                <Chip
                  role="radio"
                  testID={`format-${format()[0]}`}
                  label={format()[1]}
                  active={w.apiFormat() === format()[0]}
                  onPress={() => {
                    w.apiFormat.set(format()[0]);
                    w.onEndpointOrKeyInput();
                  }}
                />
              )}
            </Each>
          </View>
        </Field>
      </View>

      <Field
        label={t().settings.endpoint}
        tip={w.apiFormat() === "anthropic" ? t().settings.apiFormatAnthropicHint : undefined}
        tipTestID="onboarding-endpoint-tip"
      >
        <TextField
          testID="onboarding-endpoint"
          label={t().settings.endpoint}
          value={runtime.endpointUrl}
          placeholder={w.apiFormat() === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
          onInput={(value) => {
            runtime.endpointUrl = value;
            w.onEndpointOrKeyInput();
          }}
        />
        <If when={errors().endpoint}>
          <FieldError testID="onboarding-endpoint-error">{fieldCopy(errors().endpoint, t().settings.endpointEmpty, t().settings.endpointInvalid)}</FieldError>
        </If>
      </Field>

      <Field
        label={t().settings.endpointKey}
        tip={w.keyless() ? t().settings.keyLocalHint : undefined}
        tipTestID="onboarding-key-tip"
        end={
          <TextAction
            testID="onboarding-fetch-models"
            disabled={w.fetchingModels()}
            label={w.fetchingModels() ? t().settings.modelsFetching : `🔄 ${t().settings.modelsFetch}`}
            onPress={() => void w.fetchModels()}
          />
        }
      >
        <TextField
          testID="onboarding-endpoint-key"
          label={t().settings.endpointKey}
          masked
          value={runtime.endpointKey}
          placeholder={w.keyless() ? t().settings.keyLocalPlaceholder : t().settings.keyEmpty}
          onInput={(value) => {
            runtime.endpointKey = value;
            w.onEndpointOrKeyInput();
          }}
        />
        <If when={errors().endpointKey}>
          <FieldError testID="onboarding-key-error">{t().settings.keyEmpty}</FieldError>
        </If>
      </Field>

      <If when={connectorFor(runtime.endpointUrl, w.apiFormat())?.connector.workspace}>
        <WorkspaceField
          id="onboarding-anthropic-workspace"
          value={w.anthropicWorkspace()}
          invalid={errors().anthropicWorkspace === "invalid"}
          onInput={(value) => {
            w.anthropicWorkspace.set(value);
            w.clearError("anthropicWorkspace");
            w.onEndpointOrKeyInput();
          }}
        />
      </If>

      <If when={w.fetchError()}>
        <FetchTip testID="onboarding-fetch-error">{w.fetchError()!}</FetchTip>
      </If>
    </View>
  );
}
