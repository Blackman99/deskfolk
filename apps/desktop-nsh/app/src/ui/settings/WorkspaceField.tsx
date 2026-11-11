/**
 * Anthropic's workspace id for a key not scoped to one (`settings/WorkspaceField.svelte`, ADR 0072):
 * a labelled monospace field that says as it is typed whether the id is well formed.
 *
 * Props: `id` (the field's `testID`; its label is `${id}-label`); `value`; `invalid` (the caller
 * refused a save for it); `onInput(value)`.
 */
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import { isWorkspaceId } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";

export function WorkspaceField(props: { id: string; value: string; invalid: boolean; onInput: (value: string) => void }) {
  const t = () => copy().connectors;
  /** Said as it is typed, not only when a save is refused. */
  const malformed = () => props.value.trim().length > 0 && !isWorkspaceId(props.value.trim());
  return (
    <View class="flex-col gap-[6px]">
      <View class="flex-row items-center justify-between mb-[2px]">
        <Text testID={`${props.id}-label`} class={`${narrowWindow() ? "text-[14px]" : "text-[13px]"} font-semibold text-ink-secondary`}>
          {t().workspace}
        </Text>
        <Text class="text-[11px] text-ink-muted">{t().workspaceOptional}</Text>
      </View>
      <Input
        testID={props.id}
        accessibilityLabel={t().workspace}
        value={props.value}
        onChange={(e) => props.onInput(e.value)}
        placeholder="wrkspc_…"
        autoCapitalize="none"
        autoCorrect={false}
        class={`w-full font-mono text-ink bg-input-bg border border-line rounded-(--radius-md) px-3 focus:border-field-focus-border ${narrowWindow() ? "min-h-12 text-[16px]" : "py-2 text-[14px]"}`}
      />
      <If
        when={props.invalid || malformed()}
        else={<Text testID={`${props.id}-hint`} class="mt-[6px] text-[12px] leading-[1.4] text-ink-muted">{t().workspaceHint}</Text>}
      >
        <Text testID={`${props.id}-error`} class="mt-[5px] text-[12px] font-medium leading-[1.4] text-warn-text">
          {t().workspaceInvalid}
        </Text>
      </If>
    </View>
  );
}
