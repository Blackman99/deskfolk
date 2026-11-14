/**
 * Step 2 on Claude Code or another local agent (ADR 0078, 0079): which agent, and whether it is
 * found and signed in. How it is found and signed in is the step heading's "?" (`ProviderStep`);
 * that it is not yet stays said under its card.
 */
import { Text, View } from "nsh";
import type { BotRunner } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { runnerValueOf } from "../../m/runner-choice.ts";
import { AgentCard } from "../settings/AgentCard";
import { AgentLogo } from "../settings/AgentLogo";
import { ClaudeAgentCard } from "../settings/ClaudeAgentCard";
import { Desc } from "./parts";
import type { Wizard } from "./wizard";

export function AgentStep(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy().onboarding;
  const options = () => [
    { value: "claude_code", runner: "claude_code" as BotRunner, label: "Claude Code" },
    ...w.readyAgents().map((status) => ({ value: runnerValueOf(status.runner, status.custom_id), runner: status.runner, label: status.label })),
  ];
  return (
    <View class="flex-col gap-[14px]">
      <If when={w.readyAgents().length > 0}>
        <View testID="agent-picks" role="radiogroup" accessibilityLabel={t().agentPick} class="flex-row flex-wrap gap-2">
          <Each of={options()} key={(option) => option.value}>
            {(option) => (
              <View
                role="radio"
                testID={`agent-pick-${option().value}`}
                accessibilityLabel={option().label}
                accessibilityState={{ checked: w.agentPick() === option().value }}
                onPress={() => {
                  w.agentPick.set(option().value);
                  w.agentModel.set("");
                }}
                class={`cursor-pointer select-none flex-row items-center gap-[6px] pl-[6px] pr-3 py-[5px] rounded-full border ${
                  w.agentPick() === option().value ? "bg-brand border-brand" : "bg-chip border-chip-line hover:bg-pane hover:border-line-hover"
                }`}
              >
                <AgentLogo runner={option().runner} size={18} />
                <Text class={`text-[12px] ${w.agentPick() === option().value ? "font-semibold text-on-accent" : "font-medium text-ink-secondary"}`}>{option().label}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If
        when={w.pickedOther() && w.pickedStatus()}
        else={
          <>
            <ClaudeAgentCard api={runtime.client} onstatus={(status) => w.claudeStatus.set(status)} />
            <If when={w.claudeStatus() && !w.claudeOk()}>
              <Desc testID="claude-not-ready">{t().claudeNotReady}</Desc>
            </If>
          </>
        }
      >
        <AgentCard
          status={w.pickedStatus()!}
          api={runtime.client as never}
          onChange={(status) => {
            const list = w.otherAgents();
            if (list) {
              w.otherAgents.set({ ...list, items: list.items.map((item) => (item.runner === status.runner && item.custom_id === status.custom_id ? status : item)) });
            }
          }}
        />
        <If when={!w.claudeOk()}>
          <Desc testID="claude-not-ready">{t().agentNotReady.replace("{agent}", w.pickedLabel())}</Desc>
        </If>
      </If>
    </View>
  );
}
