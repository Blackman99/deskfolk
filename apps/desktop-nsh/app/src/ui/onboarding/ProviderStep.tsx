/** Step 2: how setup reaches a model (ADR 0078): an endpoint, with a preset to start from, or the agent on this computer. */
import { Text, View } from "nsh";
import { connectorById, connectorFor } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { runtime } from "../../runtime";
import { ConnectorLogo } from "../settings/AgentLogo";
import { WorkspaceField } from "../settings/WorkspaceField";
import { Chip, FetchTip, Field, FieldError, FieldHint, TextAction, TextField } from "../settings/provider-fields";
import { AgentStep } from "./AgentStep";
import { ModeCards, StepFooter, StepHead, StepPrimary, StepSecondary } from "./parts";
import { fieldCopy, type Wizard } from "./wizard";
import { LOCAL_PRESETS, PRESETS } from "./presets";

export function ProviderStep(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  const claude = () => w.connectMode() === "claude";
  return (
    <View testID="onboarding-step-2" class="flex-col gap-[14px]">
      <StepHead title={t().onboarding.stepProvider} />
      <If when={w.workspaceReadOnly()}>
        <FieldHint>{t().settings.workspaceHostOnly}</FieldHint>
      </If>
      <ModeCards
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

      <StepFooter>
        <If when={w.workspaceReadOnly()} else={<StepSecondary testID="onboarding-back-2" label={`← ${t().onboarding.prevStep}`} onPress={() => w.step.set(1)} />}>
          <View />
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
    </View>
  );
}

function EndpointForm(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  const errors = () => w.fieldErrors();
  return (
    <View class="flex-col gap-[14px]">
      <Text class="text-[13px] leading-[1.45] text-ink-muted">{t().onboarding.providerDesc}</Text>

      <View class="flex-row flex-wrap gap-3">
        <Each of={PRESETS.slice()} key={(preset) => preset.id}>
          {(preset) => {
            const connector = () => connectorById(preset().id as never);
            const label = () => (connector() ? t().connectors.name[connector()!.id] : preset().id === "custom" ? t().onboarding.presetCustom : preset().name);
            const active = () => w.activePreset() === preset().id;
            return (
              <View
                role="button"
                testID={`preset-${preset().id}`}
                accessibilityLabel={label()}
                accessibilityState={{ selected: active() }}
                onPress={() => w.applyPreset(preset())}
                class={`flex-row items-center gap-[6px] py-[5px] rounded-full border ${connector() ? "pl-[6px] pr-3" : "px-3"} ${
                  active() ? "bg-brand border-brand" : "bg-chip border-chip-line hover:bg-pane hover:border-line-hover"
                }`}
              >
                <If when={connector()}>
                  <ConnectorLogo id={connector()!.id} size={16} />
                </If>
                <Text class={`text-[12px] ${active() ? "font-semibold text-on-accent" : "font-medium text-ink-secondary"}`}>{label()}</Text>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={LOCAL_PRESETS.has(w.activePreset())}>
        <FieldHint>{t().onboarding.localPresetHint}</FieldHint>
      </If>

      <Field label={t().settings.apiFormat} labelID="onboarding-format-label">
        <View role="radiogroup" accessibilityLabel={t().settings.apiFormat} class="flex-row flex-wrap items-center gap-2 min-h-11">
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

      <Field label={t().settings.endpoint}>
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
        <If when={errors().endpoint} else={<If when={w.apiFormat() === "anthropic"}><FieldHint>{t().settings.apiFormatAnthropicHint}</FieldHint></If>}>
          <FieldError testID="onboarding-endpoint-error">{fieldCopy(errors().endpoint, t().settings.endpointEmpty, t().settings.endpointInvalid)}</FieldError>
        </If>
      </Field>

      <Field
        label={t().settings.endpointKey}
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
        <If when={errors().endpointKey} else={<If when={w.keyless()}><FieldHint>{t().settings.keyLocalHint}</FieldHint></If>}>
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
