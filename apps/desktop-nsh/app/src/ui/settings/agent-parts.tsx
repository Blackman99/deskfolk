/**
 * The small pieces the three agent cards (`AgentCard`, `ClaudeAgentCard`, `CustomAgentsCard`)
 * share, which their Svelte sources each styled with the same scoped CSS: the card frame (or none,
 * when opened from the Agents list), its heading, a note / warning / error paragraph, a fact row of
 * the `dl`, a mono `code`, an account block, a path field, the quiet "collapse" button.
 * `XsButton` and `TextAction` (`.btn-xs`, `.btn-link`) are `provider-fields.tsx`'s.
 */
import { Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import type { BotRunner } from "@real-bot/protocol";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { AgentLogo } from "./AgentLogo";
import { HelpTip } from "./HelpTip";

/** `.agent-card` / `.claude-card` / `.custom-card`: the pane colour and a hairline; `embedded` has neither. */
export function AgentFrame(props: { label: string; testID: string; embedded?: boolean; children?: JSX.Element }) {
  return (
    <View
      role="region"
      accessibilityLabel={props.label}
      testID={props.testID}
      class={`flex-col gap-[10px] min-w-0 ${props.embedded ? "" : "px-[14px] py-3 bg-pane border border-line rounded-(--radius-md)"}`}
      style={{ boxShadow: props.embedded ? undefined : shadow("xs") }}
    >
      {props.children}
    </View>
  );
}

/** The card's heading: its logo, its name and a "?" tip. */
export function AgentTitle(props: { runner: BotRunner; title: string; tip: string; tipLabel: string; labelTestID?: string; tipTestID?: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <AgentLogo runner={props.runner} size={20} />
      <Text role="header" testID={props.labelTestID} class="text-[14px] font-semibold text-ink">
        {props.title}
      </Text>
      <HelpTip text={props.tip} label={props.tipLabel} testID={props.tipTestID} />
    </View>
  );
}

/** `.agent-note`: grey, small. */
export function AgentNote(props: { testID?: string; children?: JSX.Element }) {
  return (
    <Text testID={props.testID} class="text-[12px] leading-[1.45] text-ink-muted">
      {props.children}
    </Text>
  );
}

/** `.agent-warn`: in the ink colour. */
export function AgentWarn(props: { testID?: string; children?: JSX.Element }) {
  return (
    <Text testID={props.testID} class="text-[12px] leading-[1.45] text-ink">
      {props.children}
    </Text>
  );
}

/** `.agent-error`: our words in the danger colour, the daemon's own (naming the Bots in the way) under them. */
export function AgentError(props: { testID?: string; text: string; detail?: string | null }) {
  return (
    <View role="alert" testID={props.testID} class="flex-col gap-[2px]">
      <Text class="text-[12px] leading-[1.45] text-danger-text">{props.text}</Text>
      <If when={props.detail}>{(detail) => <Text class="text-[12px] leading-[1.45] text-ink-muted">{detail()}</Text>}</If>
    </View>
  );
}

/** A `dl`'s pair: the muted name, then its value, in a row that wraps. */
export function Fact(props: { label: string; testID?: string; children?: JSX.Element }) {
  return (
    <View class="flex-row gap-3 min-w-0">
      <View class="w-[72px]">
        <Text class="text-[12px] text-ink-muted">{props.label}</Text>
      </View>
      <View testID={props.testID} class="flex-1 min-w-0 flex-row flex-wrap items-center gap-x-[6px]">
        {props.children}
      </View>
    </View>
  );
}

/** A `dd`'s plain words; `bold` is an account's name (13px, 600), `muted` / `size` the grey small print. */
export function FactText(props: { bold?: boolean; muted?: boolean; size?: number; children?: JSX.Element }) {
  return (
    <Text
      class={`leading-[1.45] ${props.muted ? "text-ink-muted" : "text-ink"} ${props.bold ? "font-semibold" : ""}`}
      style={{ fontSize: props.size ?? (props.bold ? 13 : 12) }}
    >
      {props.children}
    </Text>
  );
}

/** `<code>`: mono. `muted` is the grey one under an account's name. */
export function Code(props: { size?: number; muted?: boolean; children?: JSX.Element }) {
  return (
    <Text class={`font-mono ${props.muted ? "text-ink-muted" : "text-ink"}`} style={{ fontSize: props.size ?? 12 }}>
      {props.children}
    </Text>
  );
}

/** The grey "· where it came from" after a path or a proxy. */
export function Source(props: { text: string }) {
  return <Text class="text-[12px] text-ink-muted">{`· ${props.text}`}</Text>;
}

/** The block of one account (or one custom agent): the line-subtle ground its name, directory and usage sit on. */
export function AccountBox(props: { label: string; testID?: string; gap?: number; children?: JSX.Element }) {
  return (
    <View
      role="region"
      accessibilityLabel={props.label}
      testID={props.testID}
      class="flex-col min-w-0 px-[10px] pt-2 pb-[10px] rounded-(--radius-md) bg-line-subtle"
      style={{ gap: props.gap ?? 8 }}
    >
      {props.children}
    </View>
  );
}

/** The heading of a card's account list. */
export function AccountsHeading(props: { title: string; tip: string; tipLabel: string }) {
  return (
    <View class="flex-row items-center gap-[6px]">
      <Text role="header" class="text-[12px] font-semibold text-ink-muted">
        {props.title}
      </Text>
      <HelpTip text={props.tip} label={props.tipLabel} />
    </View>
  );
}

/** The single-line field of the cards, `font-size: 12px`. */
export function AgentInput(props: {
  value: string;
  placeholder: string;
  testID?: string;
  disabled?: boolean;
  mono?: boolean;
  multiline?: boolean;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  class?: string;
}) {
  return (
    <Input
      testID={props.testID}
      accessibilityLabel={props.placeholder}
      placeholder={props.placeholder}
      value={props.value}
      readonly={props.disabled}
      autoCorrect={false}
      autoCapitalize="none"
      multiline={props.multiline}
      submitBehavior={props.multiline ? "newline" : "submit"}
      onChange={(e) => props.onChange(e.value)}
      onSubmit={() => props.onSubmit?.()}
      class={`min-w-0 px-[10px] ${props.multiline ? "py-2 min-h-[64px]" : narrowWindow() ? "h-11" : "h-[30px]"} border border-line rounded-(--radius-sm) bg-input-bg text-ink text-[12px] focus:border-field-focus-border ${props.mono ? "font-mono" : ""} ${props.disabled ? "opacity-[0.6]" : ""} ${props.class ?? ""}`}
    />
  );
}

/** `.btn-xs.btn-quiet`: as small as `.btn-xs`, without its frame. */
export function QuietButton(props: { label: string; testID?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`items-center justify-center rounded-(--radius-sm) hover:bg-line-subtle disabled:opacity-[0.4] ${narrowWindow() ? "min-h-11 px-3" : "px-2 py-[3px]"}`}
    >
      <Text class={`${narrowWindow() ? "text-[13px]" : "text-[11px]"} font-medium text-ink-secondary`}>{props.label}</Text>
    </View>
  );
}

/** `.agent-path` / `.agent-actions`: a row that wraps. */
export function WrapRow(props: { gap?: number; testID?: string; children?: JSX.Element }) {
  return (
    <View testID={props.testID} class="flex-row flex-wrap items-center" style={{ gap: props.gap ?? 8 }}>
      {props.children}
    </View>
  );
}
