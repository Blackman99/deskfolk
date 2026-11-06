/**
 * What the plan's Bots made of it once it was delivered (`overlays/PlanRetrospectives.svelte`, ADR 0062):
 * what tripped each up, what made you send work back, what to keep, and the changes to its own
 * memories and skills — each with what it replaced and a 撤销. Nothing here asks you anything.
 */
import { signal, Text, View, type JSX } from "nsh";
import type { Bot, Retrospective, RetrospectiveChange, TaskDetail } from "@real-bot/protocol";
import { ApiError } from "../../m/api.ts";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { changedLines, changeTitle, failedText, reasonText, shownRetrospectives } from "../../m/overlays/plan-retrospectives.ts";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

function Findings(props: { label: string; lines: readonly string[]; testID: string }) {
  return (
    <If when={props.lines.length > 0}>
      <View testID={props.testID} class="gap-[3px] min-w-0">
        <Text class="text-[11px] font-semibold text-ink-muted">{props.label}</Text>
        <Each of={props.lines}>
          {(line) => (
            <View class="flex-row gap-[6px] pl-[2px] min-w-0">
              <Text class="text-[11.5px] leading-[1.45] text-ink-secondary">•</Text>
              <Text class="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-ink-secondary">{line()}</Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

export function PlanRetrospectives(props: {
  api: MessengerApi | null;
  detail: TaskDetail;
  /** The Bots, for a retrospective's name; one deleted since reads as deleted. */
  bots: readonly Bot[];
  deletedLabel: string;
  /** The plan comes back whole after an undo; the parent replaces its copy. */
  onSaved: (detail: TaskDetail) => void;
}) {
  const c = () => copy().plan.retrospective;
  const retrospectives = () => shownRetrospectives(props.detail.retrospectives);
  const names = () => new Map(props.bots.map((bot) => [bot.id, bot.name] as const));
  const pending = signal<string | null>(null);
  const failed = signal<{ key: string; message: string } | null>(null);
  const botName = (id: string) => names().get(id) ?? props.deletedLabel;

  async function undo(retrospective: Retrospective, index: number): Promise<void> {
    if (!props.api || pending()) return;
    const key = `${retrospective.id}:${index}`;
    pending.set(key);
    failed.set(null);
    try {
      props.onSaved(await props.api.undoRetrospectiveChange(retrospective.id, index));
    } catch (error) {
      failed.set({ key, message: error instanceof ApiError && error.status === 409 ? c().undoChanged : c().undoFailed });
    } finally {
      pending.set(null);
    }
  }

  const side = (change: RetrospectiveChange, which: "before" | "after") => change[which]?.body ?? "";

  /** One change the Bot made: its title, an undo while it stands, why, and the diff behind a press. */
  function Change(rowProps: { retrospective: () => Retrospective; change: () => RetrospectiveChange; index: number }) {
    const change = rowProps.change;
    const key = () => `${rowProps.retrospective().id}:${rowProps.index}`;
    const diff = signal(false);
    const hasDiff = () => change().status !== "not_applied" && Boolean(change().before || change().after);
    const skillDiff = () => change().kind === "skill" && change().before && change().after;
    return (
      <View testID={`retro-change-${rowProps.index}`} class="gap-[2px] min-w-0">
        <View class="flex-row items-center justify-between gap-2 min-w-0">
          <Text
            class={`flex-1 min-w-0 text-[12px] ${change().status === "applied" ? "text-ink" : "text-ink-muted"} ${change().status === "undone" ? "line-through" : ""}`}
          >
            {changeTitle(change(), c())}
          </Text>
          <If
            when={change().status === "applied" && props.api}
            else={
              <If when={change().status === "undone"}>
                <Text class="shrink-0 text-[11px] text-ink-muted">{c().undone}</Text>
              </If>
            }
          >
            <View
              role="button"
              testID={`retro-undo-${rowProps.index}`}
              disabled={pending() !== null}
              accessibilityState={{ busy: pending() === key() }}
              onPress={() => void undo(rowProps.retrospective(), rowProps.index)}
              class={`group shrink-0 px-2 justify-center rounded-(--radius-sm) border border-line bg-chip hover:border-accent-border hover:bg-accent-tint disabled:opacity-[0.55] ${
                narrowWindow() ? "min-h-[32px] py-1 px-[10px]" : "min-h-[24px] py-[2px]"
              }`}
            >
              <Text class="text-[11px] font-medium text-ink-secondary group-hover:text-brand">{c().undo}</Text>
            </View>
          </If>
        </View>
        <If when={change().status === "not_applied"}>
          <Text testID="retro-reason" class="text-[11px] text-ink-muted">{c().notApplied(reasonText(change().reason, c()))}</Text>
        </If>
        <If when={change().why}>
          <Text class="text-[11px] text-ink-muted">{change().why}</Text>
        </If>
        <If when={hasDiff()}>
          <View role="button" testID={`retro-diff-toggle-${rowProps.index}`} accessibilityState={{ expanded: diff() }} onPress={() => diff.set(!diff())} class="self-start">
            <Text class="text-[11px] text-brand">{`${diff() ? "▾" : "▸"} ${c().showDiff}`}</Text>
          </View>
          <If when={diff()}>
            <If
              when={skillDiff()}
              else={
                <View class="gap-[4px] mt-[4px]">
                  <If when={change().before}>
                    <View testID="retro-before" class="gap-px px-[6px] py-[4px] rounded-(--radius-xs) bg-line-subtle">
                      <Text class="text-[11px] font-semibold text-ink-muted">{c().before}</Text>
                      <Text class="text-[11px] leading-[1.45] text-ink-muted">{side(change(), "before")}</Text>
                    </View>
                  </If>
                  <If when={change().after}>
                    <View testID="retro-after" class="gap-px px-[6px] py-[4px] rounded-(--radius-xs) bg-line-subtle">
                      <Text class="text-[11px] font-semibold text-ink-muted">{c().after}</Text>
                      <Text class="text-[11px] leading-[1.45] text-ink-secondary">{side(change(), "after")}</Text>
                    </View>
                  </If>
                </View>
              }
            >
              <View class="mt-[4px]">
                <Each of={changedLines(change().before!.body, change().after!.body)}>
                  {(line) => (
                    <If
                      when={line().kind !== "gap"}
                      else={<Text class="px-[5px] py-px text-[11px] text-muted-light">…</Text>}
                    >
                      <View
                        testID={`retro-line-${line().kind}`}
                        class={`flex-row px-[5px] py-px rounded-(--radius-xs) ${line().kind === "add" ? "bg-accent-tint" : ""}`}
                      >
                        <Text class="w-[12px] text-[11px] text-ink-muted">{line().kind === "add" ? "+" : "−"}</Text>
                        <Text
                          class={`flex-1 text-[11px] leading-[1.45] ${line().kind === "add" ? "text-ink" : "text-ink-muted line-through"}`}
                        >
                          {line().text}
                        </Text>
                      </View>
                    </If>
                  )}
                </Each>
              </View>
            </If>
          </If>
        </If>
        <If when={failed()?.key === key()}>
          <Text testID="retro-error" class="text-[11px] text-danger-text">{failed()?.message}</Text>
        </If>
      </View>
    );
  }

  function Entry(rowProps: { retrospective: () => Retrospective }): JSX.Element {
    const retro = rowProps.retrospective;
    return (
      <View testID={`retrospective-${retro().id}`} class="gap-[6px] min-w-0 pt-2 border-t border-dashed border-line">
        <View class="flex-row items-baseline gap-2 min-w-0">
          <Text class="text-[12px] font-semibold text-ink">{botName(retro().bot_id)}</Text>
          <View tooltip={tip(formatFullTimestamp(retro().finished_at ?? retro().created_at))}>
            <Text class="text-[11px] text-ink-muted">{formatMessageTime(retro().finished_at ?? retro().created_at)}</Text>
          </View>
        </View>
        <If when={retro().state === "pending"}>
          <Text class="text-[11px] text-ink-muted">{c().running(botName(retro().bot_id))}</Text>
        </If>
        <If when={retro().state === "failed"}>
          <Text class="text-[11px] text-ink-muted">{failedText(retro().note, c())}</Text>
        </If>
        <If when={retro().state !== "pending" && retro().state !== "failed"}>
          <If when={retro().summary}>
            <Text testID="retro-summary" class="text-[12px] leading-[1.5] text-ink">{retro().summary}</Text>
          </If>
          <Findings testID="retro-rework" label={c().reworkCauses} lines={retro().rework_causes} />
          <Findings testID="retro-pitfalls" label={c().pitfalls} lines={retro().pitfalls} />
          <Findings testID="retro-keep" label={c().keep} lines={retro().keep} />
          <If when={retro().earlier.length > 0}>
            <View testID="retro-earlier" class="gap-[3px] min-w-0">
              <Text class="text-[11px] font-semibold text-ink-muted">{c().earlier}</Text>
              <Each of={retro().earlier}>
                {(item) => (
                  <View class="flex-row gap-[6px] pl-[2px] min-w-0">
                    <Text class="text-[11.5px] leading-[1.45] text-ink-secondary">•</Text>
                    <Text class="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-ink-secondary">
                      <Text class={`font-semibold ${item().verdict === "recurred" ? "text-danger-text" : "text-ink-muted"}`}>{c().verdict[item().verdict]}</Text>
                      {` ${item().conclusion}`}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <View class="gap-[3px] min-w-0">
            <Text class="text-[11px] font-semibold text-ink-muted">{c().changes}</Text>
            <If
              when={retro().changes.length > 0}
              else={<Text class="text-[11px] text-ink-muted">{c().noChanges}</Text>}
            >
              <View class="gap-[6px]">
                <Each of={retro().changes}>
                  {(change, index) => <Change retrospective={retro} change={change} index={index()} />}
                </Each>
              </View>
            </If>
          </View>
        </If>
      </View>
    );
  }

  return (
    <View accessibilityLabel={c().title} testID="plan-retrospectives" class="gap-[7px] min-w-0 px-[11px] py-[10px] rounded-(--radius-md) border border-line bg-pane">
      <View class="flex-row items-center gap-[6px] min-w-0 self-start">
        <Text class="text-[12px] font-semibold text-ink-muted">{c().title}</Text>
        <View class="px-[5px] rounded-full bg-line-subtle">
          <Text testID="retros-count" class="text-[10px] font-bold leading-[15px] font-mono text-ink-muted">{String(retrospectives().length)}</Text>
        </View>
      </View>
      <Text class="text-[11px] text-ink-muted">{c().hint}</Text>
      <Each of={retrospectives()} key={(retro) => retro.id}>
        {(retro) => <Entry retrospective={retro} />}
      </Each>
    </View>
  );
}
