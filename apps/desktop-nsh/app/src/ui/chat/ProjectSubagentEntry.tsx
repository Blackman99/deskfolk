/**
 * The way into a project session's subagent (ADR 0095, 25), under the line of the turn that sent
 * it, as a Bot↔Bot direct's is under the line that opened it (`BotDmEntry`): a chip with who it is
 * and, while it works, that it does; several, a card of chips. It opens as a popup
 * (`ProjectSubagentEntry.svelte`).
 */
import { Text, View } from "nsh";
import type { AgentRunTask } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { enterMotion, pulseMotion } from "./labels";

export function ProjectSubagentEntry(props: { tasks: readonly AgentRunTask[]; onOpen: (task: AgentRunTask) => void }) {
  const t = () => copy();
  const nameOf = (task: AgentRunTask) => task.description || task.agent_type || t().project.taskDoing.subagent;
  /** How it went, when that is worth a word: a chip that says nothing finished as it should. */
  const noteOf = (task: AgentRunTask) => (task.status === "running" || task.status === "completed" ? null : t().project.taskStatus[task.status]);
  const enter = enterMotion();
  const live = pulseMotion(() => true, 1800);

  const Live = () => <View class="shrink-0 w-[5px] h-[5px] rounded-full bg-brand" style={{ opacity: live.opacity }} accessible={false} />;

  const chip = (task: AgentRunTask, single: boolean) => (
    <View
      role="button"
      testID={`subagent-${task.id}`}
      accessibilityLabel={nameOf(task)}
      tooltip={tip(nameOf(task))}
      onPress={() => props.onOpen(task)}
      class={`cursor-pointer select-none group flex-row items-center gap-[5px] min-w-0 max-w-full ${
        single ? "" : "pl-[5px] pr-[8px] py-[2.5px] border border-line rounded-full bg-bg hover:bg-line-hover hover:border-muted-light"
      }`}
    >
      <Icon name="bot" size={16} class="shrink-0 tint-ink-muted" />
      <Text class={`min-w-0 max-w-[240px] text-[12px] font-medium line-clamp-1 ${single ? "text-ink group-hover:text-brand" : "text-ink"}`}>{nameOf(task)}</Text>
      <If when={!single && task.status === "running"}>
        <Live />
      </If>
      <If when={!single && noteOf(task)}>{(note) => <Text class="shrink-0 text-[12px] text-ink-muted">{note()}</Text>}</If>
    </View>
  );

  return (
    <If when={props.tasks.length > 0}>
      <View testID="subagent-entry" class="flex-row flex-wrap self-stretch mt-[8px]">
        <If
          when={props.tasks.length === 1 ? props.tasks[0] : null}
          else={
            <View
              class="max-w-full gap-[7px] px-[10px] pt-[7px] pb-[9px] bg-pane border border-line rounded-(--radius-lg)"
              style={{ boxShadow: shadow("xs"), opacity: enter.opacity, transform: [...enter.transform] }}
            >
              <View class="flex-row items-center gap-[5px]">
                <Icon name="bot" size={12} class="tint-ink-muted" />
                <Text class="text-[12px] font-medium text-ink-muted">{t().project.subagentsOpened}</Text>
                <View class="px-[6px] py-[1px] border border-line rounded-full bg-chip">
                  <Text class="font-mono text-[10px] font-semibold text-ink-muted">{props.tasks.length}</Text>
                </View>
              </View>
              <View class="flex-row flex-wrap items-center gap-[5px]">
                <Each of={props.tasks} key={(task) => task.id}>{(task) => chip(task(), false)}</Each>
              </View>
            </View>
          }
        >
          {(task) => (
            <View
              class="flex-row items-center gap-[6px] min-w-0 max-w-full pl-[6px] pr-[10px] py-[3px] bg-pane border border-line rounded-full"
              style={{ boxShadow: shadow("xs"), opacity: enter.opacity, transform: [...enter.transform] }}
            >
              {chip(task(), true)}
              <If
                when={task().status === "running"}
                else={<If when={noteOf(task())}>{(note) => <Text class="shrink-0 text-[12px] text-ink-muted">{note()}</Text>}</If>}
              >
                <Live />
                <Text class="shrink-0 text-[12px] text-ink-muted">{t().project.taskStatus.running}</Text>
              </If>
            </View>
          )}
        </If>
      </View>
    </If>
  );
}
