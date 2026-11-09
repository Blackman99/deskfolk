/**
 * The day's spend cap on the overview (ADR 0088; `SpendCap.svelte`): a USD amount, saved when you
 * leave the field or press Return, or cleared for none. Reaching it is the daemon's to notice; this
 * only sets it.
 */
import { effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { InputRef } from "nsh/types";
import type { SpendCopy } from "../../m/spend/spend-copy.ts";
import { narrowWindow } from "../Modal";
import { SURFACE } from "./spend-style";

export function SpendCap(props: {
  copy: SpendCopy;
  capUsd: number | null;
  /** Resolves to a refusal (an `ApiError`) or nothing. */
  onSetCap: (usd: number | null) => Promise<unknown>;
  /** The ledger is narrower than 620 points (its container query); defaults to a phone-sized window. */
  narrow?: boolean;
}) {
  const draft = signal("");
  const editing = signal(false);
  const saving = signal(false);
  const issue = signal<"failed" | "invalid" | null>(null);
  let input: InputRef | null = null;

  effect(() => {
    const cap = props.capUsd;
    if (!editing() && !saving()) draft.set(cap === null ? "" : String(cap));
  });

  async function save(value: number | null): Promise<void> {
    saving.set(true);
    issue.set(null);
    try {
      if (await props.onSetCap(value)) issue.set("failed");
    } catch {
      issue.set("failed");
    } finally {
      saving.set(false);
    }
  }

  /** Leaving the field (or Return) saves what is in it, once. */
  function commit(): void {
    if (!editing()) return;
    // Read before leaving: an effect here runs the moment `editing` changes, and would reset the draft.
    const raw = draft().trim();
    const cap = props.capUsd;
    editing.set(false);
    if (raw === "") {
      issue.set(null);
      if (cap !== null) void save(null);
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      issue.set("invalid");
      return;
    }
    issue.set(null);
    if (value !== cap) void save(value);
  }

  const narrow = () => props.narrow ?? narrowWindow();
  const hint = () => (issue() === "failed" ? props.copy.cap.failed : issue() === "invalid" ? props.copy.cap.invalid : props.copy.cap.hint);
  return (
    <View testID="spend-cap" role="region" accessibilityLabel={props.copy.cap.title} class={`${SURFACE} px-4 justify-center gap-2 ${narrow() ? "py-3" : "py-[14px]"}`}>
      <View class="flex-row items-center flex-wrap gap-3">
        <Text class="text-[12px] font-medium text-ink-muted">{props.copy.cap.title}</Text>
        <View
          class={`flex-row items-center gap-1 h-[32px] px-[10px] border rounded-(--radius-sm) bg-input-bg ${issue() === "invalid" ? "border-danger" : editing() ? "border-field-focus-border" : "border-line"}`}
        >
          <Text class="text-[13px] text-ink-muted" accessible={false}>
            $
          </Text>
          <Input
            testID="spend-cap-input"
            ref={(r: InputRef | null) => {
              input = r;
            }}
            value={draft()}
            accessibilityLabel={props.copy.cap.inputLabel}
            placeholder={props.copy.cap.off}
            keyboardType="decimal-pad"
            readonly={saving()}
            onFocus={() => editing.set(true)}
            onBlur={commit}
            onChange={(e) => {
              editing.set(true);
              draft.set(e.value);
            }}
            onSubmit={() => {
              input?.blur();
              commit();
            }}
            class="w-[88px] text-[14px] text-ink"
          />
        </View>
        <If when={props.capUsd !== null}>
          <View
            testID="spend-cap-clear"
            role="button"
            disabled={saving()}
            onPress={() => void save(null)}
            class="cursor-pointer select-none disabled:cursor-default items-center justify-center h-[32px] px-3 border border-line rounded-(--radius-sm) hover:bg-line-subtle hover:border-line-hover disabled:opacity-[0.5]"
          >
            <Text class="text-[13px] text-ink">{props.copy.cap.clear}</Text>
          </View>
        </If>
      </View>
      <Text testID="spend-cap-hint" class={`text-[11.5px] leading-[17px] ${issue() !== null ? "text-danger-text" : "text-ink-muted"}`}>
        {hint()}
      </Text>
    </View>
  );
}
