/**
 * A built-in connector's connection (`settings/ConnectorFields.svelte`, ADR 0072): name, key and,
 * for Anthropic, a workspace. The address is the plan the key was found on; with several plans it
 * can also be picked here. Under them the status line (verifying / detected / waiting for a key)
 * or the fetch error, and the way out to a custom endpoint.
 *
 * Props: `connectorId`; `draft`; `errors`; `fieldPrefix` (the fields' `testID`s are
 * `<prefix>-name`, `-key`, `-workspace`, `-plan`); `keySet` (editing: the daemon holds a key);
 * `fetching`; `fetchError`; `patch(partial)`.
 */
import { Text, View } from "nsh";
import { connectorById, connectorFor, type ConnectorId } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { keyIsWorkspaceId, type ProviderDraft, type ProviderFieldErrors } from "../../m/settings/provider-form.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { Select } from "../Select";
import { ConnectorLogo } from "./ConnectorLogo";
import { Field, FieldError, FieldHint, FetchTip, StatusBadge, TextField } from "./provider-fields";
import { WorkspaceField } from "./WorkspaceField";

export function ConnectorFields(props: {
  connectorId: ConnectorId;
  draft: ProviderDraft;
  errors: ProviderFieldErrors;
  fieldPrefix: string;
  keySet?: boolean;
  fetching: boolean;
  fetchError: string | null;
  patch: (partial: Partial<ProviderDraft>) => void;
}) {
  const t = () => copy();
  const connector = () => connectorById(props.connectorId)!;
  const several = () => connector().plans.length > 1;
  /** The plan the address is on; none until a plan took the key. */
  const plan = () => connectorFor(props.draft.baseUrl, connector().apiFormat)?.plan ?? null;
  const planName = (id: string) => t().connectors.plan[`${props.connectorId}:${id}` as keyof ReturnType<typeof copy>["connectors"]["plan"]] ?? id;

  function pickPlan(id: string): void {
    const picked = connector().plans.find((item) => item.id === id);
    if (picked) props.patch({ baseUrl: picked.baseUrl });
  }

  return (
    <View class="flex-col gap-[14px]">
      <View class="flex-row items-center gap-3 mb-1">
        <ConnectorLogo id={props.connectorId} size={40} />
        <View class="flex-col gap-[3px] min-w-0 shrink">
          <Text class="text-[15px] font-semibold text-ink">{t().connectors.name[props.connectorId]}</Text>
          <Text class="text-[12px] text-ink-muted leading-[1.45]">{t().connectors.blurb[props.connectorId]}</Text>
        </View>
      </View>
      <Field label={t().settings.providerName} labelID={`${props.fieldPrefix}-name-label`}>
        <TextField
          testID={`${props.fieldPrefix}-name`}
          label={t().settings.providerName}
          placeholder={t().connectors.name[props.connectorId]}
          value={props.draft.name}
          onInput={(name) => props.patch({ name })}
        />
        <If when={props.errors.name}>
          <FieldError testID={`${props.fieldPrefix}-name-error`}>{t().settings.providerNameEmpty}</FieldError>
        </If>
      </Field>
      <Field
        label={t().settings.endpointKey}
        labelID={`${props.fieldPrefix}-key-label`}
        end={
          <If when={props.keySet !== undefined}>
            <StatusBadge testID={`${props.fieldPrefix}-key-badge`} on={props.keySet === true}>
              {props.keySet ? t().settings.keySet : t().settings.keyUnset}
            </StatusBadge>
          </If>
        }
      >
        <TextField
          testID={`${props.fieldPrefix}-key`}
          label={t().settings.endpointKey}
          masked
          placeholder={props.keySet ? "••••••••" : t().connectors.keyPlaceholder[props.connectorId]}
          value={props.draft.apiKey}
          onInput={(apiKey) => props.patch({ apiKey })}
        />
        <If
          when={keyIsWorkspaceId(props.draft)}
          else={
            <If when={props.errors.endpointKey}>
              <FieldError testID={`${props.fieldPrefix}-key-error`}>{t().settings.keyEmpty}</FieldError>
            </If>
          }
        >
          <FieldError testID={`${props.fieldPrefix}-key-error`}>{t().connectors.keyIsWorkspace}</FieldError>
        </If>
      </Field>
      <If when={connector().workspace}>
        <WorkspaceField
          id={`${props.fieldPrefix}-workspace`}
          value={props.draft.workspaceId}
          invalid={props.errors.anthropicWorkspace === "invalid"}
          onInput={(workspaceId) => props.patch({ workspaceId })}
        />
      </If>
      <If when={several()}>
        <Field label={t().connectors.planLabel} labelID={`${props.fieldPrefix}-plan-label`}>
          <Select
            testID={`${props.fieldPrefix}-plan`}
            ariaLabel={t().connectors.planLabel}
            value={plan()?.id ?? ""}
            placeholder="—"
            options={connector().plans.map((item) => ({ value: item.id, label: planName(item.id) }))}
            onChange={pickPlan}
          />
          <FieldHint>{t().connectors.planHint}</FieldHint>
        </Field>
      </If>
      <View testID={`${props.fieldPrefix}-status`} class="min-h-5 mt-[2px]">
        <If
          when={props.fetching}
          else={
            <If
              when={props.fetchError}
              else={
                <If
                  when={plan() && props.draft.availableModels.length > 0}
                  else={
                    <If when={!props.keySet && props.draft.apiKey.trim().length === 0}>
                      <Text class="text-[12px] leading-[1.5] text-ink-muted">
                        {several() ? t().connectors.waitingKey : t().connectors.waitingKeySingle}
                      </Text>
                    </If>
                  }
                >
                  <View class="flex-row items-center gap-[6px]">
                    <Icon name="check" size={12} class="tint-ok-text" />
                    <Text class="text-[12px] font-medium leading-[1.5] text-ok-text">
                      {several()
                        ? t().connectors.detected(planName(plan()!.id), props.draft.availableModels.length)
                        : t().connectors.verified(props.draft.availableModels.length)}
                    </Text>
                  </View>
                </If>
              }
            >
              <FetchTip testID={`${props.fieldPrefix}-fetch-error`}>{props.fetchError ?? ""}</FetchTip>
            </If>
          }
        >
          <View class="flex-row items-center gap-[6px]">
            <Icon name="spinner" size={12} class="animate-spin tint-brand" />
            <Text class="text-[12px] leading-[1.5] text-ink-muted">{several() ? t().connectors.detecting : t().connectors.verifying}</Text>
          </View>
        </If>
      </View>
      <View
        role="button"
        testID={`${props.fieldPrefix}-use-custom`}
        accessibilityLabel={t().connectors.useCustom}
        onPress={() => props.patch({ connector: null, baseUrl: props.draft.baseUrl || connector().plans[0]!.baseUrl })}
        class={`cursor-pointer select-none self-start justify-center ${narrowWindow() ? "min-h-11" : ""}`}
      >
        <Text class={`${narrowWindow() ? "text-[14px]" : "text-[12px]"} text-ink-muted underline hover:text-brand`}>{t().connectors.useCustom}</Text>
      </View>
    </View>
  );
}
