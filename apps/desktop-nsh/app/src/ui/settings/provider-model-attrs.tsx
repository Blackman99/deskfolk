/**
 * One enabled model's attributes in the provider editor (`ProviderForm.svelte`'s `modelAttributes`
 * snippet): price, billing per million tokens, thinking levels, picture input, context window, the
 * speed test of a saved endpoint, and strengths. Shown under its row on a desktop and as the
 * "model settings" page on a phone. The draft is the caller's: every change is `onPatch(next)`.
 *
 * The speed results are the caller's too (`speed`, `onRunSpeed`), so closing the row does not lose
 * what the last test found.
 */
import { keymap, signal, Text, View } from "nsh";
import type { ModelSpeed } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { thinkingLevelLabel } from "../../m/copy.ts";
import {
  PRESET_STRENGTHS,
  addAttrStrength,
  addAttrThinkingLevel,
  emptyModelAttr,
  invalidBilling,
  invalidContextWindow,
  thinkingChipOptions,
  toggleAttrStrength,
  toggleAttrThinkingLevel,
  type ModelAttrDraft,
  type ProviderDraft,
} from "../../m/settings/provider-form.ts";
import { narrowWindow } from "../Modal";
import { Chip, FieldError, TextAction, TextField } from "./provider-fields";

export type SpeedState = { running: boolean; result?: ModelSpeed; error?: string };

const PRESET_KEYS = new Set<string>(PRESET_STRENGTHS);

/** The one-line summary of a speed test: rate, first byte, tool calls. */
export function speedLine(result: ModelSpeed): string {
  const t = copy().settings;
  const parts: string[] = [];
  if (result.tokens_per_second !== null) parts.push(t.modelSpeedRate(result.tokens_per_second));
  if (result.first_byte_ms !== null) parts.push(t.modelSpeedFirstByte(Math.round(result.first_byte_ms / 100) / 10));
  if (result.tool_call === true) parts.push(t.modelSpeedTools);
  return parts.join(t.modelSpeedJoin);
}

/** The text field a chip row opens to add its own entry: Return or leaving it adds, Escape drops it. */
function ChipInput(props: { testID: string; label: string; placeholder: string; onDone: (text: string) => void; onCancel: () => void }) {
  const text = signal("");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    props.onDone(text());
  };
  keymap.bind("escape", () => {
    finished = true;
    props.onCancel();
  }, { when: "always" });
  return (
    <TextField
      testID={props.testID}
      label={props.label}
      mono
      compact
      autoFocus
      placeholder={props.placeholder}
      value={text()}
      onInput={(value) => text.set(value)}
      onSubmit={finish}
      onBlur={finish}
      class={narrowWindow() ? "w-full" : "w-[120px] border-brand"}
    />
  );
}

function AttrLabel(props: { children: string; testID?: string }) {
  return (
    <Text testID={props.testID} class={`${narrowWindow() ? "text-[14px]" : "text-[12px]"} font-semibold text-ink-secondary`}>
      {props.children}
    </Text>
  );
}

export function ModelAttributes(props: {
  name: string;
  draft: ProviderDraft;
  fieldPrefix: string;
  /** A model server on this computer or network takes no key (ADR 0067). */
  keyless: boolean;
  speed: Record<string, SpeedState>;
  /** Present only while editing a saved endpoint: the speed test is the daemon's. */
  canMeasure: boolean;
  onRunSpeed: (name: string) => void;
  onPatch: (name: string, next: ModelAttrDraft) => void;
}) {
  const t = () => copy().settings;
  const attr = () => props.draft.modelAttrs[props.name] ?? emptyModelAttr();
  const patch = (next: ModelAttrDraft) => props.onPatch(props.name, next);
  const id = (part: string) => `${props.fieldPrefix}-${part}-${props.name}`;
  const customTags = () => attr().strengths.filter((tag) => !PRESET_KEYS.has(tag.toLowerCase()));
  const hasStrength = (tag: string) => attr().strengths.some((item) => item.toLowerCase() === tag.toLowerCase());
  const strengthEditing = signal(false);
  const thinkingEditing = signal(false);
  const speedState = () => props.speed[props.name];
  const billing = [
    { key: "billingInput" as const, label: () => t().modelBillingInput },
    { key: "billingOutput" as const, label: () => t().modelBillingOutput },
    { key: "billingCachedInput" as const, label: () => t().modelBillingCached },
  ];
  const billingFilled = () => Boolean(attr().billingInput || attr().billingOutput || attr().billingCachedInput);

  return (
    <View testID={`model-attrs-${props.name}`} class={`flex-col ${narrowWindow() ? "gap-6 p-4 bg-pane border border-line rounded-(--radius-lg)" : "gap-2 pl-[31px] pr-[10px] pt-1 pb-[10px]"}`}>
      <View class="flex-col gap-1">
        <AttrLabel>{t().modelPrice}</AttrLabel>
        <TextField
          testID={id("price")}
          label={t().modelPrice}
          numeric
          mono
          compact={!narrowWindow()}
          placeholder={t().modelPriceHint}
          value={attr().price}
          onInput={(price) => patch({ ...attr(), price })}
          class={narrowWindow() ? "" : "max-w-[160px]"}
        />
      </View>
      <View class="flex-col gap-[6px]">
        <Text class={`${narrowWindow() ? "text-[14px]" : "text-[12px]"} font-semibold text-ink-secondary`}>
          {t().modelBilling} <Text class="font-normal text-ink-muted">{t().modelBillingUnit}</Text>
        </Text>
        <View class={`${narrowWindow() ? "flex-col" : "flex-row"} gap-2`}>
          <Each of={billing} key={(field) => field.key}>
            {(field) => (
              <View class={`flex-col gap-1 min-w-0 ${narrowWindow() ? "" : "flex-1"}`}>
                <AttrLabel>{field().label()}</AttrLabel>
                <TextField
                  testID={id(field().key)}
                  label={field().label()}
                  numeric
                  mono
                  compact={!narrowWindow()}
                  placeholder={t().modelBillingOptional}
                  value={attr()[field().key] ?? ""}
                  invalid={invalidBilling(attr())}
                  onInput={(value) => patch({ ...attr(), [field().key]: value })}
                />
              </View>
            )}
          </Each>
        </View>
        <Text class="text-[11px] leading-[1.5] text-ink-muted">{t().modelBillingHint}</Text>
        <If when={invalidBilling(attr())}>
          <FieldError testID={id("billing-error")}>{t().modelBillingInvalid}</FieldError>
        </If>
        <If when={billingFilled()}>
          <TextAction
            testID={id("billing-clear")}
            label={t().modelBillingClear}
            onPress={() => patch({ ...attr(), billingInput: "", billingOutput: "", billingCachedInput: "" })}
          />
        </If>
      </View>
      <View class="flex-col gap-1">
        <AttrLabel>{t().modelThinking}</AttrLabel>
        <View role="group" accessibilityLabel={t().modelThinking} class="flex-row flex-wrap items-center gap-2 min-h-11">
          <Each of={thinkingChipOptions(attr(), props.draft.advertisedThinking[props.name])} key={(level) => level}>
            {(level) => (
              <Chip
                testID={id(`thinking-${level()}`)}
                label={thinkingLevelLabel(copy().sidebar.thinkingLevels, level())}
                active={attr().thinkingLevels.includes(level())}
                onPress={() => patch(toggleAttrThinkingLevel(attr(), level()))}
              />
            )}
          </Each>
          <If
            when={thinkingEditing()}
            else={<Chip testID={id("thinking-add")} add label={`+ ${t().modelThinkingAdd}`} onPress={() => thinkingEditing.set(true)} />}
          >
            <ChipInput
              testID={id("thinking-input")}
              label={t().modelThinkingAdd}
              placeholder={t().modelThinkingAddPlaceholder}
              onDone={(text) => {
                thinkingEditing.set(false);
                patch(addAttrThinkingLevel(attr(), text));
              }}
              onCancel={() => thinkingEditing.set(false)}
            />
          </If>
        </View>
      </View>
      <View class="flex-col gap-1">
        <AttrLabel>{t().modelInputImage}</AttrLabel>
        <View role="radiogroup" accessibilityLabel={t().modelInputImage} class="flex-row flex-wrap items-center gap-2 min-h-11">
          <Chip testID={id("image-yes")} role="radio" label={t().modelInputImageYes} active={(attr().inputImage ?? null) === true} onPress={() => patch({ ...attr(), inputImage: true })} />
          <Chip testID={id("image-no")} role="radio" label={t().modelInputImageNo} active={(attr().inputImage ?? null) === false} onPress={() => patch({ ...attr(), inputImage: false })} />
          <Chip testID={id("image-unknown")} role="radio" label={t().modelInputImageUnknown} active={(attr().inputImage ?? null) === null} onPress={() => patch({ ...attr(), inputImage: null })} />
        </View>
      </View>
      <View class="flex-col gap-1">
        <AttrLabel>{t().modelContextWindow}</AttrLabel>
        <TextField
          testID={id("window")}
          label={t().modelContextWindow}
          numeric
          mono
          compact={!narrowWindow()}
          placeholder={t().modelContextWindowPlaceholder}
          value={attr().contextWindow ?? ""}
          invalid={invalidContextWindow(attr())}
          onInput={(value) => patch({ ...attr(), contextWindow: value.replace(/[\s,_]/g, "") })}
          class={narrowWindow() ? "" : "max-w-[160px]"}
        />
        <Text class="mt-[6px] text-[11px] leading-[1.5] text-ink-muted">
          {props.keyless ? t().modelContextWindowLocalHint : t().modelContextWindowHint}
        </Text>
        <If when={invalidContextWindow(attr())}>
          <FieldError testID={id("window-error")}>{t().modelContextWindowInvalid}</FieldError>
        </If>
      </View>
      <If when={props.canMeasure}>
        <View class="flex-col gap-1">
          <AttrLabel>{t().modelSpeed}</AttrLabel>
          <View class="flex-row flex-wrap items-center gap-2">
            <Chip
              testID={id("speed-run")}
              label={speedState()?.running ? t().modelSpeedRunning : t().modelSpeedRun}
              disabled={speedState()?.running === true}
              onPress={() => props.onRunSpeed(props.name)}
            />
            <If when={!speedState()?.result && !speedState()?.error && attr().recordedTps !== undefined}>
              <Text class="text-[12px] leading-[1.5] text-ink-secondary">{t().modelSpeedRecorded(attr().recordedTps!)}</Text>
            </If>
          </View>
          <If
            when={speedState()?.result}
            else={
              <If when={speedState()?.error}>
                <FieldError testID={id("speed-error")}>{t().modelSpeedError(speedState()!.error!)}</FieldError>
              </If>
            }
          >
            {(result: () => ModelSpeed) => (
              <View class="flex-col">
                <Text testID={id("speed-result")} class="text-[12px] leading-[1.5] text-ink-secondary">{speedLine(result())}</Text>
                <If when={result().tool_call === false}>
                  <FieldError>{t().modelSpeedNoTools}</FieldError>
                </If>
                <If when={result().failed}>
                  <FieldError>{t().modelSpeedFailed((copy().routes.failReason as Record<string, string>)[result().failed!] ?? result().failed!)}</FieldError>
                </If>
              </View>
            )}
          </If>
          <Text class="mt-[6px] text-[11px] leading-[1.5] text-ink-muted">{t().modelSpeedHint}</Text>
        </View>
      </If>
      <View class="flex-col gap-1">
        <AttrLabel>{t().modelStrengths}</AttrLabel>
        <View role="group" accessibilityLabel={t().modelStrengths} class="flex-row flex-wrap items-center gap-2 min-h-11">
          <Each of={[...PRESET_STRENGTHS]} key={(tag) => tag}>
            {(tag) => <Chip testID={id(`strength-${tag()}`)} label={tag()} active={hasStrength(tag())} onPress={() => patch(toggleAttrStrength(attr(), tag()))} />}
          </Each>
          <Each of={customTags()} key={(tag) => tag}>
            {(tag) => (
              <Chip
                testID={id(`strength-${tag()}`)}
                custom
                active
                label={`${tag()} ×`}
                accessibilityLabel={t().modelStrengthRemove(tag())}
                onPress={() => patch(toggleAttrStrength(attr(), tag()))}
              />
            )}
          </Each>
          <If
            when={strengthEditing()}
            else={<Chip testID={id("strength-add")} add label={`+ ${t().modelStrengthsAdd}`} onPress={() => strengthEditing.set(true)} />}
          >
            <ChipInput
              testID={id("strength-input")}
              label={t().modelStrengthsAdd}
              placeholder={t().modelStrengthsAddPlaceholder}
              onDone={(text) => {
                strengthEditing.set(false);
                patch(addAttrStrength(attr(), text));
              }}
              onCancel={() => strengthEditing.set(false)}
            />
          </If>
        </View>
      </View>
    </View>
  );
}
