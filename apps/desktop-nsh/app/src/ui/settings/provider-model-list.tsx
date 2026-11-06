/**
 * The "models" view of the provider editor (`ProviderForm.svelte`'s `view === "models"`): the
 * models fetched from the endpoint (plus ones typed in by hand) with a box each, a search and the
 * all / enabled filter once the list is long (always on a phone), the fetch button, the "add by
 * name" line, and the attributes of each enabled model (`provider-model-attrs`). On a phone a
 * model's attributes are a page of their own (`detailModel`) instead of opening under the row.
 *
 * The draft is the caller's: every change is `onChange(next)`.
 */
import { effect, Scroll, signal, Text, View, type JSX } from "nsh";
import { isLocalEndpoint, type ModelSpeed } from "@real-bot/protocol";
import { copy } from "../../runtime";
import {
  addDraftModel,
  hasCustomAttrs,
  emptyModelAttr,
  pickerModels,
  probeSignature,
  setDraftModels,
  toggleDraftModel,
  type ModelAttrDraft,
  type ProviderDraft,
  type ProviderFieldErrors,
} from "../../m/settings/provider-form.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { ModelAttributes, type SpeedState } from "./provider-model-attrs";
import { FieldError, TextAction, TextField, XsButton, FetchTip } from "./provider-fields";

/** A list this long gets a search and filters on a desktop; a phone always has them. */
const TOOLBAR_MIN_ROWS = 6;

export type MeasureModel = (model: string) => Promise<{ ok: true; speed: ModelSpeed } | { ok: false; error: string }>;

function Segmented(props: { label: string; children: JSX.Element }) {
  return (
    <View
      role="group"
      accessibilityLabel={props.label}
      class={`flex-row shrink-0 overflow-hidden border border-line ${narrowWindow() ? "w-full p-[3px] rounded-(--radius-md) bg-chip border-0" : "rounded-(--radius-sm)"}`}
    >
      {props.children}
    </View>
  );
}

function Segment(props: { testID: string; active: boolean; children: string; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.children}
      accessibilityState={{ selected: props.active }}
      onPress={() => props.onPress()}
      class={`items-center justify-center ${narrowWindow() ? "flex-1 min-h-11 rounded-(--radius-sm)" : "px-2 py-[3px]"} ${props.active ? (narrowWindow() ? "bg-pane" : "bg-accent-tint") : narrowWindow() ? "" : "bg-btn-secondary-bg"}`}
    >
      <Text class={`${narrowWindow() ? "text-[14px]" : "text-[11px]"} ${props.active ? (narrowWindow() ? "font-semibold text-ink" : "font-semibold text-brand") : "font-medium text-ink-secondary"}`}>
        {props.children}
      </Text>
    </View>
  );
}

const PILL = {
  price: { box: "bg-warn-bg border-warn-line", ink: "text-warn-text font-mono" },
  thinking: { box: "bg-purple-bg border-purple-line", ink: "text-purple-text" },
  strengths: { box: "bg-sky-bg border-sky-line", ink: "text-sky-text" },
} as const;

function Pill(props: { tone: keyof typeof PILL; children: string }) {
  return (
    <View class={`border rounded-(--radius-xs) px-[7px] py-[2px] max-w-[110px] ${PILL[props.tone].box}`}>
      <Text class={`text-[11px] font-medium line-clamp-1 ${PILL[props.tone].ink}`}>{props.children}</Text>
    </View>
  );
}

export function ProviderModelList(props: {
  draft: ProviderDraft;
  errors: ProviderFieldErrors;
  fetching: boolean;
  fetchError: string | null;
  fieldPrefix: string;
  keySet?: boolean;
  /** Phone: the model whose attributes page is open. */
  detailModel: string | null;
  onDetailModelChange: (model: string | null) => void;
  onChange: (draft: ProviderDraft) => void;
  onFetch: () => void;
  /** Present only while editing a saved endpoint (ADR 0067). */
  measure?: MeasureModel;
}) {
  const t = () => copy().settings;
  const speed = signal<Record<string, SpeedState>>({});
  const filterQuery = signal("");
  const filterMode = signal<"all" | "enabled">("all");
  const expanded = signal<Record<string, boolean>>({});
  const manualOpen = signal(false);
  const manualName = signal("");
  const manualFeedback = signal("");

  const rows = () => pickerModels(props.draft);
  const enabled = () => new Set(props.draft.models);
  const available = () => new Set(props.draft.availableModels);
  const canProbe = () => probeSignature(props.draft, Boolean(props.keySet)) !== null;
  /** A model server on this computer or network takes no key (ADR 0067). */
  const keyless = () => isLocalEndpoint(props.draft.baseUrl);
  const showToolbar = () => narrowWindow() || rows().length > TOOLBAR_MIN_ROWS;
  const visibleRows = () => {
    const q = filterQuery().trim().toLowerCase();
    return rows().filter((name) => {
      if (filterMode() === "enabled" && !enabled().has(name)) return false;
      return q.length === 0 || name.toLowerCase().includes(q);
    });
  };
  const attrOf = (name: string): ModelAttrDraft => props.draft.modelAttrs[name] ?? emptyModelAttr();

  function patchAttr(name: string, next: ModelAttrDraft): void {
    if (next === props.draft.modelAttrs[name]) return;
    props.onChange({ ...props.draft, modelAttrs: { ...props.draft.modelAttrs, [name]: next } });
  }

  async function runSpeed(name: string): Promise<void> {
    if (!props.measure || speed()[name]?.running) return;
    speed.set({ ...speed(), [name]: { running: true } });
    const res = await props.measure(name);
    speed.set({ ...speed(), [name]: res.ok ? { running: false, result: res.speed } : { running: false, error: res.error } });
  }

  function toggleExpanded(name: string): void {
    if (narrowWindow()) props.onDetailModelChange(name);
    else expanded.set({ ...expanded(), [name]: !expanded()[name] });
  }

  effect(() => {
    if (props.detailModel && (!narrowWindow() || !enabled().has(props.detailModel))) props.onDetailModelChange(null);
  });

  function clearVisible(): void {
    const visible = new Set(visibleRows());
    props.onChange(setDraftModels(props.draft, props.draft.models.filter((name) => !visible.has(name))));
  }

  function selectVisible(): void {
    const merged = [...props.draft.models];
    for (const name of visibleRows()) if (!merged.includes(name)) merged.push(name);
    props.onChange(setDraftModels(props.draft, merged));
  }

  function submitManual(): void {
    const next = addDraftModel(props.draft, manualName());
    if (!manualName().trim()) return;
    if (next === props.draft) {
      manualFeedback.set(t().modelsAlreadyEnabled);
      return;
    }
    props.onChange(next);
    manualFeedback.set(t().modelsManualAdded(manualName().trim()));
    filterQuery.set("");
    manualName.set("");
  }

  const emptyHint = () => {
    if (props.fetching) return t().modelsFetchingHint;
    if (canProbe() && !props.fetchError) return t().modelsAutoFetchHint;
    return t().modelsEmptyHint;
  };

  const row = (name: string) => {
    const on = () => enabled().has(name);
    const attr = () => attrOf(name);
    const open = () => on() && !narrowWindow() && Boolean(expanded()[name]);
    return (
      <View testID={`model-row-${name}`} class={`flex-col ${narrowWindow() ? "" : "rounded-(--radius-sm)"} ${on() && !narrowWindow() ? "bg-input-bg" : ""} ${open() ? "border border-accent-border" : "border border-transparent"}`}>
        <View class="flex-row items-center gap-2">
          <View
            role="checkbox"
            testID={`model-toggle-${name}`}
            accessibilityLabel={name}
            accessibilityState={{ checked: on() }}
            onPress={() => props.onChange(toggleDraftModel(props.draft, name))}
            class={`flex-1 min-w-0 flex-row items-center rounded-(--radius-sm) hover:bg-line-subtle ${narrowWindow() ? "gap-3 p-3 min-h-16" : "gap-2 px-2 py-[6px]"}`}
          >
            <View class={`items-center justify-center shrink-0 border ${narrowWindow() ? "w-[22px] h-[22px] rounded-[7px]" : "w-[15px] h-[15px] rounded-(--radius-xs)"} ${on() ? "bg-brand border-brand" : "bg-input-bg border-line-hover"}`}>
              <If when={on()}>
                <Icon name="check" size={narrowWindow() ? 12 : 12} class="tint-on-accent" />
              </If>
            </View>
            <Text class={`flex-1 min-w-0 line-clamp-1 text-ink ${narrowWindow() ? "text-[14px]" : "font-mono text-[13px]"}`}>{name}</Text>
            <If when={!available().has(name)}>
              <View class="shrink-0 border border-chip-line bg-chip rounded-full px-[6px] py-[1px]">
                <Text class="text-[10px] text-ink-muted">{t().modelCustomBadge}</Text>
              </View>
            </If>
            <If when={props.draft.probedFacts?.[name]?.tools === false}>
              <View class="shrink-0 border border-warn bg-transparent rounded-full px-[6px] py-[1px]">
                <Text class="text-[10px] text-warn-text">{t().modelNoTools}</Text>
              </View>
            </If>
          </View>
          <If when={on()}>
            <View
              role="button"
              testID={`model-attrs-toggle-${name}`}
              accessibilityLabel={t().modelAttrsToggle(name)}
              accessibilityState={{ expanded: open() }}
              onPress={() => toggleExpanded(name)}
              class={`shrink-0 flex-row items-center gap-1 mr-[2px] rounded-(--radius-sm) hover:bg-line-subtle ${narrowWindow() ? "min-w-14 min-h-12 justify-center px-2" : "max-w-[55%] px-[6px] py-1"}`}
            >
              <If when={!narrowWindow() && attr().price.trim()}>
                <Pill tone="price">{attr().price.trim()}</Pill>
              </If>
              <If when={!narrowWindow() && hasCustomAttrs({ ...attr(), price: "", strengths: [] }, props.draft.advertisedThinking[name])}>
                <Pill tone="thinking">{attr().thinkingLevels.join("/")}</Pill>
              </If>
              <If when={!narrowWindow()}>
                <Each of={attr().strengths} key={(tag) => tag}>
                  {(tag) => <Pill tone="strengths">{tag()}</Pill>}
                </Each>
              </If>
              <If when={narrowWindow()} else={<Text class="w-6 text-center text-[11px] text-ink-muted">{open() ? "▾" : "▸"}</Text>}>
                <Text class="text-[12px] text-brand">{t().modelSettingsAction}</Text>
              </If>
            </View>
          </If>
        </View>
        <If when={open()}>
          <ModelAttributes
            name={name}
            draft={props.draft}
            fieldPrefix={props.fieldPrefix}
            keyless={keyless()}
            speed={speed()}
            canMeasure={Boolean(props.measure)}
            onRunSpeed={(n) => void runSpeed(n)}
            onPatch={patchAttr}
          />
        </If>
      </View>
    );
  };

  const list = () => (
    <View testID={`${props.fieldPrefix}-model-list`} class="flex-col">
      <If
        when={visibleRows().length > 0}
        else={
          <Text testID={`${props.fieldPrefix}-model-none`} class={`text-center text-ink-muted ${narrowWindow() ? "p-7 text-[14px]" : "p-7 text-[12px]"}`}>
            {filterMode() === "enabled" && filterQuery().trim().length === 0 ? t().modelsEnabledEmpty : t().modelAttrsEmptyFilter}
          </Text>
        }
      >
        <Each of={visibleRows()} key={(name) => name}>
          {(name) => row(name())}
        </Each>
      </If>
    </View>
  );

  return (
    <View class="flex-col gap-1">
      <If when={props.detailModel}>
        {(detail: () => string) => (
          <View testID={`${props.fieldPrefix}-model-detail`} class="flex-col py-1">
            <Text testID={`${props.fieldPrefix}-model-detail-name`} class="mb-2 text-[18px] font-semibold font-mono text-ink">{detail()}</Text>
            <Text class="mb-6 text-[13px] leading-[1.6] text-ink-muted">{t().modelSettingsHint}</Text>
            <ModelAttributes
              name={detail()}
              draft={props.draft}
              fieldPrefix={props.fieldPrefix}
              keyless={keyless()}
              speed={speed()}
              canMeasure={Boolean(props.measure)}
              onRunSpeed={(n) => void runSpeed(n)}
              onPatch={patchAttr}
            />
          </View>
        )}
      </If>
      <If when={!props.detailModel}>
        <View class="flex-col gap-1">
          <View class="flex-row items-center justify-between gap-2 mb-[2px]">
            <View class={`${narrowWindow() ? "flex-col items-start gap-1" : "flex-row items-center gap-[6px]"}`}>
              <Text testID={`${props.fieldPrefix}-models-label`} class={`${narrowWindow() ? "text-[16px]" : "text-[13px]"} font-semibold text-ink-secondary`}>
                {t().models}
              </Text>
              <If when={rows().length > 0}>
                <View testID={`${props.fieldPrefix}-models-counts`} class={narrowWindow() ? "" : "border border-chip-line bg-chip rounded-full px-[6px] py-[1px]"}>
                  <Text class={`${narrowWindow() ? "text-[12px]" : "text-[11px] font-medium"} text-ink-muted`}>{t().modelsCounts(props.draft.models.length, rows().length)}</Text>
                </View>
              </If>
            </View>
            <View
              role="button"
              testID={`${props.fieldPrefix}-fetch`}
              accessibilityLabel={props.fetching ? t().modelsFetching : props.draft.availableModels.length > 0 ? t().modelsRefetch : t().modelsFetch}
              accessibilityState={{ disabled: props.fetching || !canProbe() }}
              disabled={props.fetching || !canProbe()}
              onPress={() => props.onFetch()}
              class={`shrink-0 border border-accent-border bg-accent-tint rounded-full hover:bg-brand disabled:opacity-[0.6] ${narrowWindow() ? "min-h-11 px-3 justify-center rounded-(--radius-md) bg-pane border-line" : "px-2 py-[2px]"}`}
            >
              <Text class={`${narrowWindow() ? "text-[13px]" : "text-[11px]"} font-semibold text-brand`}>
                {props.fetching ? t().modelsFetching : `↻ ${props.draft.availableModels.length > 0 ? t().modelsRefetch : t().modelsFetch}`}
              </Text>
            </View>
          </View>
          <If when={narrowWindow()}>
            <Text class="mb-4 text-[13px] leading-[1.6] text-ink-muted">{t().modelsSelectionHint}</Text>
          </If>
          <If when={props.fetchError}>
            <FetchTip testID={`${props.fieldPrefix}-fetch-error`}>{props.fetchError ?? ""}</FetchTip>
          </If>
          <View
            testID={`${props.fieldPrefix}-model-picker`}
            class={`flex-col overflow-hidden ${narrowWindow() ? "" : `border rounded-(--radius-md) bg-chip ${props.errors.models ? "border-danger" : "border-line"}`}`}
          >
            <If
              when={rows().length > 0}
              else={
                <View class="py-9 px-7 items-center">
                  <Text testID={`${props.fieldPrefix}-models-empty`} class="text-center text-[13px] leading-[1.5] text-ink-muted">{emptyHint()}</Text>
                </View>
              }
            >
              <If when={showToolbar()}>
                <View class={`${narrowWindow() ? "flex-col items-stretch gap-3 pb-3" : "flex-row items-center gap-[6px] p-2 border-b border-line"}`}>
                  <View class="relative flex-1 min-w-0">
                    <TextField
                      testID={`${props.fieldPrefix}-model-search`}
                      label={t().modelsSearchPlaceholder}
                      placeholder={t().modelsSearchPlaceholder}
                      compact={!narrowWindow()}
                      value={filterQuery()}
                      onInput={(value) => filterQuery.set(value)}
                      class={filterQuery() ? "pr-9" : ""}
                    />
                    <If when={filterQuery()}>
                      <View
                        role="button"
                        testID={`${props.fieldPrefix}-model-search-clear`}
                        accessibilityLabel={t().modelsClearSearch}
                        tooltip={tip(t().modelsClearSearch)}
                        onPress={() => filterQuery.set("")}
                        class="absolute right-0 top-0 bottom-0 w-9 items-center justify-center"
                      >
                        <Text class="text-[18px] text-ink-muted">×</Text>
                      </View>
                    </If>
                  </View>
                  <View class={`${narrowWindow() ? "flex-col gap-2" : "flex-row items-center gap-[6px]"}`}>
                    <Segmented label={t().models}>
                      <Segment testID={`${props.fieldPrefix}-filter-all`} active={filterMode() === "all"} onPress={() => filterMode.set("all")}>
                        {narrowWindow() ? `${t().modelsFilterAll} ${rows().length}` : t().modelsFilterAll}
                      </Segment>
                      <Segment testID={`${props.fieldPrefix}-filter-enabled`} active={filterMode() === "enabled"} onPress={() => filterMode.set("enabled")}>
                        {`${t().modelsFilterEnabled} ${props.draft.models.length}`}
                      </Segment>
                    </Segmented>
                    <View class="flex-row items-center gap-[6px]">
                      <XsButton
                        testID={`${props.fieldPrefix}-select-visible`}
                        label={filterQuery().trim() ? t().modelsSelectVisible : t().modelsSelectAll}
                        disabled={visibleRows().every((name) => enabled().has(name))}
                        onPress={selectVisible}
                      />
                      <XsButton
                        testID={`${props.fieldPrefix}-clear-visible`}
                        label={filterQuery().trim() ? t().modelsClearVisible : t().modelsDeselectAll}
                        disabled={!visibleRows().some((name) => enabled().has(name))}
                        onPress={clearVisible}
                      />
                    </View>
                  </View>
                </View>
              </If>
              <If
                when={narrowWindow()}
                else={
                  <Scroll class="max-h-[260px]">
                    <View class="p-2 gap-1">{list()}</View>
                  </Scroll>
                }
              >
                <View class="border border-line rounded-(--radius-lg) bg-pane overflow-hidden">{list()}</View>
              </If>
            </If>
            <View class={`${narrowWindow() ? "flex-col gap-2 mt-4" : "flex-row items-center gap-[6px] px-2 py-[6px] border-t border-line"}`}>
              <If
                when={manualOpen()}
                else={
                  <TextAction
                    testID={`${props.fieldPrefix}-manual-open`}
                    label={`+ ${t().modelsAddManual}`}
                    onPress={() => {
                      manualOpen.set(true);
                      manualFeedback.set("");
                    }}
                  />
                }
              >
                <TextField
                  testID={`${props.fieldPrefix}-manual-input`}
                  label={t().modelsAddManual}
                  placeholder={t().modelsAddManualPlaceholder}
                  mono
                  compact={!narrowWindow()}
                  autoFocus
                  value={manualName()}
                  onInput={(value) => manualName.set(value)}
                  onSubmit={submitManual}
                />
                <View class="flex-row items-center gap-[6px]">
                  <XsButton testID={`${props.fieldPrefix}-manual-confirm`} primary={narrowWindow()} label={t().modelsAddConfirm} disabled={!manualName().trim()} onPress={submitManual} />
                  <XsButton
                    testID={`${props.fieldPrefix}-manual-cancel`}
                    label={copy().sidebar.cancel}
                    onPress={() => {
                      manualOpen.set(false);
                      manualName.set("");
                      manualFeedback.set("");
                    }}
                  />
                </View>
              </If>
            </View>
            <If when={manualFeedback()}>
              <Text testID={`${props.fieldPrefix}-manual-feedback`} class={`${narrowWindow() ? "pt-3 text-[13px]" : "p-2 text-[12px]"} text-ink-secondary`}>
                {manualFeedback()}
              </Text>
            </If>
          </View>
          <If when={props.errors.models}>
            <FieldError testID={`${props.fieldPrefix}-models-error`}>{t().modelsEmpty}</FieldError>
          </If>
          <If when={props.errors.defaultModel}>
            <FieldError testID={`${props.fieldPrefix}-default-error`}>
              {props.errors.defaultModel === "empty" ? t().defaultModelEmpty : props.errors.defaultModel === "invalid" ? t().defaultModelInvalid : ""}
            </FieldError>
          </If>
        </View>
      </If>
    </View>
  );
}
