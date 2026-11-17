/**
 * The agent tiles of a project session (`ProjectAgentTiles.svelte`): one radio tile per agent, the
 * picked one marked. Shared by the project session sheet and the first-launch wizard's carry-on step.
 *
 * Props: `agents` (the ones to offer, in order), `agent` (the picked one), `onPick`.
 */
import { Text, View } from "nsh";
import type { ProjectAgent } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { AgentLogo } from "../settings/AgentLogo";

export function ProjectAgentTiles(props: { agents: readonly ProjectAgent[]; agent: ProjectAgent; onPick: (agent: ProjectAgent) => void }) {
  const t = () => copy();
  return (
    <View role="radiogroup" accessibilityLabel={t().project.agentHead} class="flex-row flex-wrap gap-2">
      <Each of={props.agents} key={(each) => each}>
        {(each) => (
          <View
            role="radio"
            testID={`project-agent-${each()}`}
            accessibilityLabel={t().project.agentNames[each()]}
            accessibilityState={{ checked: props.agent === each() }}
            onPress={() => props.onPick(each())}
            class={`cursor-pointer select-none flex-row items-center gap-2 border rounded-(--radius-md) pl-2 pr-[14px] py-[6px] hover:bg-row-hover ${narrowWindow() ? "min-h-[44px]" : "min-h-[40px]"} ${props.agent === each() ? "border-brand bg-accent-tint" : "border-line bg-pane"}`}
          >
            <AgentLogo runner={each()} size={20} />
            <Text class="text-[13px] font-semibold text-ink">{t().project.agentNames[each()]}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}
