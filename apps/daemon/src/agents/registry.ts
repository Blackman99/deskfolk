/**
 * How the daemon starts each local agent (ADR 0079), beside what every client knows of it
 * (`AGENT_KINDS` in the protocol). Every agent runs as you installed it, under your own sign-in;
 * the flags here only keep a Bot's turn to itself: Grok off its shared leader process, OpenCode on
 * the private server `opencode acp` starts (never the background service), Codex on an app-server
 * of its own (never a remote one or the shared daemon). Nothing here writes an agent's config: what
 * a turn needs is passed per launch.
 */
import { AGENT_KINDS, type BotRunner } from "@real-bot/protocol";

export type AgentLaunch = {
  /** Arguments after the command, before anything per turn. */
  args: string[];
  /** The service host its requests go to, for the proxy choice (ADR 0061 decision 10). */
  apiHost: string;
  /** The command that signs you in, as you would type it in a terminal. */
  login: string | null;
  /** Where its sign-in and config live under your home folder (for the Settings card only). */
  homeDir: string | null;
};

export const AGENT_LAUNCH: Record<Exclude<BotRunner, "claude_code">, AgentLaunch> = {
  codex: { args: ["app-server"], apiHost: "chatgpt.com", login: "codex login", homeDir: "~/.codex" },
  grok: { args: ["agent", "--no-leader", "stdio"], apiHost: "api.x.ai", login: "grok login", homeDir: "~/.grok" },
  opencode: { args: ["acp"], apiHost: "opencode.ai", login: "opencode auth login", homeDir: "~/.local/share/opencode" },
  antigravity: { args: [], apiHost: "cloudcode-pa.googleapis.com", login: "agy", homeDir: "~/.gemini" },
  zcode: { args: [], apiHost: "open.bigmodel.cn", login: null, homeDir: null },
  custom: { args: [], apiHost: "api.openai.com", login: null, homeDir: null },
};

/** The command a runner is looked for by; null for a custom agent (its own absolute command). */
export function agentCommand(runner: BotRunner): string | null {
  return AGENT_KINDS[runner].command;
}
