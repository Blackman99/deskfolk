/**
 * The agent at work in a project session (the end of `ProjectChat.svelte`'s transcript), as a Bot's
 * working bubble: what it has said so far with a cursor, its commands, then where it is and for how
 * long; the approval it waits on under it (the plan's own card, or a Bot's approval card) and why an
 * answer did not go. The step opens what is going on now when there is more to show than it says.
 */
import { createMotion, effect, Text, View } from "nsh";
import { reduceMotion } from "../interface/motion";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import { formatLiveDuration } from "../../m/chat/chat-view.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { MarkdownBody } from "../MarkdownBody";
import { shadow } from "../styles";
import { tip } from "../tip";
import { CommandActivity } from "./CommandActivity";
import { pulseMotion } from "./labels";
import { ProjectPlanCard } from "./ProjectPlanCard";
import { ProjectSubagentEntry } from "./ProjectSubagentEntry";
import { ProjectTaskSteps } from "./ProjectTaskSteps";
import type { ProjectState } from "./project-chat-state";
import { isCommandTask } from "../../m/chat/project-tasks.ts";

/** The blinking cursor after what has been said so far. */
function Cursor() {
  const m = createMotion();
  effect(() => {
    if (!reduceMotion()) void m.play({ duration: 800, iterations: "infinite", direction: "alternate", keyframes: { opacity: [1, 0] } });
    else m.reset();
  });
  return <View testID="streaming-cursor" accessible={false} class="w-[7px] h-[14px] ml-[3px] bg-brand" style={{ opacity: m.opacity, verticalAlign: "middle" }} />;
}

export function ProjectWorking(props: { state: ProjectState }) {
  const t = () => copy();
  const s = () => props.state;
  const run = () => s().run();
  const pulse = pulseMotion(() => true, 1200);

  /** The foot's words: what it waits on, its step, the background tasks going, or plainly that it works. */
  const step = (text: string, full: string) => (
    <If
      when={s().footOpens() && !focusMode.on}
      else={
        <View class="shrink min-w-0" tooltip={tip(full)}>
          <Text testID="project-step" class="text-[12px] font-medium text-brand line-clamp-1">
            {text}
          </Text>
        </View>
      }
    >
      <View
        role="button"
        testID="project-steps-toggle"
        accessibilityLabel={text}
        accessibilityState={{ expanded: s().stepsOpen() }}
        tooltip={tip(`${full}\n${t().chat.activity.showSteps}`)}
        onPress={() => s().stepsOpen.set(!s().stepsOpen())}
        class="cursor-pointer select-none group flex-row items-center gap-[4px] shrink min-w-0"
      >
        <Text class="shrink min-w-0 text-[12px] font-medium text-brand group-hover:text-ink line-clamp-1">{text}</Text>
        <Icon name="chevron-down" size={12} class={`shrink-0 tint-brand ${s().stepsOpen() ? "rotate-180" : ""}`} />
      </View>
    </If>
  );

  const foot = () => {
    const r = run();
    if (s().waiting()) {
      const text = s().planWaiting() ? t().project.waitingPlan : t().project.waiting(s().agentName());
      return <Text testID="project-step" class="shrink min-w-0 text-[12px] font-medium text-brand line-clamp-1">{text}</Text>;
    }
    const line = !focusMode.on ? s().stepLine() : null;
    if (line) {
      return (
        <>
          {step(line.text, line.full)}
          <If when={line.elapsed}>
            <Text class="shrink-0 text-[12px] font-mono text-ink-muted" accessible={false}>
              {line.elapsed}
            </Text>
          </If>
        </>
      );
    }
    if (r?.idle && s().goingTasks().length > 0) {
      const text = focusMode.on ? t().sidebar.statusBackground : t().project.tasksGoing(s().goingTasks().length);
      return step(text, text);
    }
    if (!focusMode.on && r?.activity) return step(r.activity, r.activity);
    const text = r?.partial ? t().stream.streaming : t().sidebar.statusRunning;
    return step(text, text);
  };

  return (
    <If when={run() && s().live() ? run() : null}>
      {(live: () => NonNullable<ReturnType<ProjectState["run"]>>) => (
        <View class="w-full gap-[14px]">
          <View testID="project-working" role="text" class="w-full items-start">
            <If when={live().partial}>
              {/* The whole line wide, as a finished line's (`ProjectLine`): fitted to its text it was cut short. */}
              <MarkdownBody
                class="self-stretch"
                selectable={false}
                source={live().partial ?? ""}
                options={{ streaming: true }}
                copyLabel={t().chat.copyCode}
                copiedLabel={t().chat.copied}
                onOpenArtifact={(path) => s().openCited(path)}
              >
                <Cursor />
              </MarkdownBody>
            </If>
            <If when={!focusMode.on}>
              <View class="self-stretch mt-[8px]">
                <CommandActivity rows={s().commandRows()} />
              </View>
              <ProjectSubagentEntry tasks={s().placed().bubble} onOpen={(task) => s().subagentOpen.set(task.id)} />
            </If>
            <View testID="project-foot" class="flex-row self-stretch items-center gap-[6px] min-w-0 mt-[8px]">
              <View accessible={false} class="shrink-0 w-[7px] h-[7px] rounded-full bg-brand" style={{ opacity: pulse.opacity }} />
              {foot()}
              <If when={!focusMode.on}>
                <View class="flex-row items-center gap-[6px] shrink-0 ml-auto pl-2">
                  <Icon name="clock" size={12} class="tint-ink-muted" />
                  <Text testID="project-duration" class="text-[12px] text-ink-muted">
                    {formatLiveDuration(live().created_at, s().nowMs(), t().chat.spanPart)}
                  </Text>
                </View>
              </If>
            </View>
            <If when={s().stepsOpen() && s().footOpens() && !focusMode.on && s().nowRows().length > 0}>
              <View class="w-full">
                <ProjectTaskSteps
                  id={`project-steps-${live().id}`}
                  title={t().chat.activity.nowTitle(s().agentName(), s().nowRows().length)}
                  rows={s().nowRows()}
                  tasks={s().goingTasks().filter(isCommandTask)}
                  onClose={() => s().stepsOpen.set(false)}
                />
              </View>
            </If>
          </View>
          <If when={s().waiting()}>
            {(approval: () => NonNullable<ReturnType<ProjectState["waiting"]>>) => (
              <If
                when={s().planWaiting()}
                else={
                  <View testID="project-approval" role="region" accessibilityLabel={t().project.approvalHead} class="overflow-hidden border border-warn-line rounded-(--radius-lg) bg-pane" style={{ boxShadow: shadow("sm") }}>
                    <View class="flex-row items-center gap-[6px] px-4 py-[9px] border-b border-warn-line bg-warn-bg">
                      <Icon name="shield-check" size={12} class="tint-warn-text" />
                      <Text class="text-[12px] font-bold text-warn-text">{t().project.approvalHead}</Text>
                      <Text class="text-[12px] text-ink-secondary">{`· ${s().agentName()}`}</Text>
                    </View>
                    <View class="px-4 pt-3 pb-[14px] gap-[10px]">
                      {/* In the transcript's selection; an area of its own would take the right click (`pane-menu.ts`). */}
                      <View>
                        <Text testID="project-approval-summary" class="font-mono text-[12px] leading-[1.5] text-ink">{approval().summary}</Text>
                      </View>
                      <View class="flex-row flex-wrap gap-2">
                        <Button variant="primary" icon="check" testID="project-allow" disabled={s().answering() || !s().connected()} onPress={() => void s().answer(true)}>
                          {t().project.allow}
                        </Button>
                        <Button testID="project-deny" disabled={s().answering() || !s().connected()} onPress={() => void s().answer(false)}>
                          {t().project.deny}
                        </Button>
                      </View>
                    </View>
                  </View>
                }
              >
                {/* The plan it asks you to approve: approved, it gets to work; a line you send is what to change. */}
                <ProjectPlanCard approval={approval()} disabled={s().answering() || !s().connected()} onAnswer={(allow) => void s().answer(allow)} onOpenPath={(path) => s().openCited(path)} />
              </If>
            )}
          </If>
          <If when={s().answerFailed()}>
            <Text testID="project-error" role="text" class="text-[12px] text-danger-text">{t().project.actionFailed}</Text>
          </If>
        </View>
      )}
    </If>
  );
}
