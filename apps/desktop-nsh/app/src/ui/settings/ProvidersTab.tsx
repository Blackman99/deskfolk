/**
 * The model providers page (`settings/ProvidersTab.svelte`): the hint and the "add" button, then one
 * card per endpoint: its mark (a connector's logo or the first letter), name, plan and badges
 * (default, no key); "set as default", "connection" and delete; and its default model with the way
 * into its model list. On a desktop a card is one line; on a phone (680 or less) it stacks, the
 * actions as a row of cells and the model rail under them.
 *
 * Reads `runtime.snapshot` itself. Props are the shell's actions, as in the Svelte tab:
 * `providerSaving`; `openAddProvider`; `openEditProvider(id)`; `openProviderModels(id)`;
 * `openDeleteProviderConfirm(id)`; `setDefaultProvider(id)`; `setProviderDefaultModel(id, model)`.
 * Test ids: `provider-add`, `provider-card-<id>`, `provider-default-<id>` (set default),
 * `provider-edit-<id>`, `provider-delete-<id>`, `provider-models-<id>`, `default-model-<id>`.
 */
import { Text, View } from "nsh";
import { connectorFor, isLocalEndpoint } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { botAvatarColor } from "../../m/avatar.ts";
import { endpointPickerSources } from "../../m/model-picker-sources.ts";
import { rosterLetter } from "../../m/sidebar/roster-letter.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { ModelPicker } from "../ModelPicker";
import { cssColor, shadow } from "../styles";
import { tip } from "../tip";
import { ConnectorLogo } from "./ConnectorLogo";

type Row = (typeof runtime.snapshot.providers)[number];

/** A key is in place, or none is needed: a model server on this computer or network (ADR 0067). Only a missing key gets a badge. */
function keyReady(provider: { key_set: boolean; base_url: string | null }): boolean {
  return provider.key_set || isLocalEndpoint(provider.base_url);
}

function Action(props: { testID: string; label: string; hover?: string; icon: "star" | "link" | "trash"; text: boolean; danger?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={tip(props.hover ?? props.label)}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none group flex-row items-center justify-center gap-1 rounded-(--radius-sm) ${
        narrowWindow()
          ? `${props.danger ? "w-[52px]" : "flex-1"} min-h-12 p-2 gap-[6px]`
          : props.danger
            ? "px-[6px] py-1 border border-transparent hover:bg-danger-bg hover:border-danger-line"
            : `${props.text ? "px-2" : "px-[6px]"} py-1 border border-line bg-sidebar-bg hover:border-brand hover:bg-accent-tint`
      }`}
    >
      <Icon name={props.icon} size={12} class={props.danger ? "tint-ink-muted group-hover:tint-danger-text" : "tint-ink-secondary group-hover:tint-brand"} />
      <If when={props.text}>
        <Text class={`${narrowWindow() ? "text-[13px]" : "text-[12px]"} font-medium text-ink-secondary group-hover:text-brand`}>{props.label}</Text>
      </If>
    </View>
  );
}

function ProviderCard(props: {
  provider: Row;
  saving: boolean;
  openEditProvider: (id: string) => void;
  openProviderModels: (id: string) => void;
  openDeleteProviderConfirm: (id: string) => void;
  setDefaultProvider: (id: string) => Promise<void>;
  setProviderDefaultModel: (id: string, model: string) => Promise<void>;
}) {
  const t = () => copy();
  const provider = () => props.provider;
  const isDefault = () => runtime.snapshot.settings.default_provider_id === provider().id;
  const palette = () => botAvatarColor(provider().id);
  const builtIn = () => connectorFor(provider().base_url, provider().api_format);
  const planName = () => {
    const found = builtIn();
    if (!found) return null;
    if (found.connector.plans.length <= 1) return null;
    return (t().connectors.plan as Record<string, string>)[`${found.connector.id}:${found.plan.id}`] ?? found.plan.id;
  };
  const phone = () => narrowWindow();

  const mark = () => (
    <If
      when={builtIn()}
      else={
        <View
          class={`items-center justify-center shrink-0 border ${phone() ? "w-10 h-10 rounded-(--radius-md)" : "w-8 h-8 rounded-(--radius-sm)"}`}
          style={{ backgroundColor: cssColor(palette().bg), borderColor: cssColor(palette().border) }}
        >
          <Text class={`${phone() ? "text-[18px]" : "text-[15px]"} font-bold`} style={{ color: cssColor(palette().text) }}>
            {rosterLetter(provider().name)}
          </Text>
        </View>
      }
    >
      {(found: () => NonNullable<ReturnType<typeof connectorFor>>) => (
        <View tooltip={tip(t().connectors.name[found().connector.id])}>
          <ConnectorLogo id={found().connector.id} size={phone() ? 40 : 32} />
        </View>
      )}
    </If>
  );

  const identity = () => (
    <View class="flex-row items-center gap-[10px] flex-1 min-w-0">
      {mark()}
      <View class={`flex-row items-center min-w-0 shrink ${phone() ? "flex-wrap gap-[6px]" : "gap-4"}`}>
        <Text testID={`provider-name-${provider().id}`} tooltip={tip(provider().base_url ?? "")} class={`font-semibold text-ink leading-[1.2] ${phone() ? "text-[18px] w-full" : "text-[14px] line-clamp-1 shrink"}`}>
          {provider().name}
        </Text>
        <If when={planName()} else={
          <If when={provider().api_format === "anthropic" && !builtIn()}>
            <View class="shrink-0 border border-chip-line bg-chip rounded-full px-[6px]">
              <Text class="text-[11px] leading-4 text-ink-secondary">{t().settings.apiFormatAnthropicShort}</Text>
            </View>
          </If>
        }>
          {(name: () => string) => (
            <View class="shrink border border-chip-line bg-chip rounded-full px-[6px]">
              <Text class="text-[11px] leading-4 text-ink-secondary line-clamp-1">{name()}</Text>
            </View>
          )}
        </If>
        <If when={isDefault()}>
          <View testID={`provider-badge-default-${provider().id}`} tooltip={tip(t().settings.providerDefault)} class="shrink-0 flex-row items-center gap-1 bg-accent-tint border border-accent-border rounded-full px-[3px] py-[1.5px]">
            <Icon name="star" size={12} filled class="tint-brand" />
            <If when={phone()}>
              <Text class="text-[11px] font-semibold text-brand pr-1">{t().settings.providerDefault}</Text>
            </If>
          </View>
        </If>
        <If when={!keyReady(provider())}>
          <View testID={`provider-badge-key-${provider().id}`} tooltip={tip(t().settings.keyUnset)} class="shrink-0 flex-row items-center gap-[5px] bg-warn-bg border border-warn-line rounded-full px-[7px] py-[1.5px]">
            <View class="w-3 h-3 rounded-full bg-warn shrink-0" />
            <Text class="text-[11px] font-medium text-warn-text">{t().settings.keyUnset}</Text>
          </View>
        </If>
      </View>
    </View>
  );

  const actions = () => (
    <View class={`flex-row items-center shrink-0 ${phone() ? "border-t border-line gap-0" : "w-[122px] justify-end gap-1"}`}>
      <If when={!isDefault()}>
        <Action
          testID={`provider-default-${provider().id}`}
          label={`${t().settings.providerSetDefault}: ${provider().name}`}
          hover={t().settings.providerSetDefault}
          icon="star"
          text={phone()}
          onPress={() => void props.setDefaultProvider(provider().id)}
        />
      </If>
      <Action
        testID={`provider-edit-${provider().id}`}
        label={`${t().settings.providerConnection}: ${provider().name}`}
        hover={t().settings.providerConnection}
        icon="link"
        text={phone()}
        onPress={() => props.openEditProvider(provider().id)}
      />
      <Action
        testID={`provider-delete-${provider().id}`}
        label={`${t().settings.providerDelete}: ${provider().name}`}
        hover={t().settings.providerDelete}
        icon="trash"
        text={false}
        danger
        onPress={() => props.openDeleteProviderConfirm(provider().id)}
      />
    </View>
  );

  const rail = () => (
    <View class={`${phone() ? "flex-col items-stretch" : "flex-row items-center gap-[2px] shrink-0"}`}>
      <View class={`${phone() ? "flex-col items-stretch gap-2 px-4 pb-4" : "flex-row items-center"}`}>
        <If when={phone()}>
          <Text class="text-[12px] font-medium text-ink-muted">{t().settings.defaultModel}</Text>
        </If>
        <View class={phone() ? "w-full" : "w-[168px]"}>
          <ModelPicker
            testID={`default-model-${provider().id}`}
            size="sm"
            value={provider().default_model ?? ""}
            data={{ specials: [], sources: endpointPickerSources([provider()], t(), (_id, model) => model) }}
            title={t().settings.defaultModel}
            placeholder={provider().models.length ? t().settings.providerChooseDefault : t().settings.providerEnableFirst}
            disabled={provider().models.length === 0 || props.saving}
            ariaLabel={`${t().settings.defaultModel}: ${provider().name}`}
            onChange={(model) => void props.setProviderDefaultModel(provider().id, model)}
          />
        </View>
      </View>
      <View
        role="button"
        testID={`provider-models-${provider().id}`}
        accessibilityLabel={`${t().settings.providerModels}: ${provider().name}`}
        onPress={() => props.openProviderModels(provider().id)}
        class={`cursor-pointer select-none flex-row items-center rounded-(--radius-sm) hover:bg-line-subtle ${phone() ? "gap-2 min-h-14 px-4 py-3 border-t border-line-subtle rounded-none" : "gap-[6px] w-[84px] justify-end py-1 pl-2 pr-[6px] min-h-7"}`}
      >
        <If when={phone()}>
          <Text class="text-[15px] font-semibold text-ink">{t().settings.providerModels}</Text>
        </If>
        <Text testID={`provider-models-count-${provider().id}`} class={`${phone() ? "ml-auto text-[12px] font-medium text-ink-muted" : "text-[12px] font-semibold text-brand"}`}>
          {t().settings.modelsEnabledCount(provider().models.length)}
        </Text>
        <Icon name="chevron-right" size={phone() ? 20 : 16} class={phone() ? "tint-ink-muted" : "tint-brand"} />
      </View>
    </View>
  );

  return (
    <View
      testID={`provider-card-${provider().id}`}
      class={`bg-pane border rounded-(--radius-md) ${isDefault() ? "border-accent-border bg-accent-tint" : "border-line"} ${
        phone() ? "flex-col rounded-(--radius-lg) overflow-hidden" : "flex-row items-center gap-[10px] py-2 pr-2 pl-3"
      }`}
      style={{ boxShadow: phone() ? undefined : shadow("xs") }}
    >
      <View class={phone() ? "px-4 pt-[18px] pb-4" : "flex-1 min-w-0"}>{identity()}</View>
      <If when={phone()} else={<>{rail()}{actions()}</>}>
        <>
          {actions()}
          {rail()}
        </>
      </If>
    </View>
  );
}

export function ProvidersTab(props: {
  providerSaving: boolean;
  openAddProvider: () => void;
  openEditProvider: (id: string) => void;
  openProviderModels: (id: string) => void;
  openDeleteProviderConfirm: (id: string) => void;
  setDefaultProvider: (id: string) => Promise<void>;
  setProviderDefaultModel: (id: string, model: string) => Promise<void>;
}) {
  const t = () => copy().settings;
  /** A copy: the snapshot is a reactive proxy, which `Each` does not walk. */
  const providers = () => [...runtime.snapshot.providers];
  const phone = () => narrowWindow();
  return (
    <View testID="providers-tab" class={`flex-col ${phone() ? "gap-5" : "gap-[14px]"}`}>
      <View class={`${phone() ? "flex-col gap-4" : "flex-row items-start justify-between gap-6"}`}>
        <Text class={`flex-1 text-ink-muted ${phone() ? "text-[14px] leading-[1.6]" : "text-[13px] leading-[1.6]"}`}>{t().providersHint}</Text>
        <View
          role="button"
          testID="provider-add"
          accessibilityLabel={t().providerAdd}
          onPress={() => props.openAddProvider()}
          class={`cursor-pointer select-none flex-row items-center justify-center gap-[6px] shrink-0 hover:bg-accent-tint ${
            phone()
              ? "w-full min-h-12 px-4 py-[10px] border border-accent-border rounded-(--radius-md) bg-accent-tint"
              : "px-3 py-[6px] rounded-(--radius-sm) border-[1.5px] border-dashed border-line bg-sidebar-bg hover:border-brand"
          }`}
        >
          <Icon name="plus" size={phone() ? 16 : 12} class="tint-brand" />
          <Text class={`${phone() ? "text-[15px]" : "text-[13px]"} font-semibold text-brand`}>{t().providerAdd}</Text>
        </View>
      </View>
      <If when={providers().length === 0}>
        <View testID="providers-empty" class="p-6 items-center">
          <Text class="text-[13px] text-ink-muted text-center">{t().providerEmpty}</Text>
        </View>
      </If>
      <View class={`flex-col ${phone() ? "gap-5" : "gap-4"}`}>
        <Each of={providers()} key={(provider) => provider.id}>
          {(provider) => (
            <ProviderCard
              provider={provider()}
              saving={props.providerSaving}
              openEditProvider={props.openEditProvider}
              openProviderModels={props.openProviderModels}
              openDeleteProviderConfirm={props.openDeleteProviderConfirm}
              setDefaultProvider={props.setDefaultProvider}
              setProviderDefaultModel={props.setProviderDefaultModel}
            />
          )}
        </Each>
      </View>
    </View>
  );
}
