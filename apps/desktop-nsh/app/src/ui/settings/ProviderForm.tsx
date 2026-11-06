/**
 * The endpoint editor's form (`settings/ProviderForm.svelte`), split in three: this file, the
 * connection view of a custom endpoint, and the two parts it draws:
 *
 * - `ConnectorFields.tsx`: a built-in connector's connection (name, key, workspace, plan);
 * - `provider-model-list.tsx`: the models view (enable list, search, manual add);
 * - `provider-model-attrs.tsx`: one model's attributes.
 *
 * `view="connection"` is the name, API format, address and key (or the connector's fields);
 * `view="models"` is the enable list. The draft is the caller's: every change is `onChange(next)`.
 * `fieldPrefix` names the fields' `testID`s: `<prefix>-name`, `-url`, `-key`, `-workspace`.
 *
 * Differences from the Svelte form: it exports `backFromDetails()` to its shell; here the shell
 * owns `detailModel` (with `onDetailModelChange`) and steps back by setting it to null.
 */
import { Text, View } from "nsh";
import { isLocalEndpoint, type ModelSpeed } from "@real-bot/protocol";
import { copy } from "../../runtime";
import type { FieldErrorKind } from "../../m/settings/wizard-save.ts";
import { keyIsWorkspaceId, showsWorkspace, type ProviderDraft, type ProviderFieldErrors } from "../../m/settings/provider-form.ts";
import { ConnectorFields } from "./ConnectorFields";
import { Chip, Field, FieldError, FieldHint, StatusBadge, TextField } from "./provider-fields";
import { ProviderModelList } from "./provider-model-list";
import { WorkspaceField } from "./WorkspaceField";

export function ProviderForm(props: {
  draft: ProviderDraft;
  errors: ProviderFieldErrors;
  failed: boolean;
  fetching: boolean;
  fetchError: string | null;
  fieldPrefix: string;
  /** Set when editing: whether the daemon already holds a key for this endpoint. */
  keySet?: boolean;
  /** `connection` is name, URL and key. `models` is the enable list and its attributes. */
  view?: "connection" | "models";
  detailModel?: string | null;
  onDetailModelChange?: (model: string | null) => void;
  onChange: (draft: ProviderDraft) => void;
  onFetch: () => void;
  /** Times a saved model and checks it calls tools (ADR 0067). Present only while editing a saved endpoint. */
  measure?: (model: string) => Promise<{ ok: true; speed: ModelSpeed } | { ok: false; error: string }>;
}) {
  const t = () => copy().settings;
  const view = () => props.view ?? "connection";
  /** A model server on this computer or network takes no key (ADR 0067). */
  const keyless = () => isLocalEndpoint(props.draft.baseUrl);
  const patch = (partial: Partial<ProviderDraft>) => props.onChange({ ...props.draft, ...partial });
  const fieldCopy = (kind: FieldErrorKind | undefined, empty: string, invalid: string) => (kind === "empty" ? empty : kind === "invalid" ? invalid : "");
  const id = (part: string) => `${props.fieldPrefix}-${part}`;

  const custom = () => (
    <View class="flex-col gap-[14px]">
      <Field label={t().providerName} labelID={id("name-label")}>
        <TextField testID={id("name")} label={t().providerName} placeholder="OpenAI" value={props.draft.name} onInput={(name) => patch({ name })} />
        <If when={props.errors.name}>
          <FieldError testID={id("name-error")}>{t().providerNameEmpty}</FieldError>
        </If>
      </Field>
      <View class="flex-col gap-1">
        <Text testID={id("format-label")} class="mb-[2px] text-[13px] font-semibold text-ink-secondary">
          {t().apiFormat}
        </Text>
        <View role="radiogroup" accessibilityLabel={t().apiFormat} class="flex-row flex-wrap items-center gap-2 min-h-11">
          <Chip testID={id("format-openai")} role="radio" label={t().apiFormatOpenai} active={props.draft.apiFormat === "openai"} onPress={() => patch({ apiFormat: "openai" })} />
          <Chip testID={id("format-anthropic")} role="radio" label={t().apiFormatAnthropic} active={props.draft.apiFormat === "anthropic"} onPress={() => patch({ apiFormat: "anthropic" })} />
        </View>
      </View>
      <Field label={t().endpoint} labelID={id("url-label")}>
        <TextField
          testID={id("url")}
          label={t().endpoint}
          mono
          placeholder={props.draft.apiFormat === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
          value={props.draft.baseUrl}
          onInput={(baseUrl) => patch({ baseUrl })}
        />
        <If
          when={props.errors.endpoint}
          else={<FieldHint testID={id("url-hint")}>{props.draft.apiFormat === "anthropic" ? t().apiFormatAnthropicHint : t().apiFormatOpenaiHint}</FieldHint>}
        >
          <FieldError testID={id("url-error")}>{fieldCopy(props.errors.endpoint, t().endpointEmpty, t().endpointInvalid)}</FieldError>
        </If>
      </Field>
      <Field
        label={t().endpointKey}
        labelID={id("key-label")}
        end={
          <If when={props.keySet !== undefined}>
            <StatusBadge testID={id("key-badge")} on={props.keySet === true || keyless()}>
              {props.keySet ? t().keySet : keyless() ? t().keyNotNeeded : t().keyUnset}
            </StatusBadge>
          </If>
        }
      >
        <TextField
          testID={id("key")}
          label={t().endpointKey}
          masked
          placeholder={props.keySet ? "••••••••" : keyless() ? t().keyLocalPlaceholder : ""}
          value={props.draft.apiKey}
          onInput={(apiKey) => patch({ apiKey })}
        />
        <If
          when={keyIsWorkspaceId(props.draft)}
          else={
            <If
              when={props.errors.endpointKey}
              else={
                <If when={keyless() && !props.keySet}>
                  <FieldHint testID={id("key-hint")}>{t().keyLocalHint}</FieldHint>
                </If>
              }
            >
              <FieldError testID={id("key-error")}>{t().keyEmpty}</FieldError>
            </If>
          }
        >
          <FieldError testID={id("key-error")}>{copy().connectors.keyIsWorkspace}</FieldError>
        </If>
      </Field>
      <If when={showsWorkspace(props.draft)}>
        <WorkspaceField id={id("workspace")} value={props.draft.workspaceId} invalid={props.errors.anthropicWorkspace === "invalid"} onInput={(workspaceId) => patch({ workspaceId })} />
      </If>
    </View>
  );

  return (
    <View class="flex-col gap-[14px]">
      <If when={props.failed}>
        <FieldError testID={id("save-failed")}>{t().saveFailed}</FieldError>
      </If>
      <If
        when={view() === "connection"}
        else={
          <ProviderModelList
            draft={props.draft}
            errors={props.errors}
            fetching={props.fetching}
            fetchError={props.fetchError}
            fieldPrefix={props.fieldPrefix}
            keySet={props.keySet}
            detailModel={props.detailModel ?? null}
            onDetailModelChange={(model) => props.onDetailModelChange?.(model)}
            onChange={props.onChange}
            onFetch={props.onFetch}
            measure={props.measure}
          />
        }
      >
        <If when={props.draft.connector} else={custom()}>
          {(connector: () => NonNullable<ProviderDraft["connector"]>) => (
            <ConnectorFields
              connectorId={connector()}
              draft={props.draft}
              errors={props.errors}
              fieldPrefix={props.fieldPrefix}
              keySet={props.keySet}
              fetching={props.fetching}
              fetchError={props.fetchError}
              patch={patch}
            />
          )}
        </If>
      </If>
    </View>
  );
}
