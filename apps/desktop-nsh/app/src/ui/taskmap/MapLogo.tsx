/**
 * Whose model a character works on, at the map's sizes (`MapLogo.svelte`): an endpoint's vendor,
 * Claude Agent's spark on its tile, a local agent's logo; an endpoint of no known vendor gets the
 * plain tile a custom agent has, never another vendor's mark.
 */
import type { ModelSource } from "../../m/model-source";
import { AgentLogo, ConnectorLogo } from "../settings/AgentLogo";

export function MapLogo(props: { source: ModelSource; size: number }) {
  const source = () => props.source;
  return (
    <If
      when={source().kind === "connector" || source().kind === "vendor"}
      else={
        <If
          when={source().kind === "claude-agent"}
          else={
            <If when={source().kind === "agent"} else={<AgentLogo runner="custom" size={props.size} />}>
              <AgentLogo runner={(source() as Extract<ModelSource, { kind: "agent" }>).runner} size={props.size} />
            </If>
          }
        >
          <AgentLogo runner="claude_code" size={props.size} />
        </If>
      }
    >
      <ConnectorLogo id={(source() as Extract<ModelSource, { kind: "connector" | "vendor" }>).id} size={props.size} />
    </If>
  );
}
