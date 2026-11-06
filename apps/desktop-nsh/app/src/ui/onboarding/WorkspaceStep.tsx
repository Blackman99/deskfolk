/** Step 1: the workspace (`Onboarding.svelte`'s first pane), chosen with the folder picker or the default one. */
import { Text, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { WORKSPACE_COPY } from "../../m/copy.ts";
import { WorkspacePicker } from "../settings/WorkspacePicker";
import { fieldCopy, type Wizard } from "./wizard";
import { FieldError } from "../settings/provider-fields";
import { StepFooter, StepHead, StepPrimary } from "./parts";

export function WorkspaceStep(props: { w: Wizard; locale: "zh" | "en" }) {
  const w = props.w;
  const t = () => copy();
  const set = (next: string) => {
    runtime.workspacePath = next;
    w.clearError("workspace");
  };
  return (
    <View testID="onboarding-step-1" class="flex-col gap-[14px]">
      <StepHead title={t().onboarding.stepWorkspace} desc={t().onboarding.workspaceDesc} />
      <View class="flex-col gap-[6px]">
        <Text testID="onboarding-workspace-label" class="text-[13px] font-semibold text-ink-secondary">
          {t().settings.workspace}
        </Text>
        <WorkspacePicker
          id="onboarding-workspace"
          path={runtime.workspacePath}
          chooseLabel={t().settings.workspaceChoose}
          changeLabel={t().settings.workspaceChange}
          emptyLabel={t().settings.workspaceUnsetValue}
          unavailableLabel={t().settings.workspacePickerUnavailable}
          dialogTitle={t().settings.workspaceChoose}
          onChange={set}
        />
        <View
          role="button"
          testID="onboarding-workspace-default"
          accessibilityLabel={t().onboarding.useDefaultWorkspace}
          onPress={() => set("~/deskfolk-workspace")}
          class="self-start"
        >
          <Text class="text-[12px] font-medium text-brand">{t().onboarding.useDefaultWorkspace}</Text>
        </View>
        <View class="mt-3 bg-line-subtle py-3 px-4 rounded-(--radius-sm)">
          <Text class="text-[12px] leading-[1.45] text-ink-muted">{WORKSPACE_COPY[props.locale]}</Text>
        </View>
        <If when={w.fieldErrors().workspace}>
          <FieldError testID="onboarding-workspace-error">
            {fieldCopy(w.fieldErrors().workspace, t().settings.workspaceEmpty, t().settings.workspaceInvalid)}
          </FieldError>
        </If>
      </View>
      <StepFooter>
        <View />
        <StepPrimary testID="onboarding-next-1" label={`${t().onboarding.step1Next} →`} disabled={!w.workspacePlan().ok} onPress={w.advanceFromStep1} />
      </StepFooter>
    </View>
  );
}
