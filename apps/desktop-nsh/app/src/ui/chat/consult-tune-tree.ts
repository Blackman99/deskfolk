/**
 * What the composer's "add a consultant" picker lists and does (ADR 0116 addendum): the project
 * agents in the first column, then the agent's own models and levels as `agentTuneTree` lists them
 * (the same levels a Bot's picker puts under each local agent). No account: a consultant runs on
 * the agent's default one. Picking a model that takes no level, or a level, is the pick.
 */
import { PROJECT_AGENTS, type AgentsStatusResponse, type ConsultMember, type ProjectAgent } from "@real-bot/protocol";
import type { Copy } from "../../m/copy";
import type { MessengerApi } from "../../m/messenger-api";
import { loadClaudeModels } from "../../m/claude-models.svelte";
import { runnerSource } from "../../m/model-source";
import { agentBlocker, agentStatusOf } from "../../m/runner-choice";
import { agentTuneModels } from "../../m/chat/bot-tune";
import type { TuneFocus, TuneLevel, TuneRow, TuneTree } from "../../m/chat/tune-picker";
import { agentTuneTree } from "./agent-tune-tree";

export type ConsultTuneSource = {
  readonly t: Copy;
  /** Your local agents as the daemon last saw them; null while asking, or from one that cannot say. */
  readonly agents: AgentsStatusResponse | null;
  readonly client: Pick<MessengerApi, "claudeCodeModels"> | null;
  onPick(member: ConsultMember): void;
};

export const CONSULT_AGENT_LEVEL = "agent";

/** The first column: the agents a project session runs on; one the daemon found missing or signed out is listed but cannot be picked. */
export function consultAgentRows(t: Copy, agents: AgentsStatusResponse | null): TuneRow[] {
  return PROJECT_AGENTS.map((agent): TuneRow => {
    const blocker = agent === "claude_code" ? null : agentBlocker(agentStatusOf(agents, agent));
    const name = t.project.agentNames[agent];
    return {
      value: agent,
      label: name,
      detail: blocker === "missing" ? t.sidebar.botRunnerAgentMissingShort : blocker === "signed_out" ? t.sidebar.botRunnerAgentSignedOutShort : undefined,
      disabled: blocker !== null,
      mark: runnerSource(agent, name, t),
    };
  });
}

const BLANK = { account: "", model: "", effort: "" };

export function consultTuneTree(source: ConsultTuneSource): TuneTree {
  const agents = new Map<ProjectAgent, TuneTree>();
  /** The models and levels under one agent. */
  function under(agent: ProjectAgent): TuneTree {
    let tree = agents.get(agent);
    if (!tree) {
      tree = agentTuneTree({
        get t() {
          return source.t;
        },
        agentName: source.t.project.agentNames[agent],
        tune: BLANK,
        get models() {
          return agent === "claude_code" ? undefined : agentTuneModels(agentStatusOf(source.agents, agent), agent, "", source.t.project.modelDefault);
        },
        accounts: null,
        accountLocked: false,
        get client() {
          return source.client;
        },
        onPick: () => {},
      });
      agents.set(agent, tree);
    }
    return tree;
  }
  const first = (): ProjectAgent => PROJECT_AGENTS[0];
  const agentOf = (focus: TuneFocus): ProjectAgent => (PROJECT_AGENTS as readonly string[]).includes(focus[CONSULT_AGENT_LEVEL] ?? "") ? (focus[CONSULT_AGENT_LEVEL] as ProjectAgent) : first();
  const agentLevel = (): TuneLevel => ({ key: CONSULT_AGENT_LEVEL, heading: source.t.project.consultAgentLevel, width: 180, details: true });
  const own = (focus: TuneFocus): TuneFocus => ({ account: "", model: focus.model ?? "", effort: focus.effort ?? "" });

  return {
    start: () => ({ ...BLANK, [CONSULT_AGENT_LEVEL]: first() }),
    levels: (focus) => [agentLevel(), ...under(agentOf(focus)).levels(own(focus))],
    room: (focus) => {
      const widest = PROJECT_AGENTS.map((agent) => under(agent).room(BLANK));
      const width = (levels: TuneLevel[]) => levels.reduce((sum, level) => sum + level.width, 0);
      return [agentLevel(), ...widest.reduce((most, path) => (width(path) > width(most) ? path : most), under(agentOf(focus)).room(own(focus)))];
    },
    rows: (level, focus) => (level === CONSULT_AGENT_LEVEL ? consultAgentRows(source.t, source.agents) : under(agentOf(focus)).rows(level, own(focus))),
    checked: (level) => (level === CONSULT_AGENT_LEVEL ? "" : "__none__"),
    opensMore: (level, value, focus) => (level === CONSULT_AGENT_LEVEL ? true : under(agentOf(focus)).opensMore(level, value, own(focus))),
    focusAt: (level, value, focus) => {
      if (level === CONSULT_AGENT_LEVEL) {
        if (value === agentOf(focus) && focus[CONSULT_AGENT_LEVEL]) return focus;
        if (value === "claude_code") loadClaudeModels(source.client, null);
        return { ...BLANK, [CONSULT_AGENT_LEVEL]: value };
      }
      const next = under(agentOf(focus)).focusAt(level, value, own(focus));
      return { ...next, [CONSULT_AGENT_LEVEL]: agentOf(focus) };
    },
    commit: (level, focus) => {
      if (level === CONSULT_AGENT_LEVEL) return;
      source.onPick({ agent: agentOf(focus), model: focus.model || null, effort: focus.effort || null });
    },
  };
}
