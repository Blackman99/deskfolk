/**
 * A Bot's working bubble in the transcript (the `streaming` item of `TranscriptBotGroup.svelte`):
 * what the turn has said so far with a cursor after it, the commands it has run, and the last
 * line: where it is, the step's time and the whole turn's. The step opens the list of what is going
 * on now (`TurnStepList`) when there is more to show than the line says.
 *
 * Like a finished reply it sits on the page flat, no bubble: the cues that it is working are the
 * portrait's glow (the group's), the pulse, the cursor and the last line.
 */
import { createMotion, effect, Text, View } from "nsh";
import { reduceMotion } from "../interface/motion";
import type { Bot, Turn } from "@real-bot/protocol";
import { formatLiveDuration } from "../../m/chat/chat-view.ts";
import type { CommandRow } from "../../m/chat/command-activity.ts";
import { describeStep, stepRow, type StepLine, type StepRow } from "../../m/chat/turn-activity.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { MarkdownBody } from "../MarkdownBody";
import { tip } from "../tip";
import { CommandActivity } from "./CommandActivity";
import { pulseMotion } from "./labels";
import { TurnStepList } from "./TurnStepList";

/** The blinking cursor after what has been said so far. */
function Cursor() {
  const m = createMotion();
  effect(() => {
    if (!reduceMotion()) void m.play({ duration: 800, iterations: "infinite", direction: "alternate", keyframes: { opacity: [1, 0] } });
    else m.reset();
  });
  return <View testID="streaming-cursor" class="w-[7px] h-[14px] ml-[3px] bg-brand" style={{ opacity: m.opacity, verticalAlign: "middle" }} accessible={false} />;
}

export function StreamingReply(props: { turn: Turn; bot: Bot | undefined; stage: TranscriptStage }) {
  const t = () => copy();
  const stage = () => props.stage;
  const turnId = () => props.turn.id;
  const pulse = pulseMotion(() => true, 1200);
  const said = () => Boolean(props.turn.partial_text?.trim());
  const botName = () => props.bot?.name ?? t().top.deleted;

  /** What a working turn is doing, once it has started a step. */
  const step = (): StepLine | null => {
    const s = runtime.stepOf(turnId());
    return s ? describeStep(s, t().chat.activity, stage().nowMs) : null;
  };
  /** What one of its commands has printed, if this conversation was watching when it ran. */
  const commandOutput = (callId: string): string | null => {
    void runtime.activityRevision;
    const id = `${turnId()}:${callId}`;
    return runtime.activity.forTurn(turnId()).find((row) => row.id === id)?.text || null;
  };
  /** A running turn's commands; reading the revision brings new output in. */
  const commandRows = (): CommandRow[] => {
    void runtime.activityRevision;
    return runtime.activity.forTurn(turnId());
  };
  /** What the last line opens onto: only what is going on now. */
  const liveSteps = (): StepRow[] | null => {
    const rows = runtime
      .stepsOf(turnId())
      .filter((s) => s.running)
      .map((s) => stepRow(s, t().chat.activity, stage().nowMs));
    return rows.length ? rows : null;
  };
  /** Whether opening the line shows more than it says: another step beside it, or a running command's output. */
  const opensMore = (): boolean => {
    const running = runtime.stepsOf(turnId()).filter((s) => s.running);
    return running.length > 1 || running.some((s) => s.name === "shell" && Boolean(commandOutput(s.id)));
  };
  const open = () => stage().openStepsTurn === turnId();
  const toggle = () => {
    stage().openStepsTurn = open() ? null : turnId();
  };
  const plainStep = () => (said() ? t().stream.streaming : stage().statusLabels.running);

  return (
    <View testID={`streaming-${turnId()}`} selectable class="w-full px-[2px]">
      <If when={said()}>
        <MarkdownBody
          source={props.turn.partial_text ?? ""}
          options={stage().markdownOpts(undefined, { streaming: true })}
          copyLabel={t().chat.copyCode}
          copiedLabel={t().chat.copied}
          onOpenArtifact={(path) => stage().onOpenArtifact(path)}
          onOpenImage={(path) => stage().openInlineImage(null, path, null)}
          onOpenProfile={stage().onOpenProfile}
        >
          <Cursor />
        </MarkdownBody>
      </If>
      {/* What it is doing while it does it. Ephemeral: the turn's own record is what survives a reload. */}
      <If when={!stage().focus}>
        <CommandActivity rows={commandRows()} />
      </If>
      {/* Where it is and for how long, after all it has said and run. */}
      <View role="text" testID="stream-foot" class="flex-row items-center gap-[6px] min-w-0 mt-[8px]">
        <View class="shrink-0 w-[7px] h-[7px] rounded-full bg-brand" style={{ opacity: pulse.opacity }} accessible={false} />
        <If
          when={!stage().focus ? step() : null}
          else={
            <Text testID="stream-step" class="shrink min-w-0 text-[12px] font-medium text-brand line-clamp-1">
              {plainStep()}
            </Text>
          }
        >
          {(line: () => StepLine) => (
            <>
              <If
                when={opensMore()}
                else={
                  <View class="shrink min-w-0" tooltip={tip(line().full)}>
                    <Text testID="stream-step" class="text-[12px] font-medium text-brand line-clamp-1">
                      {line().text}
                    </Text>
                  </View>
                }
              >
                <View
                  role="button"
                  testID="stream-step"
                  accessibilityLabel={line().text}
                  accessibilityState={{ expanded: open() }}
                  tooltip={tip(`${line().full}\n${t().chat.activity.showSteps}`)}
                  onPress={toggle}
                  class="group flex-row items-center gap-[4px] shrink min-w-0"
                >
                  <Text class="shrink min-w-0 text-[12px] font-medium text-brand group-hover:text-ink line-clamp-1">{line().text}</Text>
                  <Icon name="chevron-down" size={12} class={`shrink-0 tint-brand ${open() ? "rotate-180" : ""}`} />
                </View>
              </If>
              <If when={line().elapsed}>
                <Text class="shrink-0 text-[12px] font-mono text-ink-muted" accessible={false}>
                  {line().elapsed}
                </Text>
              </If>
            </>
          )}
        </If>
        <If when={!stage().focus}>
          <View class="flex-row items-center gap-[6px] shrink-0 ml-auto pl-2">
            <Icon name="clock" size={12} class="tint-ink-muted" />
            <Text testID="stream-duration" class="text-[12px] text-ink-muted">
              {formatLiveDuration(props.turn.created_at, stage().nowMs, t().chat.spanPart)}
            </Text>
          </View>
        </If>
      </View>
      <If when={open() && !stage().focus ? liveSteps() : null}>
        {(rows: () => StepRow[]) => (
          <TurnStepList
            id={`turn-steps-${turnId()}`}
            title={t().chat.activity.nowTitle(botName(), rows().length)}
            rows={rows()}
            outputOf={commandOutput}
            onClose={() => {
              stage().openStepsTurn = null;
            }}
          />
        )}
      </If>
    </View>
  );
}
