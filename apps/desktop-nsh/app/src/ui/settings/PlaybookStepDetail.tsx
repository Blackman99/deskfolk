/**
 * One step of an engine on Roles (`settings/PlaybookStepDetail.svelte`, ADR 0085): what it does,
 * whether it runs in the engine shown and with what numbers — each change saved at once as that
 * engine's new difference from its built-in, the built-in's value beside one you changed — and, for
 * a step that makes one of the app's own calls, that call's model and prompts (`call`).
 *
 * Props: `step`; `playbook`; `builtin`; `engineName`; `onsave(diff)`; `onreset(step)`; `saving`;
 * `error`; `call` (the call's panel); `callHint`. Test ids: `playbook-step-<step>`,
 * `playbook-switch`, `playbook-param-<key>`, `playbook-reset`, `playbook-stopped-by`,
 * `playbook-held-on`, `playbook-also-stops`.
 */
import { PLAYBOOK_STEPS, playbookStep, stepsRequiring, stoppedBy, type Playbook, type PlaybookDiff, type PlaybookParamSpec, type PlaybookResolved, type PlaybookStepDiff, type PlaybookStepId } from "@real-bot/protocol";
import { effect, signal, Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { copy } from "../../runtime";
import { paramText, stepDiffers } from "../../m/settings/playbook-flow.ts";
import type { PlaybookSaveError } from "../../m/settings/playbooks.svelte.ts";
import { narrowWindow } from "../Modal";
import { Switch } from "../Switch";

/** One number of a step: committed when the field is left or Return is pressed, clamped to its range. */
function ParamRow(props: {
  param: PlaybookParamSpec;
  value: number;
  off: boolean;
  disabled: boolean;
  builtinValue: number;
  onCommit: (key: string, value: number) => void;
}) {
  const c = () => copy().playbooks;
  const text = signal(String(props.value));
  effect(() => text.set(String(props.value)));

  function commit(): void {
    const value = Math.round(Number(text()));
    if (text().trim() === "" || !Number.isFinite(value)) {
      text.set(String(props.value));
      return;
    }
    const clamped = Math.min(props.param.max, Math.max(props.param.min, value));
    text.set(String(clamped));
    if (clamped === props.value) return;
    props.onCommit(props.param.key, clamped);
  }

  return (
    <View testID={`playbook-param-row-${props.param.key}`} class={`gap-1 ${props.off ? "opacity-[0.6]" : ""}`}>
      <View class="flex-row items-center justify-between gap-[10px]">
        <Text class="flex-1 min-w-0 text-[12px] text-ink">{c().params[props.param.key]}</Text>
        <View class="flex-row items-center gap-[6px]">
          <Input
            testID={`playbook-param-${props.param.key}`}
            keyboardType="numeric"
            accessibilityLabel={c().params[props.param.key]}
            value={text()}
            disabled={props.disabled}
            onChange={(e) => text.set(e.value)}
            onSubmit={() => commit()}
            onBlur={() => commit()}
            class="w-[76px] px-2 py-1 text-[12px] text-right text-ink bg-input-bg border border-line rounded-(--radius-sm) focus:border-field-focus-border"
          />
          <If when={c().unit[props.param.unit]}>
            <Text class="text-[12px] text-ink-muted">{c().unit[props.param.unit]}</Text>
          </If>
        </View>
      </View>
      <If when={props.value !== props.builtinValue}>
        <Text class="text-[11px] text-ink-muted">{c().builtinValue(paramText(props.param, props.builtinValue, c().unit))}</Text>
      </If>
    </View>
  );
}

export function PlaybookStepDetail(props: {
  step: PlaybookStepId;
  playbook: Playbook;
  builtin: PlaybookResolved;
  engineName: string;
  onsave: (diff: PlaybookDiff) => void;
  onreset: (step: PlaybookStepId) => void;
  saving: boolean;
  error: PlaybookSaveError | null;
  /** The call's model and prompts, for a step that makes one. */
  call?: JSX.Element;
  /** What the call itself is for, beside what the step does. */
  callHint?: string | null;
}) {
  const c = () => copy().playbooks;
  const spec = () => playbookStep(props.step);
  const setting = () => props.playbook.resolved[props.step];
  const differs = () => stepDiffers(props.step, props.playbook.resolved, props.builtin);
  /** What stands in the way of this step running, when something does; its switch then has no say. */
  const stopper = () => stoppedBy(props.step, props.playbook.resolved);
  /** A step that another still on cannot do without: running, and no switch while that one is on. */
  const heldOnBy = () => {
    const held = spec().onWhile;
    return held && props.playbook.resolved[held].on ? held : null;
  };
  const dependents = () => stepsRequiring(props.step).map((id) => c().steps[id]!.name);

  /** The engine's difference with this step changed as asked; the rest of it kept. */
  function withStep(change: { on?: boolean; params?: Record<string, number> }): PlaybookDiff {
    const step = props.step;
    const diff = props.playbook.diff;
    const before = diff.steps[step] ?? {};
    const next = {
      ...before,
      ...(change.on === undefined ? {} : { on: change.on }),
      ...(change.params ? { params: { ...(before.params ?? {}), ...change.params } } : {}),
    };
    const steps: Partial<Record<PlaybookStepId, PlaybookStepDiff>> = { ...diff.steps, [step]: next };
    // Switched on, it takes back the step it cannot do without: a save would refuse that one left off.
    if (change.on) {
      for (const other of PLAYBOOK_STEPS) {
        if (other.onWhile !== step || steps[other.id]?.on !== false) continue;
        const { on: _off, ...rest } = steps[other.id]!;
        steps[other.id] = rest;
      }
    }
    return { ...diff, steps };
  }

  const partTitle = "text-[12px] font-semibold text-ink-secondary";
  const hint = "text-[12px] leading-[1.45] text-ink-muted";

  return (
    <View
      role="region"
      testID={`playbook-step-${props.step}`}
      accessibilityLabel={c().steps[props.step]!.name}
      class={`gap-[14px] bg-pane border border-line rounded-(--radius-md) min-w-0 ${narrowWindow() ? "p-3" : "p-[14px]"}`}
    >
      <View class="gap-[3px]">
        <If when={!narrowWindow()}>
          <Text role="header" class="text-[14px] font-semibold text-ink">{c().steps[props.step]!.name}</Text>
        </If>
        <Text class={hint}>{c().steps[props.step]!.hint}</Text>
        <If when={props.callHint}>
          <Text class={hint}>{props.callHint}</Text>
        </If>
      </View>

      <View testID="playbook-part-engine" class="gap-[10px] pt-3 border-t border-line min-w-0">
        <Text role="header" class={partTitle}>{`${c().runs} · ${props.engineName}`}</Text>
        <View class="flex-row flex-wrap items-center gap-[10px]">
          <If
            when={stopper()}
            else={
              <If
                when={heldOnBy()}
                else={
                  <If when={spec().switchable} else={<Text class="text-[12px] text-ink-muted">{c().locked}</Text>}>
                    <Switch
                      testID="playbook-switch"
                      label={c().steps[props.step]!.name}
                      disabled={props.saving}
                      checked={setting().on}
                      onChange={(on) => props.onsave(withStep({ on }))}
                    />
                    <Text testID="playbook-state" class="text-[12px] text-ink">{setting().on ? c().on : c().off}</Text>
                    <If when={setting().on !== props.builtin[props.step].on}>
                      <Text class="text-[11px] text-ink-muted">{c().builtinValue(props.builtin[props.step].on ? c().on : c().off)}</Text>
                    </If>
                  </If>
                }
              >
                <Text testID="playbook-held-on" class="text-[12px] text-ink-muted">{c().heldOn(c().steps[heldOnBy()!]!.name)}</Text>
              </If>
            }
          >
            <Text testID="playbook-stopped-by" class="text-[12px] text-ink-muted">{c().stoppedBy(c().steps[stopper()!]!.name)}</Text>
          </If>
        </View>
        <If when={dependents().length > 0}>
          <Text testID="playbook-also-stops" class={hint}>{c().alsoStops(dependents().join("、"))}</Text>
        </If>
        {() =>
          spec().params.map((param) => (
            <ParamRow
              param={param}
              value={setting().params[param.key]!}
              off={!setting().on}
              disabled={props.saving}
              builtinValue={props.builtin[props.step].params[param.key]!}
              onCommit={(key, value) => props.onsave(withStep({ params: { [key]: value } }))}
            />
          ))
        }
        <If when={differs()}>
          <View
            role="button"
            testID="playbook-reset"
            disabled={props.saving}
            onPress={() => props.onreset(props.step)}
            class="self-start group disabled:opacity-[0.5]"
          >
            <Text class="text-[12px] text-brand group-hover:underline">{c().resetStep}</Text>
          </View>
        </If>
        <If when={props.error}>
          <Text role="alert" class="text-[12px] text-danger-text">{props.error === "conflict" ? c().conflict : c().failed}</Text>
        </If>
      </View>

      {props.call}
    </View>
  );
}
