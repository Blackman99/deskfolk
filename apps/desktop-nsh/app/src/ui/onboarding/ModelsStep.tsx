/**
 * Step 3: the models. On an endpoint, tick the ones to offer (what it listed, what a preset knows,
 * what you add) and pick the default; on Claude Code or another agent, the one model every
 * built-in call runs on.
 */
import { Scroll, Text, View } from "nsh";
import { Input } from "nsh/base";
import { copy, runtime } from "../../runtime";
import { Select } from "../Select";
import { ModelPicker } from "../ModelPicker";
import { Chip, Field, FieldError, FieldHint, TextAction, TextField, XsButton, fieldClass } from "../settings/provider-fields";
import { Desc, StepFooter, StepHead, StepPrimary, StepSecondary } from "./parts";
import { fieldCopy, type Wizard } from "./wizard";

export function ModelsStep(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  const other = () => w.pickedOther();
  const claude = () => w.connectMode() === "claude";
  const desc = () =>
    claude() ? (other() ? t().onboarding.agentModelsDesc.replace("{agent}", w.pickedLabel()) : t().onboarding.claudeModelsDesc) : t().onboarding.stepModelsDesc;
  return (
    <View testID="onboarding-step-3" class="flex-col gap-[14px]">
      <StepHead title={t().onboarding.step3Title} desc={desc()} />

      <If when={claude()} else={<EndpointModels w={w} />}>
        <If
          when={other()}
          else={
            <>
              <Field label={t().onboarding.claudeModel}>
                <ModelPicker
                  testID="onboarding-claude-model"
                  value={w.claudeModel()}
                  data={w.claudeModelData()}
                  title={t().onboarding.claudeModel}
                  onChange={(value) => w.claudeModel.set(value)}
                />
              </Field>
              <If when={w.claudeAccounts().length > 1}>
                <Field label={t().onboarding.claudeAccount}>
                  <Select testID="onboarding-claude-account" value={w.claudeConfigDir()} options={w.claudeAccounts()} onChange={(value) => w.claudeConfigDir.set(value)} />
                </Field>
              </If>
              <Desc>{t().onboarding.claudeLimits}</Desc>
            </>
          }
        >
          <Field label={t().onboarding.claudeModel}>
            <ModelPicker
              testID="onboarding-agent-model"
              value={w.agentModel()}
              data={w.agentModelData()}
              title={t().onboarding.claudeModel}
              placeholder={t().onboarding.agentModelPlaceholder}
              onChange={(value) => w.agentModel.set(value)}
            />
          </Field>
          <Desc>{t().onboarding.agentLimits.replace("{agent}", w.pickedLabel())}</Desc>
        </If>
      </If>

      <StepFooter>
        <StepSecondary testID="onboarding-back-3" label={`← ${t().onboarding.prevStep}`} onPress={() => w.step.set(2)} />
        <StepPrimary
          testID="onboarding-next-3"
          disabled={!w.canCompleteSetup()}
          label={w.rosterEmpty() ? `${w.carryOffered() ? t().onboarding.step3NextStart : t().onboarding.step3Next} →` : `${t().onboarding.submit} ✓`}
          onPress={() => void w.handleComplete()}
        />
      </StepFooter>
    </View>
  );
}

function EndpointModels(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  const errors = () => w.fieldErrors();
  return (
    <View class="flex-col gap-[14px]">
      <Field
        label={t().settings.modelsSelectTitle}
        end={
          <TextAction
            testID="models-manual-toggle"
            label={w.showManualModelEdit() ? t().settings.modelsListToggle : t().settings.modelsManualToggle}
            onPress={() => w.showManualModelEdit.set(!w.showManualModelEdit())}
          />
        }
      >
        <If
          when={w.showManualModelEdit()}
          else={
            <View class="flex-col gap-2 p-[10px] bg-chip border border-chip-line rounded-(--radius-md)">
              <If when={w.allKnownModels().length > 4}>
                <View class="flex-row items-center gap-3">
                  <Input
                    testID="models-filter"
                    accessibilityLabel={t().settings.modelsSearchPlaceholder}
                    value={w.modelFilterQuery()}
                    placeholder={t().settings.modelsSearchPlaceholder}
                    onChange={(e) => w.modelFilterQuery.set(e.value)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    class="flex-1 min-w-0 text-ink bg-input-bg border border-line rounded-(--radius-sm) px-2 py-1 text-[12px] focus:border-field-focus-border"
                  />
                  <XsButton testID="models-select-all" label={t().settings.modelsSelectAll} onPress={w.selectAllModels} />
                  <XsButton testID="models-deselect-all" label={t().settings.modelsDeselectAll} onPress={w.deselectAllModels} />
                </View>
              </If>
              <Scroll class="max-h-[140px]">
                <View class="flex-row flex-wrap gap-3 p-1">
                  <Each of={w.filteredModels()} key={(model) => model}>
                    {(model) => {
                      const on = () => w.selectedModels().includes(model());
                      return (
                        <View
                          role="checkbox"
                          testID={`model-chip-${model()}`}
                          accessibilityLabel={model()}
                          accessibilityState={{ checked: on() }}
                          onPress={() => w.toggleModelSelection(model())}
                          class={`cursor-pointer select-none flex-row items-center gap-[5px] px-[10px] py-1 rounded-(--radius-sm) border ${on() ? "bg-accent-tint border-brand" : "bg-btn-secondary-bg border-line hover:border-line-hover"}`}
                        >
                          <Text class="text-[11px] font-bold min-w-[20px] text-brand">{on() ? "✓" : ""}</Text>
                          <Text class={`font-mono text-[12px] ${on() ? "font-semibold text-brand" : "text-ink-secondary"}`}>{model()}</Text>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </Scroll>
              <View class="flex-row items-center gap-[6px] mt-[2px] pt-[6px] border-t border-line">
                <Input
                  testID="custom-model-input"
                  accessibilityLabel={t().settings.modelsAddCustom}
                  value={w.customModelInput()}
                  placeholder={t().settings.modelsAddCustom}
                  onChange={(e) => w.customModelInput.set(e.value)}
                  onSubmit={w.addCustomModel}
                  autoCapitalize="none"
                  autoCorrect={false}
                  class="flex-1 min-w-0 text-ink bg-input-bg border border-line rounded-(--radius-sm) px-2 py-1 text-[12px] font-mono focus:border-field-focus-border"
                />
                <XsButton testID="custom-model-add" label="+" onPress={w.addCustomModel} />
              </View>
            </View>
          }
        >
          <Input
            testID="endpoint-models"
            accessibilityLabel={t().settings.modelsSelectTitle}
            value={runtime.endpointModelsText}
            placeholder="gpt-4o"
            multiline
            submitBehavior="newline"
            autoCapitalize="none"
            autoCorrect={false}
            onChange={(e) => {
              runtime.endpointModelsText = e.value;
              w.clearResolvedModelErrors();
            }}
            class={`${fieldClass(true)} min-h-[72px]`}
          />
        </If>
        <If when={errors().models}>
          <FieldError testID="onboarding-models-error">{t().settings.modelsEmpty}</FieldError>
        </If>
      </Field>

      <Field label={t().settings.defaultModel}>
        <ModelPicker
          testID="onboarding-default-model"
          value={runtime.endpointDefaultModel}
          data={w.defaultModelData()}
          title={t().settings.defaultModel}
          placeholder={t().settings.defaultModelEmpty}
          error={!!errors().defaultModel}
          onChange={(value) => {
            runtime.endpointDefaultModel = value;
            w.clearError("defaultModel");
          }}
        />
        <If when={errors().defaultModel}>
          <FieldError testID="onboarding-default-model-error">
            {fieldCopy(errors().defaultModel, t().settings.defaultModelEmpty, t().settings.defaultModelInvalid)}
          </FieldError>
        </If>
      </Field>
    </View>
  );
}
