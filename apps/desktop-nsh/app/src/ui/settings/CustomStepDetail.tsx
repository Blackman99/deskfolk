/**
 * One step of your own in an engine on Roles (`settings/CustomStepDetail.svelte`, ADR 0105): when it
 * runs, which calls or files it looks at, how it judges and what a "no" does. A new step is a draft —
 * held here, not saved — until Save sends the engine's whole difference with it added; a saved one
 * is edited in place and Save sends the difference again. The daemon checks it all and its refusal
 * is shown as it said it. Try judges the step as it stands on a sample, and applies nothing.
 *
 * Props: `step` (as saved, or the draft); `draft`; `running`; `playbook`; `engineName`; `api`;
 * `onsave(diff)` (resolves to the saved engine, or null); `oncancel`; `ondone('saved' | 'deleted')`;
 * `saving`; `error`; `message` (what the daemon said when it refused); `call` (the model step's
 * call panel). Test ids: `custom-step-<id>`, `custom-name`, `custom-switch`, `custom-not-running`,
 * `custom-before-note`, `custom-tool-<tool>`, `custom-paths`, `custom-kind-<kind>`, `custom-command`,
 * `custom-folder`, `custom-timeout`, `custom-prompt`, `custom-then-hint`, `custom-sample-command`,
 * `custom-sample-reply`, `custom-sample-paths`, `custom-try`, `custom-result-<outcome>`,
 * `custom-result-reason`, `custom-result-output`, `custom-result-sample`, `custom-error`,
 * `custom-save`, `custom-cancel`, `custom-delete`. The two Selects are `custom-moment` and `custom-then`.
 */
import {
  CUSTOM_STEP_ATS,
  CUSTOM_STEP_CALL_ATS,
  CUSTOM_STEP_COMMAND_MAX,
  CUSTOM_STEP_NAME_MAX,
  CUSTOM_STEP_PROMPT_MAX,
  CUSTOM_STEP_RUN_KINDS,
  CUSTOM_STEP_THENS_AT,
  CUSTOM_STEP_TOOLS,
  customStepTimeout,
  type CustomStep,
  type CustomStepAt,
  type CustomStepRunKind,
  type CustomStepThen,
  type CustomStepTool,
  type CustomStepTry,
  type Playbook,
  type PlaybookDiff,
} from "@real-bot/protocol";
import { effect, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { copy } from "../../runtime";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { cleanStep, diffWithStep, diffWithout, plainStep, sampleOf, stepProblem, withMoment, withPaths, withRunKind, withTool } from "../../m/settings/custom-step-form.ts";
import type { PlaybookSaveError } from "../../m/settings/playbooks.svelte.ts";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { narrowWindow } from "../Modal";
import { DangerDialog } from "../overlays/DangerDialog";
import { Select } from "../Select";
import { Switch } from "../Switch";

/** The "any tool" option of the Try Select: a Select has no empty value of its own. */
const ANY = "__any";

const NOTE = "text-[11px] leading-[1.45] text-ink-muted";
const LABEL = "text-[12px] font-semibold text-ink-secondary";
const PART = "gap-[10px] pt-3 border-t border-line min-w-0";
const FIELD = "w-full px-2 py-[5px] text-[12px] text-ink bg-input-bg border border-line rounded-(--radius-sm) focus:border-field-focus-border";

export function CustomStepDetail(props: {
  /** The step as saved, or the draft. */
  step: CustomStep;
  /** Not saved yet: Save adds it, and there is no Delete but a way out. */
  draft?: boolean;
  /** Whether the engine runs it; false where its moment never comes. Only a saved step has it. */
  running?: boolean;
  playbook: Playbook;
  engineName: string;
  api: MessengerApi | null;
  onsave: (diff: PlaybookDiff) => Promise<unknown>;
  oncancel?: () => void;
  ondone?: (what: "saved" | "deleted") => void;
  saving: boolean;
  error: PlaybookSaveError | null;
  /** What the daemon said when it refused the difference. */
  message?: string | null;
  /** The model and frame prompt of the call a model step makes. */
  call?: JSX.Element;
}) {
  const c = () => copy().playbooks.own;
  const own = () => props.playbook.custom_steps ?? [];
  const isDraft = () => props.draft === true;

  /** What is being edited; another step, or another engine, starts it over. */
  const form = signal<CustomStep>(plainStep(props.step));
  const commandText = signal(props.step.run.kind === "command" ? props.step.run.command : "");
  const promptText = signal(props.step.run.kind === "model" ? props.step.run.prompt : "");
  const pathsText = signal((props.step.match?.paths ?? []).join("\n"));
  const timeoutText = signal("");
  const tried = signal(false);
  const problem = signal<string | null>(null);
  const confirming = signal(false);
  const sampleTool = signal<CustomStepTool | "">("");
  const sampleCommand = signal("");
  const samplePaths = signal("");
  const sampleReply = signal("");
  const trying = signal(false);
  const tryResult = signal<CustomStepTry | null>(null);
  const tryFailed = signal(false);

  let seeded = `${props.playbook.id}/${props.step.id}`;
  effect(() => {
    const key = `${props.playbook.id}/${props.step.id}`;
    if (key === seeded) return;
    seeded = key;
    untracked(() => {
      const step = props.step;
      form.set(plainStep(step));
      commandText.set(step.run.kind === "command" ? step.run.command : "");
      promptText.set(step.run.kind === "model" ? step.run.prompt : "");
      pathsText.set((step.match?.paths ?? []).join("\n"));
      tried.set(false);
      problem.set(null);
      confirming.set(false);
      sampleTool.set("");
      sampleCommand.set("");
      samplePaths.set("");
      sampleReply.set("");
      tryResult.set(null);
      tryFailed.set(false);
    });
  });

  const atCall = () => CUSTOM_STEP_CALL_ATS.includes(form().at);
  const range = () => customStepTimeout(form().at);
  const kind = (): CustomStepRunKind => form().run.kind;
  const commandRun = () => {
    const run = form().run;
    return run.kind === "command" ? run : null;
  };
  // The timeout field shows the step's own, or the range's default; kept as typed until it is left.
  effect(() => timeoutText.set(String(commandRun()?.timeout_s ?? range().default)));

  const shown = () => {
    const found = problem();
    if (found) return found;
    if (!tried()) return null;
    if (props.message) return c().rejected(props.message);
    if (props.error === "conflict") return copy().playbooks.conflict;
    if (props.error === "failed") return copy().playbooks.failed;
    return null;
  };

  const atOptions = () => CUSTOM_STEP_ATS.map((at) => ({ value: at as string, label: c().moments[at] }));
  const thenOptions = () => CUSTOM_STEP_THENS_AT[form().at].map((then) => ({ value: then as string, label: c().thens[then] }));
  const toolOptions = () => [{ value: ANY, label: c().tryAny }, ...CUSTOM_STEP_TOOLS.map((tool) => ({ value: tool as string, label: c().toolNames[tool] }))];

  function setMoment(at: string): void {
    form.set(withMoment(form(), at as CustomStepAt));
    tryResult.set(null);
  }

  const setThen = (then: string) => form.set({ ...form(), then: then as CustomStepThen });
  const setKind = (next: CustomStepRunKind) => form.set(withRunKind(form(), next, { command: commandText(), prompt: promptText() }));

  function setCommand(text: string): void {
    commandText.set(text);
    const run = commandRun();
    if (run) form.set({ ...form(), run: { ...run, command: text } });
  }

  function setPrompt(text: string): void {
    promptText.set(text);
    if (form().run.kind === "model") form.set({ ...form(), run: { kind: "model", prompt: text } });
  }

  function setFolder(text: string): void {
    const current = commandRun();
    if (!current) return;
    const { cwd: _cwd, ...run } = current;
    form.set({ ...form(), run: text ? { ...run, cwd: text } : run });
  }

  function setTimeout_(raw: string): void {
    const current = commandRun();
    if (!current) return;
    const { timeout_s: _t, ...run } = current;
    const value = Math.round(Number(raw));
    form.set({ ...form(), run: raw.trim() === "" || !Number.isFinite(value) ? run : { ...run, timeout_s: value } });
  }

  function setPaths(text: string): void {
    pathsText.set(text);
    form.set(withPaths(form(), text));
  }

  /** A saved step's switch is saved at once, as a built-in's is; a draft's waits for Save. */
  async function setOn(on: boolean): Promise<void> {
    form.set({ ...form(), on });
    if (isDraft()) return;
    tried.set(true);
    await props.onsave(diffWithStep(props.playbook.diff, own(), { ...plainStep(props.step), on }));
  }

  function check(): boolean {
    const found = stepProblem(form());
    problem.set(found ? c().problems[found]! : null);
    return found === null;
  }

  async function save(): Promise<void> {
    tried.set(true);
    if (!check()) return;
    const saved = await props.onsave(diffWithStep(props.playbook.diff, own(), form()));
    if (saved) {
      form.set(cleanStep(form()));
      props.ondone?.("saved");
    }
  }

  async function remove(): Promise<void> {
    confirming.set(false);
    tried.set(true);
    const saved = await props.onsave(diffWithout(props.playbook.diff, own(), props.step.id));
    if (saved) props.ondone?.("deleted");
  }

  async function runTry(): Promise<void> {
    tryFailed.set(false);
    tryResult.set(null);
    if (!check()) return;
    if (!props.api) {
      tryFailed.set(true);
      return;
    }
    trying.set(true);
    try {
      tryResult.set(
        await props.api.tryCustomStep(props.playbook.id, cleanStep(form()), sampleOf({ tool: sampleTool(), command: sampleCommand(), paths: samplePaths(), reply: sampleReply() })),
      );
    } catch {
      tryFailed.set(true);
    } finally {
      trying.set(false);
    }
  }

  /** A labelled field: its name over it, its note under it. */
  const field = (label: string, control: JSX.Element, note?: () => string | undefined, noteID?: string) => (
    <View class="gap-1 min-w-0">
      <Text class={LABEL}>{label}</Text>
      {control}
      <If when={note?.()}>
        <Text testID={noteID} class={NOTE}>{note?.()}</Text>
      </If>
    </View>
  );

  /** A several-line text field. */
  const area = (testID: string, label: string, rows: number, value: () => string, onChange: (value: string) => void, opts: { mono?: boolean; maxLength?: number; spell?: boolean } = {}) => (
    <Input
      testID={testID}
      multiline
      submitBehavior="newline"
      accessibilityLabel={label}
      maxLength={opts.maxLength}
      value={value()}
      onChange={(e) => onChange(e.value)}
      class={`${FIELD} leading-[1.5] ${opts.mono ? "font-mono" : ""}`}
      style={{ minHeight: rows * 18 + 10 }}
    />
  );

  const line = (testID: string, label: string, value: () => string, onChange: (value: string) => void, opts: { mono?: boolean; maxLength?: number } = {}) => (
    <Input testID={testID} accessibilityLabel={label} maxLength={opts.maxLength} value={value()} onChange={(e) => onChange(e.value)} class={`${FIELD} ${opts.mono ? "font-mono" : ""}`} />
  );

  return (
    <>
      <View
        role="region"
        testID={`custom-step-${props.step.id}`}
        accessibilityLabel={form().name || c().blankName}
        class={`gap-[14px] bg-pane border border-line rounded-(--radius-md) min-w-0 ${narrowWindow() ? "p-3" : "p-[14px]"}`}
      >
        <View class="gap-[3px]">
          <If when={!narrowWindow()}>
            <Text role="header" class="text-[14px] font-semibold text-ink">{form().name || c().blankName}</Text>
          </If>
          <Text class="text-[12px] leading-[1.45] text-ink-muted">{`${c().mineTitle} · ${props.engineName}${isDraft() ? ` · ${c().draft}` : ""}`}</Text>
        </View>

        <View testID="custom-part-what" class={PART}>
          {field(
            c().name,
            line("custom-name", c().name, () => form().name, (name) => form.set({ ...form(), name }), { maxLength: CUSTOM_STEP_NAME_MAX * 2 }),
            () => c().nameHint(CUSTOM_STEP_NAME_MAX),
          )}
          <View class="flex-row items-center gap-[10px]">
            <Switch testID="custom-switch" label={c().on} disabled={props.saving} checked={form().on} onChange={(on) => void setOn(on)} />
            <Text testID="custom-state" class="text-[12px] text-ink">{form().on ? c().on : copy().playbooks.off}</Text>
          </View>
          <If when={!isDraft() && form().on && props.running === false}>
            <Text testID="custom-not-running" class={NOTE}>{c().notRunning}</Text>
          </If>
        </View>

        <View testID="custom-part-moment" class={PART}>
          {field(
            c().moment,
            <Select testID="custom-moment" value={form().at} options={atOptions()} ariaLabel={c().moment} onChange={setMoment} />,
            () => c().momentHints[form().at],
          )}
          <If when={form().at === "before_effect"}>
            <Text testID="custom-before-note" class={NOTE}>{c().beforeNote}</Text>
          </If>
        </View>

        <View testID="custom-part-match" class={PART}>
          <Text role="header" class="text-[12px] font-semibold text-ink-secondary">{c().looksAt}</Text>
          <If when={atCall()}>
            {field(
              c().tools,
              <View class="flex-row flex-wrap gap-x-[14px] gap-y-1">
                {() =>
                  CUSTOM_STEP_TOOLS.map((tool) => (
                    <Checkbox
                      testID={`custom-tool-${tool}`}
                      label={c().toolNames[tool]}
                      checked={form().match?.tools?.includes(tool) ?? false}
                      onChange={(on) => form.set(withTool(form(), tool, on))}
                    />
                  ))
                }
              </View>,
              () => c().toolsHint,
            )}
          </If>
          {field(c().paths, area("custom-paths", c().paths, 3, pathsText, setPaths), () => `${c().pathsHint} ${c().pathsAt[form().at]}`)}
        </View>

        <View testID="custom-part-judges" class={PART}>
          <Text role="header" class="text-[12px] font-semibold text-ink-secondary">{c().judges}</Text>
          <View role="radiogroup" accessibilityLabel={c().judges} class="flex-row self-start p-[2px] bg-chip border border-line rounded-(--radius-sm)">
            {() =>
              CUSTOM_STEP_RUN_KINDS.map((one) => (
                <View
                  role="radio"
                  testID={`custom-kind-${one}`}
                  accessibilityLabel={c().kinds[one]}
                  accessibilityState={{ checked: kind() === one }}
                  onPress={() => setKind(one)}
                  class={`px-3 py-[3px] rounded-[4px] ${kind() === one ? "bg-pane" : ""}`}
                >
                  <Text class={`text-[12px] ${kind() === one ? "font-semibold text-ink" : "text-ink-secondary"}`}>{c().kinds[one]}</Text>
                </View>
              ))
            }
          </View>
          <Text class={NOTE}>{c().kindHints[kind()]}</Text>
          <If
            when={kind() === "command"}
            else={
              <If when={kind() === "model"}>
                {field(c().prompt, area("custom-prompt", c().prompt, 6, promptText, setPrompt, { maxLength: CUSTOM_STEP_PROMPT_MAX * 2 }), () => c().promptHint)}
                <Text class={NOTE}>{c().modelHint}</Text>
                {props.call}
              </If>
            }
          >
            {field(c().command, area("custom-command", c().command, 3, commandText, setCommand, { mono: true, maxLength: CUSTOM_STEP_COMMAND_MAX * 2 }), () => c().commandHint)}
            {field(c().folder, line("custom-folder", c().folder, () => commandRun()?.cwd ?? "", setFolder), () => c().folderHint)}
            <View class="flex-row items-center justify-between gap-[10px]">
              <Text class={LABEL}>{c().timeout}</Text>
              <View class="flex-row items-center gap-2">
                <Input
                  testID="custom-timeout"
                  keyboardType="numeric"
                  accessibilityLabel={c().timeout}
                  value={timeoutText()}
                  onChange={(e) => timeoutText.set(e.value)}
                  onSubmit={() => setTimeout_(timeoutText())}
                  onBlur={() => setTimeout_(timeoutText())}
                  class={`${FIELD} w-[76px] text-right`}
                />
                <Text class={NOTE}>{`${c().seconds} · ${c().timeoutRange(range().min, range().max)}`}</Text>
              </View>
            </View>
          </If>
        </View>

        <View testID="custom-part-then" class={PART}>
          {field(c().thenTitle, <Select testID="custom-then" value={form().then} options={thenOptions()} ariaLabel={c().thenTitle} onChange={setThen} />, () => c().thenHints[form().then], "custom-then-hint")}
        </View>

        <View testID="custom-part-try" class={PART}>
          <Text role="header" class="text-[12px] font-semibold text-ink-secondary">{c().tryTitle}</Text>
          <Text class={NOTE}>{c().tryHint}</Text>
          <If when={atCall()}>
            {field(
              c().tryTool,
              <Select testID="custom-sample-tool" value={sampleTool() || ANY} options={toolOptions()} ariaLabel={c().tryTool} onChange={(value) => sampleTool.set(value === ANY ? "" : (value as CustomStepTool))} />,
            )}
            <If when={sampleTool() === "shell" || sampleTool() === "mcp"}>
              {field(c().tryCommand, line("custom-sample-command", c().tryCommand, sampleCommand, (text) => sampleCommand.set(text), { mono: true }))}
            </If>
          </If>
          <If when={form().at === "turn_end"} else={field(c().tryPaths, area("custom-sample-paths", c().tryPaths, 2, samplePaths, (text) => samplePaths.set(text)))}>
            {field(c().tryReply, area("custom-sample-reply", c().tryReply, 3, sampleReply, (text) => sampleReply.set(text)))}
          </If>
          <View class="flex-row flex-wrap gap-2">
            <Button testID="custom-try" size="sm" disabled={trying()} onPress={() => void runTry()}>
              {trying() ? c().trying : c().tryRun}
            </Button>
          </View>
          <If when={tryFailed()}>
            <Text role="alert" class="text-[12px] text-danger-text">{c().tryFailed}</Text>
          </If>
          <If when={tryResult()}>
            {(result) => (
              <View testID={`custom-result-${result().outcome}`} class="gap-1 min-w-0">
                <Text class="text-[12px] font-semibold text-ink">{`${c().tryOutcome[result().outcome]}${result().exit_code !== null ? ` · ${c().tryExit(result().exit_code!)}` : ""}`}</Text>
                <If when={result().reason}>
                  <Text testID="custom-result-reason" class={NOTE}>{result().reason}</Text>
                </If>
                <If when={result().output}>
                  <Text class={LABEL}>{c().tryOutput}</Text>
                  <Scroll class="max-h-[200px] bg-chip border border-line rounded-(--radius-sm)">
                    <Text testID="custom-result-output" class="px-2 py-[6px] text-[11px] leading-[1.5] font-mono text-ink">{result().output}</Text>
                  </Scroll>
                </If>
                <If when={result().sample && Object.keys(result().sample).length > 0}>
                  <Text class={LABEL}>{c().tryUsed}</Text>
                  <Scroll class="max-h-[200px] bg-chip border border-line rounded-(--radius-sm)">
                    <Text testID="custom-result-sample" class="px-2 py-[6px] text-[11px] leading-[1.5] font-mono text-ink">{JSON.stringify(result().sample, null, 2)}</Text>
                  </Scroll>
                </If>
              </View>
            )}
          </If>
        </View>

        <View testID="custom-part-save" class={PART}>
          <If when={shown()}>
            <Text role="alert" testID="custom-error" class="text-[12px] text-danger-text">{shown()}</Text>
          </If>
          <View class="flex-row flex-wrap gap-2">
            <Button testID="custom-save" size="sm" variant="primary" disabled={props.saving} onPress={() => void save()}>
              {c().save}
            </Button>
            <If
              when={isDraft()}
              else={
                <Button testID="custom-delete" size="sm" variant="danger-soft" disabled={props.saving} onPress={() => confirming.set(true)}>
                  {c().delete}
                </Button>
              }
            >
              <Button testID="custom-cancel" size="sm" variant="ghost" disabled={props.saving} onPress={() => props.oncancel?.()}>
                {c().cancel}
              </Button>
            </If>
          </View>
        </View>
      </View>

      <If when={confirming()}>
        <DangerDialog
          copy={{ title: c().deleteTitle(props.step.name), body: c().deleteBody, confirm: c().confirmDelete, cancel: copy().playbooks.cancel }}
          onDismiss={() => confirming.set(false)}
          onConfirm={() => void remove()}
        />
      </If>
    </>
  );
}
