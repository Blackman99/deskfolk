/**
 * The form that adds or edits one acceptance check (`overlays/AcceptanceCheckForm.svelte`): which line
 * of the plan it proves, what kind of check it is, and that kind's own fields. Saving goes to the
 * daemon and the plan comes back whole.
 */
import { signal, Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import type { AcceptanceCheck, TaskDetail } from "@real-bot/protocol";
import {
  draftFromCheck,
  draftToInput,
  emptyDraft,
  type CheckDraft,
  type CheckDraftErrors,
  type EditableCheckKind,
} from "../../m/overlays/acceptance-checks.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { narrowWindow } from "../Modal";
import { Select } from "../Select";

const KINDS: readonly EditableCheckKind[] = ["exists", "contains", "matches", "command", "continuity"];

function errorField(err: unknown, key: "status" | "code" | "message"): unknown {
  return err && typeof err === "object" && key in err ? (err as Record<string, unknown>)[key] : undefined;
}

function Field(props: { label: string; narrow?: boolean; hint?: string; error?: string | false; children?: JSX.Element }) {
  return (
    <View class={`gap-1 min-w-0 ${props.narrow && !narrowWindow() ? "max-w-[160px]" : ""}`}>
      <Text class="text-[11px] font-semibold text-ink-muted">{props.label}</Text>
      {props.children}
      <If when={props.hint}>
        <Text class="text-[11px] text-ink-muted">{props.hint}</Text>
      </If>
      <If when={props.error}>
        <Text class="text-[12px] font-medium leading-[1.4] text-warn-text">{props.error}</Text>
      </If>
    </View>
  );
}

export function AcceptanceCheckForm(props: {
  api: MessengerApi;
  detail: TaskDetail;
  /** Null creates a fresh check; a check edits it (always lands as source `user`). */
  editing: AcceptanceCheck | null;
  /** The acceptance line to preselect when creating fresh. Ignored while editing. */
  initialItem?: string;
  onSaved: (detail: TaskDetail) => void;
  onCancel: () => void;
}) {
  const t = () => copy().plan.checks;
  const draft = signal<CheckDraft>(props.editing ? draftFromCheck(props.editing) : emptyDraft(props.detail, props.initialItem ?? ""));
  const errors = signal<CheckDraftErrors>({});
  const saving = signal(false);
  const saveError = signal<string | null>(null);
  const expectOpen = signal(Boolean(draft().expectStdout));
  const set = (patch: Partial<CheckDraft>) => draft.set({ ...draft(), ...patch });

  /** The plan's own acceptance lines, plus the line being edited when it no longer matches any of them. */
  const itemOptions = () => {
    const lines = props.detail.spec?.acceptance ?? [];
    if (props.editing && !lines.includes(props.editing.item)) return [props.editing.item, ...lines];
    return lines;
  };

  const kindLabel = (kind: EditableCheckKind) =>
    kind === "exists" ? t().kindExists : kind === "contains" ? t().kindContains : kind === "matches" ? t().kindMatches : kind === "continuity" ? t().kindContinuity : t().kindCommand;

  function selectKind(kind: EditableCheckKind): void {
    if (saving()) return;
    set({ kind });
    errors.set({});
  }

  async function submit(): Promise<void> {
    if (saving()) return;
    const planned = draftToInput(draft());
    errors.set(planned.errors);
    if (!planned.input) return;
    saving.set(true);
    saveError.set(null);
    try {
      const editing = props.editing;
      const result = editing
        ? await props.api.patchCheck(editing.id, { ...planned.input, if_revision: editing.updated_at })
        : await props.api.createCheck(props.detail.id, planned.input);
      props.onSaved(result);
    } catch (err) {
      const status = errorField(err, "status");
      const code = errorField(err, "code");
      const message = errorField(err, "message");
      if (status === 409) saveError.set(t().checkGone);
      else if (code === "outside_workspace") saveError.set(t().outsideWorkspace);
      else if (code === "too_many_checks") saveError.set(t().tooManyChecks);
      else if (status === 422) saveError.set(typeof message === "string" ? message : t().createFailed);
      else saveError.set(t().createFailed);
    } finally {
      saving.set(false);
    }
  }

  const fieldClass = () =>
    `w-full rounded-(--radius-sm) border border-line bg-input-bg text-ink focus:border-field-focus-border ${narrowWindow() ? "px-[10px] py-2 text-[14px]" : "px-2 py-[6px] text-[13px]"}`;
  const text = (id: string, key: "path" | "pattern" | "command" | "cwd" | "expectExit" | "timeoutSec", opts: { mono?: boolean; placeholder?: string; numeric?: boolean } = {}) => (
    <Input
      testID={`check-form-${id}`}
      value={draft()[key]}
      onChange={(e) => set({ [key]: e.value } as Partial<CheckDraft>)}
      readonly={saving()}
      placeholder={opts.placeholder}
      keyboardType={opts.numeric ? "numeric" : undefined}
      autoCorrect={false}
      autoCapitalize="none"
      class={`${fieldClass()} ${opts.mono ? "font-mono" : ""}`}
    />
  );
  const kind = () => draft().kind;

  return (
    <View testID="check-form" class="gap-2 p-[10px] border border-dashed border-line-hover rounded-(--radius-md) bg-pane">
      <Field label={t().itemLabel} error={errors().item && t().itemRequired}>
        <Select
          testID="check-form-item"
          value={draft().item}
          options={itemOptions()}
          disabled={saving()}
          onChange={(item) => set({ item })}
          ariaLabel={t().itemLabel}
        />
      </Field>

      <View accessibilityLabel={t().itemLabel} class="flex-row flex-wrap gap-[5px]">
        <Each of={KINDS}>
          {(k) => (
            <View
              role="button"
              testID={`check-kind-${k()}`}
              accessibilityState={{ selected: kind() === k() }}
              disabled={saving()}
              onPress={() => selectKind(k())}
              class={`cursor-pointer select-none disabled:cursor-default group rounded-full border px-[10px] disabled:opacity-60 ${narrowWindow() ? "min-h-[36px] py-[6px] justify-center" : "py-[5px]"} ${
                kind() === k() ? "bg-brand border-brand" : "bg-chip border-line hover:border-accent-border"
              }`}
            >
              <Text class={`text-[12px] font-medium ${kind() === k() ? "text-on-accent" : "text-ink-secondary group-hover:text-brand"}`}>
                {kindLabel(k())}
              </Text>
            </View>
          )}
        </Each>
      </View>

      <If when={kind() === "exists" || kind() === "contains" || kind() === "matches"}>
        <Field label={t().pathLabel} error={errors().path && t().pathRequired}>
          {text("path", "path")}
        </Field>
      </If>

      <If when={kind() === "contains" || kind() === "matches"}>
        <Field label={kind() === "matches" ? t().patternLabelRegex : t().patternLabel} error={errors().pattern && t().patternRequired}>
          {text("pattern", "pattern")}
        </Field>
        <Checkbox
          testID="check-form-negate"
          checked={draft().negate}
          disabled={saving()}
          onChange={(negate) => set({ negate })}
          label={kind() === "matches" ? t().negateMatches : t().negateContains}
        />
      </If>

      <If when={kind() === "command"}>
        <Field label={t().commandLabel} error={errors().command && t().commandRequired}>
          {text("command", "command", { mono: true })}
        </Field>
        <Field label={t().cwdLabel}>{text("cwd", "cwd", { mono: true, placeholder: t().cwdPlaceholder })}</Field>
        <Field label={t().expectExitLabel} narrow error={errors().expectExit && t().expectExitInvalid}>
          {text("expect-exit", "expectExit", { mono: true, numeric: true })}
        </Field>
        <View
          role="button"
          testID="check-form-expect-toggle"
          accessibilityState={{ expanded: expectOpen() }}
          onPress={() => expectOpen.set(!expectOpen())}
          class="cursor-pointer select-none self-start py-[2px]"
        >
          <Text class="text-[12px] font-medium text-brand">{`${expectOpen() ? "▾" : "▸"} ${t().expectStdoutToggle}`}</Text>
        </View>
        <If when={expectOpen()}>
          <Field label={t().expectStdoutLabel} hint={t().expectStdoutHint}>
            <Input
              testID="check-form-expect-stdout"
              multiline
              value={draft().expectStdout}
              onChange={(e) => set({ expectStdout: e.value })}
              readonly={saving()}
              autoCorrect={false}
              autoCapitalize="none"
              class={`${fieldClass()} min-h-[52px] font-mono`}
            />
          </Field>
        </If>
        <Field label={t().timeoutLabel} narrow error={errors().timeoutSec && t().timeoutInvalid}>
          {text("timeout", "timeoutSec", { mono: true, numeric: true })}
        </Field>
      </If>

      <If when={kind() === "continuity"}>
        <Field label={t().continuityPathLabel}>{text("path", "path", { mono: true })}</Field>
        <Field label={t().continuityCommandLabel}>{text("command", "command", { mono: true })}</Field>
        <Field label={t().cwdLabel}>{text("cwd", "cwd", { mono: true, placeholder: t().cwdPlaceholder })}</Field>
        <If when={errors().pathOrCommand}>
          <Text class="text-[12px] font-medium leading-[1.4] text-warn-text">{t().pathOrCommandRequired}</Text>
        </If>
      </If>

      <If when={saveError()}>
        {(message: () => string) => <Text testID="check-form-error" class="text-[12px] font-medium leading-[1.4] text-warn-text">{message()}</Text>}
      </If>

      <View class="flex-row gap-[6px]">
        <Button testID="check-form-save" variant="primary" size="sm" disabled={saving()} onPress={() => void submit()}>
          {copy().plan.save}
        </Button>
        <Button testID="check-form-cancel" size="sm" disabled={saving()} onPress={props.onCancel}>
          {copy().plan.cancel}
        </Button>
      </View>
    </View>
  );
}
