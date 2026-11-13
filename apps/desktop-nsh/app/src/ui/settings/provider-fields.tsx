/**
 * The small form pieces the provider and MCP editors share: what the messenger's modal CSS gives
 * `.modal-section` fields (`styles/shared.css`, `styles/modals.css`) written once. A labelled
 * field, a text field, the error and hint lines under it, a choice chip, a segmented control, a
 * small button, the key's status badge and the amber fetch tip.
 */
import { Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { narrowWindow } from "../Modal";
import { HelpTip } from "./HelpTip";

/** The class of a text field in a settings editor: 14px on a desktop, 48px tall and 16px on a phone. */
export function fieldClass(mono = false, compact = false): string {
  const size = narrowWindow() ? "min-h-12 px-3 text-[16px]" : compact ? "px-2 py-1 text-[12px]" : "px-3 py-2 text-[14px]";
  return `w-full text-ink bg-input-bg border border-line rounded-(--radius-md) focus:border-field-focus-border ${size} ${mono ? "font-mono" : ""}`;
}

/**
 * One labelled field of an editor (`.modal-section`): label (and what sits at its end), the control, then notes.
 * `tip` is a note that would otherwise sit under the control, as a "?" beside the label (`tipTestID` its id).
 */
export function Field(props: { label: string; labelID?: string; tip?: string; tipTestID?: string; end?: JSX.Element; children?: JSX.Element }) {
  return (
    <View class="flex-col gap-1">
      <View class="flex-row items-center justify-between mb-[2px]">
        <View class="flex-row items-center gap-[6px] shrink min-w-0">
          <Text testID={props.labelID} class={`${narrowWindow() ? "text-[14px]" : "text-[13px]"} font-semibold text-ink-secondary`}>
            {props.label}
          </Text>
          <If when={props.tip}>
            <HelpTip text={props.tip} label={props.label} testID={props.tipTestID} />
          </If>
        </View>
        {props.end}
      </View>
      {props.children}
    </View>
  );
}

/** A single-line (or multiline) text input in the editors' look. */
export function TextField(props: {
  testID: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  masked?: boolean;
  multiline?: boolean;
  numeric?: boolean;
  compact?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  readonly?: boolean;
  class?: string;
  onSubmit?: () => void;
  onBlur?: () => void;
  onKeyPress?: (key: string) => void;
}) {
  return (
    <Input
      testID={props.testID}
      accessibilityLabel={props.label}
      value={props.value}
      onChange={(e) => props.onInput(e.value)}
      placeholder={props.placeholder}
      masked={props.masked}
      multiline={props.multiline}
      keyboardType={props.numeric ? "numeric" : undefined}
      autoCapitalize="none"
      autoCorrect={false}
      autoFocus={props.autoFocus}
      readonly={props.readonly}
      submitBehavior={props.multiline ? "newline" : "submit"}
      onSubmit={() => props.onSubmit?.()}
      onKeyPress={(e) => props.onKeyPress?.(e.key)}
      onBlur={() => props.onBlur?.()}
      class={`${fieldClass(props.mono, props.compact)} ${props.multiline ? "min-h-[72px]" : ""} ${props.invalid ? "border-danger" : ""} ${props.class ?? ""}`}
    />
  );
}

export function FieldError(props: { testID?: string; children: string }) {
  return (
    <Text testID={props.testID} role="alert" class="mt-[5px] text-[12px] font-medium leading-[1.4] text-warn-text">
      {props.children}
    </Text>
  );
}

export function FieldHint(props: { testID?: string; children: string }) {
  return (
    <Text testID={props.testID} class="mt-[6px] text-[12px] leading-[1.4] text-ink-muted">
      {props.children}
    </Text>
  );
}

/** `.btn-chip`: a choice among a few; `active` fills it with the accent. */
export function Chip(props: {
  label: string;
  active?: boolean;
  add?: boolean;
  custom?: boolean;
  role?: "button" | "radio" | "checkbox";
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const phone = () => narrowWindow();
  return (
    <View
      role={props.role ?? "button"}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ selected: props.active === true, checked: props.active === true, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default items-center justify-center border rounded-full active:scale-[0.97] disabled:opacity-[0.45] ${phone() ? "min-h-11 px-[14px] py-2 rounded-(--radius-md)" : "px-[11px] py-1"} ${
        props.active
          ? "bg-brand border-brand"
          : `${props.add ? "border-dashed bg-transparent" : "bg-chip"} border-line hover:border-accent-border hover:bg-accent-tint`
      }`}
    >
      <Text class={`${phone() ? "text-[14px]" : "text-[12px]"} leading-[1.3] ${props.custom ? "font-mono" : ""} ${props.active ? "text-on-accent font-medium" : "text-ink-secondary"}`}>
        {props.label}
      </Text>
    </View>
  );
}

/** `.btn-xs`: a small bordered button. */
export function XsButton(props: { label: string; disabled?: boolean; testID?: string; primary?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default items-center justify-center border rounded-(--radius-sm) disabled:opacity-[0.4] ${narrowWindow() ? "min-h-11 px-3" : "px-2 py-[3px]"} ${
        props.primary ? "bg-brand border-brand" : "bg-btn-secondary-bg border-line hover:bg-line-subtle hover:border-line-hover"
      }`}
    >
      <Text class={`${narrowWindow() ? "text-[13px]" : "text-[11px]"} font-medium ${props.primary ? "text-on-accent" : "text-ink-secondary"}`}>{props.label}</Text>
    </View>
  );
}

/** `.btn-text-action`: words in the accent colour, no frame. */
export function TextAction(props: { label: string; testID?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default self-start justify-center disabled:opacity-[0.45] ${narrowWindow() ? "min-h-11" : ""}`}
    >
      <Text class={`${narrowWindow() ? "text-[14px]" : "text-[12px]"} font-medium text-brand`}>{props.label}</Text>
    </View>
  );
}

/** The pill beside a key field: set (green) or not (grey). */
export function StatusBadge(props: { on: boolean; testID?: string; children: string }) {
  return (
    <View testID={props.testID} class={`border rounded-full px-2 py-[2px] ${props.on ? "bg-ok-bg border-ok-line" : "bg-chip border-chip-line"}`}>
      <Text class={`text-[11px] ${props.on ? "font-semibold text-ok-text" : "font-medium text-ink-muted"}`}>{props.children}</Text>
    </View>
  );
}

/** `.models-fetch-tip`: the endpoint's answer when listing models failed. */
export function FetchTip(props: { testID?: string; children: string }) {
  return (
    <View testID={props.testID} role="alert" class="px-[10px] py-[6px] bg-warn-bg border border-warn-line rounded-(--radius-sm)">
      <Text class="text-[12px] leading-[1.4] text-warn-text">{props.children}</Text>
    </View>
  );
}
