/**
 * The inspector for one of the app's own calls (ADR 0083): what it concluded, which model ran it,
 * how long it took, the model's raw answer, and — where the host offers it — the call's own
 * settings to change in place. The host places it beside the board, or over the board's bottom as
 * a sheet on a narrow job.
 *
 * The raw answer's JSON unfolds as a tree, as `svelte-json-discovery` drew it; the tree here is a
 * small one of this file's own (`JsonTree`), not that library.
 */
import { Scroll, Text, View, effect, signal, token, type JSX, type ScrollRef } from "nsh";
import type { BuiltinModelRole, CallRun, TraceStep } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import { answerJson, stepSaid, stepTitle, type TraceStepGroup } from "../../m/overlays/trace-steps.ts";
import { Icon } from "../Icon";
import { tip } from "../tip";

/** A JSON value as a tree: the first two levels open, the rest a press away. */
function JsonTree(props: { name?: string; value: unknown; depth: number }) {
  const value = () => props.value;
  const isNode = () => value() !== null && typeof value() === "object";
  const open = signal(props.depth < 2);
  const entries = () => (isNode() ? Object.entries(value() as Record<string, unknown>) : []);
  const label = () => (props.name === undefined ? "" : `${props.name}: `);
  const summary = () => (Array.isArray(value()) ? `[${entries().length}]` : `{${entries().length}}`);
  return (
    <If
      when={isNode()}
      else={
        <Text class="text-[11px] leading-[16px] font-mono text-ink">
          {label()}
          <Text class={typeof value() === "string" ? "text-ok-text" : "text-brand"}>{typeof value() === "string" ? JSON.stringify(value()) : String(value())}</Text>
        </Text>
      }
    >
      <View>
        <View role="button" onPress={() => open.set(!open())} accessibilityState={{ expanded: open() }} class="flex-row items-center gap-[2px]">
          <View style={{ transform: open() ? "rotate(90deg)" : "none" }}>
            <Icon name="chevron-right" size={12} />
          </View>
          <Text class="text-[11px] leading-[16px] font-mono text-ink">
            {label()}
            <Text class="text-ink-muted">{summary()}</Text>
          </Text>
        </View>
        <If when={open()}>
          <View class="pl-[12px]">
            <Each of={entries()} key={(entry: [string, unknown]) => entry[0]}>
              {(entry: () => [string, unknown]) => <JsonTree name={entry()[0]} value={entry()[1]} depth={props.depth + 1} />}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}

function Chip(props: { text: string; tip?: string; mono?: boolean; testID?: string }) {
  return (
    <View testID={props.testID} tooltip={props.tip ? tip(props.tip) : undefined} class="px-[6px] border border-line rounded-(--radius-sm) bg-chip" style={{ maxWidth: "100%" }}>
      <Text class={`text-[11px] text-ink-muted line-clamp-1 ${props.mono ? "font-mono" : ""}`}>{props.text}</Text>
    </View>
  );
}

function Link(props: { testID: string; pressed?: boolean; onPress: () => void; children: JSX.Element }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityState={props.pressed === undefined ? undefined : { expanded: props.pressed }}
      onPress={props.onPress}
      class="px-[8px] py-[3px] border border-line rounded-(--radius-sm) hover:bg-accent-tint"
    >
      <Text class="text-[11px] text-brand">{props.children}</Text>
    </View>
  );
}

export function TraceStepDetail(props: {
  group: TraceStepGroup;
  /** The whole use, the model's answer included; absent where nothing can fetch it. */
  fetchRun?: (id: string) => Promise<CallRun>;
  onJump: (sessionId: string, messageId: string) => void;
  /** The call itself — its model and prompts — to change here; the host renders it. */
  callEditor?: (role: BuiltinModelRole) => JSX.Element;
  onClose: () => void;
}) {
  const t = () => copy();
  /** The call's settings unfolded under the step; they stay unfolded from step to step. */
  const editing = signal(false);
  let scroll: ScrollRef | null = null;

  /** Which use is shown, when the step stands for several; the newest to start with. */
  const picked = signal<string | null>(null);
  const step = (): TraceStep => props.group.steps.find((row) => row.id === picked()) ?? props.group.steps.at(-1)!;
  /**
   * Whether the step made one of the app's model calls whose settings can be changed here: not a
   * step of your own that judged by a rule or a command (ADR 0105), which asked no model anything.
   */
  const customRun = () => {
    const verdict = step().verdict;
    return verdict?.kind === "custom_step" ? verdict.run : null;
  };
  const madeCall = () => customRun() === null || customRun() === "model";

  /** Open from the start: the panel has the room. Folded, it stays folded from step to step. */
  const rawOpen = signal(true);
  const raw = signal<{ id: string; text: string | null } | null>(null);
  const rawFailed = signal(false);
  effect(() => {
    const id = step().id;
    if (!rawOpen() || !props.fetchRun || raw()?.id === id) return;
    rawFailed.set(false);
    props.fetchRun(id).then(
      (run) => {
        if (step().id === id) raw.set({ id, text: run.raw });
      },
      () => {
        if (step().id === id) rawFailed.set(true);
      },
    );
  });
  /** A JSON answer unfolds as a tree. */
  const rawJson = () => {
    const text = raw()?.text;
    return text ? answerJson(text) : null;
  };

  return (
    <View testID="trace-step-detail" accessibilityLabel={stepTitle(step(), t())} class="flex-1 min-h-0 bg-pane">
      <Scroll ref={(node: ScrollRef) => (scroll = node)} class="flex-1 min-h-0">
        <View class="gap-[6px] px-[12px] pt-[10px] pb-[10px]">
          <View class="flex-row items-center gap-[6px]">
            <Text class="flex-1 min-w-0 text-[12px] font-semibold text-ink">{stepTitle(step(), t())}</Text>
            <Text tooltip={tip(formatFullTimestamp(step().created_at))} class="text-[11px] text-ink-muted font-mono">{formatMessageTime(step().created_at)}</Text>
            <View
              role="button"
              testID="trace-step-close"
              accessibilityLabel={t().traceSteps.close}
              tooltip={tip(t().traceSteps.close)}
              onPress={props.onClose}
              class="w-[20px] h-[20px] items-center justify-center rounded-(--radius-sm) hover:bg-line-subtle"
            >
              <Icon name="x" size={12} />
            </View>
          </View>
          <If when={props.group.steps.length > 1}>
            <View class="flex-row flex-wrap gap-[4px]" role="tablist">
              <Each of={props.group.steps} key={(use: TraceStep) => use.id}>
                {(use: () => TraceStep, index: () => number) => (
                  <View
                    role="tab"
                    testID={`trace-step-use-${index() + 1}`}
                    accessibilityState={{ selected: use().id === step().id }}
                    tooltip={tip(t().traceSteps.useOf(index() + 1, props.group.steps.length))}
                    onPress={() => picked.set(use().id)}
                    class={`min-w-[22px] items-center px-[6px] border rounded-(--radius-sm) ${
                      use().id === step().id ? "border-brand" : use().outcome !== "ok" ? "border-warn" : "border-line"
                    }`}
                  >
                    <Text class={`text-[11px] ${use().id === step().id ? "text-ink" : "text-ink-muted"}`}>{String(index() + 1)}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <Text testID="trace-step-said" class="text-[12px] leading-[17px] text-ink">{stepSaid(step(), t())}</Text>
          <If when={step().custom_step}>
            {/* A step of your own (ADR 0105): which moment it ran at. */}
            {(own: () => NonNullable<TraceStep["custom_step"]>) => (
              <Text testID="trace-step-moment" class="text-[11px] text-ink-muted">
                {t().playbooks.own.runAt((t().playbooks.own.moments as Record<string, string>)[own().at] ?? own().at)}
              </Text>
            )}
          </If>
          <If when={step().outcome !== "ok" && step().verdict}>
            <Text class="text-[12px] text-warn-text">{t().traceSteps.failed(step().fail_kind)}</Text>
          </If>
          <View class="flex-row flex-wrap gap-[4px]">
            <If when={step().model}>
              <Chip mono text={step().model!} tip={t().traceSteps.model} />
            </If>
            <If when={step().thinking_level}>
              <Chip text={`${t().traceSteps.thinking} ${step().thinking_level}`} tip={t().traceSteps.thinking} />
            </If>
            <If when={step().prompt_id}>
              <Chip text={`${t().traceSteps.prompt} · ${step().prompt_revision ? t().traceSteps.promptEdited : t().traceSteps.promptDefault}`} tip={step().prompt_id!} />
            </If>
            <If when={step().ms !== null}>
              <Chip mono text={t().traceSteps.took(step().ms!)} />
            </If>
            <If when={step().playbook_id}>
              {/* The engine it ran under, and how many times that engine had been changed then (ADR 0085). */}
              <Chip
                testID="trace-step-engine"
                text={t().playbooks.inForce((t().playbooks.builtin as Record<string, string>)[step().playbook_id!] ?? t().playbooks.custom, step().playbook_revision ?? 0)}
              />
            </If>
          </View>
          <If when={step().cached}>
            <Text class="text-[11px] text-ink-muted">{t().traceSteps.cached}</Text>
          </If>
          <If when={props.fetchRun && !step().cached}>
            <View>
              <View
                role="button"
                testID="trace-step-raw-toggle"
                accessibilityState={{ expanded: rawOpen() }}
                onPress={() => rawOpen.set(!rawOpen())}
                class="flex-row items-center gap-[2px]"
              >
                <View style={{ transform: rawOpen() ? "rotate(90deg)" : "none" }}>
                  <Icon name="chevron-right" size={12} />
                </View>
                <Text class="text-[11px] text-ink-muted">
                  {customRun() === "command" ? t().playbooks.own.commandOutput : t().traceSteps.raw}
                </Text>
              </View>
              <If when={rawOpen()}>
                <If
                  when={!rawFailed()}
                  else={<Text class="text-[11px] text-ink-muted">{t().traceSteps.rawFailed}</Text>}
                >
                  <If
                    when={raw()?.id === step().id}
                    else={<Text class="text-[11px] text-ink-muted">{t().traceSteps.rawLoading}</Text>}
                  >
                    <If
                      when={rawJson()}
                      else={
                        <If when={raw()?.text} else={<Text class="text-[11px] text-ink-muted">{t().traceSteps.rawNone}</Text>}>
                          <View testID="trace-step-raw" selectable class="mt-[4px] px-[8px] py-[6px] rounded-(--radius-sm) bg-chip">
                            <Text class="text-[11px] font-mono text-ink">{raw()?.text ?? ""}</Text>
                          </View>
                        </If>
                      }
                    >
                      {(json: () => object) => (
                        <View testID="trace-step-json" class="mt-[4px] px-[8px] py-[6px] rounded-(--radius-sm) bg-chip">
                          <JsonTree value={json()} depth={0} />
                        </View>
                      )}
                    </If>
                  </If>
                </If>
              </If>
            </View>
          </If>
          <View class="flex-row flex-wrap gap-[6px]">
            <If when={step().message_id && step().session_id}>
              <Link testID="trace-step-jump" onPress={() => props.onJump(step().session_id!, step().message_id!)}>{t().traceSteps.jump}</Link>
            </If>
            <If when={props.callEditor && madeCall()}>
              <Link testID="trace-step-edit" pressed={editing()} onPress={() => editing.set(!editing())}>
                {editing() ? t().traceSteps.editHide : t().traceSteps.edit}
              </Link>
            </If>
          </View>
          <If when={editing() && props.callEditor && madeCall()}>
            <View
              testID="trace-step-call"
              class="gap-[8px] pt-[10px] border-t border-line"
              // Unfolded, the panel scrolls to the call's settings, which load in after the press.
              onLayout={(e) => scroll?.scrollTo({ y: Math.max(0, e.bounds.origin.y - 10 + 0), animated: false })}
            >
              {/* Named here: on a narrow board the call's own card leaves its name to a page head. */}
              <Text class="text-[11px] text-ink-muted">
                {t().traceSteps.editNote(t().builtinModels.roles[step().role]?.name ?? step().role)}
              </Text>
              {props.callEditor!(step().role)}
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
