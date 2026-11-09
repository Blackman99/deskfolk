/**
 * The side column of the spec panel (`overlays/PlanSpecPanel.svelte`): the written progress inside
 * the overview card (blocked, open, done; done folds while anything is open), and the card about
 * the job: its name, kind, scale, the version of the spec and the history of versions.
 */
import { Text, View } from "nsh";
import type { PlanSpec } from "@real-bot/protocol";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import { specLines, type SpecListField } from "../../m/overlays/plan-board.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { actorLabel, fieldLabel, progressFieldsOf } from "./plan-spec-panel";
import { CountBadge } from "./plan-spec-guidelines";
import { EditBtn, ErrorLine, LinesBox, SaveCancel } from "./plan-spec-parts";
import { PlanNameBlock } from "./plan-spec-name";
import type { PlanSpecPanelProps, PlanSpecState } from "./plan-spec-state";

const DOT: Record<string, { mark: string; box: string }> = {
  "progress.done": { mark: "✓", box: "bg-ok-bg text-ok-text" },
  "progress.open": { mark: "●", box: "bg-accent-tint text-brand" },
  "progress.blocked": { mark: "!", box: "bg-danger-bg text-danger-text" },
};

function ProgressField(props: { panel: PlanSpecPanelProps; state: PlanSpecState; spec: PlanSpec; field: SpecListField }) {
  const t = () => copy().plan;
  const s = props.state;
  const field = props.field;
  const isBlocked = field === "progress.blocked";
  const isDone = field === "progress.done";
  const lines = () => specLines(props.spec, field);
  const folded = () => isDone && !s.doneShown() && s.editing() !== field && lines().length > 0;
  const bare = () => lines().length === 0 && s.editing() !== field;
  const alert = () => isBlocked && lines().length > 0;
  const head = () => (
    <>
      <View class={`items-center justify-center w-[14px] h-[14px] rounded-full ${DOT[field].box} ${bare() ? "opacity-[0.7]" : ""}`}>
        <Text class={`text-[9px] font-bold ${DOT[field].box.split(" ")[1]}`}>{DOT[field].mark}</Text>
      </View>
      <Text class={`shrink-0 text-[12px] font-semibold text-ink-muted ${bare() ? "opacity-[0.7]" : ""}`}>{fieldLabel(copy(), field)}</Text>
      <If when={lines().length > 0}>
        <CountBadge n={lines().length} />
      </If>
      <If when={bare()}>
        <Text class="text-[11px] italic text-ink-muted">{t().empty}</Text>
      </If>
    </>
  );
  return (
    <View
      testID={`plan-spec-list-${field}`}
      class={`min-w-0 ${
        alert() ? "my-[2px] px-[9px] py-2 border border-danger-line rounded-(--radius-sm) bg-danger-bg" : "py-2 border-t border-line-subtle"
      } ${bare() ? "py-[5px]" : ""}`}
    >
      <View class={`flex-row flex-wrap items-center justify-between gap-[6px] ${bare() || folded() ? "" : "mb-[7px]"}`}>
        <If
          when={isDone && lines().length > 0 && s.editing() !== field}
          else={<View class="flex-row items-center gap-[6px] min-w-0">{head()}</View>}
        >
          <View
            role="button"
            testID="plan-spec-fold-done"
            accessibilityState={{ expanded: s.doneShown() }}
            tooltip={tip(s.doneShown() ? t().spec.collapse : t().spec.expand)}
            onPress={() => s.doneOpen.set(!s.doneShown())}
            class="cursor-pointer select-none flex-row items-center gap-[6px] min-w-0"
          >
            {head()}
            <Icon name="chevron-down" size={12} class="tint-ink-muted" />
          </View>
        </If>
        <If when={props.panel.api && s.editing() !== field}>
          <EditBtn testID={`plan-spec-edit-${field}`} onPress={() => s.startEditField(field)} />
        </If>
      </View>
      <If
        when={s.editing() === field}
        else={
          <If when={lines().length > 0 && !folded()}>
            <View testID={`plan-spec-lines-view-${field}`} class="gap-1 pl-[2px]">
              <Each of={lines()}>
                {(line) => (
                  <View class="flex-row items-baseline gap-[6px] min-w-0">
                    <Text class={`text-[12px] leading-[1.45] ${isBlocked ? "text-danger-text" : "text-ink-muted"}`}>•</Text>
                    <Text class="shrink text-[12px] leading-[1.45] text-ink-secondary">{line()}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        }
      >
        <View class="gap-[6px]">
          <LinesBox state={s} testID={`plan-spec-lines-${field}`} />
          <SaveCancel state={s} testID={`plan-spec-${field}`} />
          <If when={s.saveError()}>
            <ErrorLine testID="plan-spec-error">{s.saveError() ?? ""}</ErrorLine>
          </If>
        </View>
      </If>
    </View>
  );
}

/** The written progress, one block per field, sorted so written ones come first. */
export function PlanProgress(props: { panel: PlanSpecPanelProps; state: PlanSpecState; spec: PlanSpec }) {
  return (
    <View testID="plan-spec-progress" class="mt-[2px]">
      <Each of={progressFieldsOf(props.spec)}>
        {(field) => <ProgressField panel={props.panel} state={props.state} spec={props.spec} field={field()} />}
      </Each>
    </View>
  );
}

function AboutLabel(props: { children: string }) {
  return <Text class="shrink-0 text-[11px] font-semibold text-ink-muted">{props.children}</Text>;
}

function History(props: { panel: PlanSpecPanelProps; state: PlanSpecState }) {
  const t = () => copy().plan;
  const s = props.state;
  return (
    <View testID="plan-spec-history" class="gap-[6px] pt-2 border-t border-line-subtle">
      <If
        when={!s.historyLoading()}
        else={<Text class="text-[12px] text-ink-muted">{`${t().history}…`}</Text>}
      >
        <If when={s.historyFailed()} else={
          <If when={s.history().length > 0} else={<Text testID="plan-spec-history-none" class="text-[12px] text-ink-muted">{t().historyNone}</Text>}>
            <View class="gap-2">
              <Each of={s.history()} key={(rev) => rev.id}>
                {(rev) => (
                  <View testID={`plan-spec-revision-${rev().revision}`} class="gap-1 px-[10px] py-2 rounded-(--radius-sm) bg-line-subtle">
                    <View class="flex-row flex-wrap items-center gap-[6px]">
                      <Text class="text-[11px] font-bold font-mono text-ink-secondary">{t().revision(rev().revision)}</Text>
                      <Text class={`text-[11px] ${rev().cause === "hold" ? "text-warn-text" : "text-ink-muted"}`}>
                        {actorLabel(copy(), rev().actor, rev().cause)}
                      </Text>
                      <View tooltip={tip(formatFullTimestamp(rev().created_at))}>
                        <Text class="text-[11px] text-ink-muted">{formatMessageTime(rev().created_at)}</Text>
                      </View>
                      <If when={rev().source_message_id && rev().session_id}>
                        <View
                          role="button"
                          testID={`plan-spec-revision-jump-${rev().revision}`}
                          onPress={() => props.panel.onJump(rev().session_id!, rev().source_message_id!)}
                          class="cursor-pointer select-none group flex-row items-center gap-[3px]"
                        >
                          <Icon name="arrow-up-right" size={12} class="tint-brand" />
                          <Text class="text-[11px] text-brand group-hover:underline">{t().jumpToMessage}</Text>
                        </View>
                      </If>
                    </View>
                    <Text class="text-[12px] text-ink">{rev().spec.goal}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        }>
          <ErrorLine>{t().saveFailed}</ErrorLine>
        </If>
      </If>
    </View>
  );
}

/** What the job is: its name, kind and scale, and the versions of this spec. */
export function PlanAbout(props: { panel: PlanSpecPanelProps; state: PlanSpecState }) {
  const t = () => copy().plan;
  const s = props.state;
  const detail = () => props.panel.detail;
  return (
    <View testID="plan-spec-about" class="gap-[10px] min-w-0 px-[14px] py-3 border border-line rounded-(--radius-md) bg-pane">
      <Text class="text-[12px] font-bold text-ink">{copy().trace.title}</Text>
      <PlanNameBlock panel={props.panel} state={s} />
      <If when={detail().kind}>
        <View class="flex-row items-center gap-2 min-w-0">
          <AboutLabel>{t().kind}</AboutLabel>
          <View class="shrink min-w-0 px-[7px] py-px rounded-full bg-chip">
            <Text testID="plan-spec-kind" class="text-[11px] font-medium text-ink-secondary">{detail().kind}</Text>
          </View>
        </View>
      </If>
      <View class="flex-row flex-wrap items-center justify-between gap-[6px]">
        <View class="flex-row flex-wrap items-center gap-[6px] min-w-0">
          <AboutLabel>{t().spec.version}</AboutLabel>
          <View class="px-[6px] py-px rounded-full bg-line-subtle">
            <Text testID="plan-spec-revision" class="text-[11px] font-semibold text-ink-muted">{t().revision(detail().revision)}</Text>
          </View>
          <Text testID="plan-spec-actor" class="text-[11px] text-ink-muted">{actorLabel(copy(), detail().revision_actor, detail().revision_cause)}</Text>
          <If when={detail().spec_updated_at}>
            {(at) => (
              <>
                <Text class="text-[11px] text-ink-muted">·</Text>
                <View tooltip={tip(formatFullTimestamp(at()))}>
                  <Text class="text-[11px] text-ink-muted">{formatMessageTime(at())}</Text>
                </View>
              </>
            )}
          </If>
        </View>
        <If when={props.panel.api}>
          <View
            role="button"
            testID="plan-spec-history-toggle"
            accessibilityState={{ expanded: s.historyOpen() }}
            onPress={() => void s.toggleHistory()}
            class="cursor-pointer select-none group flex-row items-center gap-1 shrink-0"
          >
            <Icon name="history" size={12} class="tint-ink-muted group-hover:tint-brand" />
            <Text class="text-[11px] font-medium text-ink-muted group-hover:text-brand">{t().history}</Text>
          </View>
        </If>
      </View>
      <If when={s.historyOpen()}>
        <History panel={props.panel} state={s} />
      </If>
    </View>
  );
}
