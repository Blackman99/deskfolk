/**
 * Project sessions' agents (ADR 0095, ADR 0099): each session runs the agent it was started with,
 * Claude Code (`project-runner.ts`), Codex (`project-runner-codex.ts`) or Antigravity
 * (`project-runner-agy.ts`). This only sends a line,
 * an answer, a Stop or a change to the runner of the session's agent. Every agent has a runner of
 * its own: no session falls through to another agent's.
 */
import type { ProjectAgent } from "@real-bot/protocol";
import type { ResolvedAgent } from "./agents/runtime";
import { createAgyProjectRunner, type AgyCommandMemory } from "./project-runner-agy";
import { createCodexProjectRunner } from "./project-runner-codex";
import { createProjectRunner, type ProjectRunner, type ProjectRunnerDeps } from "./project-runner";

export type ProjectRunnersDeps = ProjectRunnerDeps & {
  /** The Codex a Codex session's run starts; a test brings its stand-in. */
  resolveCodex?: () => Promise<ResolvedAgent>;
  /** The `agy` an Antigravity session's run starts (ADR 0111), and its version; a test brings stand-ins. */
  resolveAgy?: () => Promise<ResolvedAgent>;
  agyVersion?: (executable: string, env: Record<string, string>) => Promise<string>;
  /** The commands `agy` offered in each directory, kept for the `/` list. */
  agyCommands?: AgyCommandMemory;
};

export function createProjectRunners(deps: ProjectRunnersDeps): ProjectRunner {
  const { store } = deps;
  const runners: Record<ProjectAgent, ProjectRunner> = {
    claude_code: createProjectRunner(deps),
    codex: createCodexProjectRunner({ store, onTool: deps.onTool, ...(deps.resolveCodex ? { resolve: deps.resolveCodex } : {}) }),
    antigravity: createAgyProjectRunner({
      store, onTool: deps.onTool, ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}), ...(deps.resolveAgy ? { resolve: deps.resolveAgy } : {}),
      ...(deps.agyVersion ? { version: deps.agyVersion } : {}), ...(deps.agyCommands ? { commands: deps.agyCommands } : {}),
    }),
  };
  const all = Object.values(runners);
  // A row older than the agent column is Claude Code's (`projectOf` reads it so).
  const of = (sessionId: string): ProjectRunner => runners[store.projectOf(sessionId)?.agent ?? "claude_code"];
  const ofRun = (runId: string): ProjectRunner => of(store.getAgentRun(runId).session_id);
  return {
    heard: (message) => of(message.session_id).heard(message),
    answer: (runId, allow) => ofRun(runId).answer(runId, allow),
    stop: (runId) => ofRun(runId).stop(runId),
    stopSession: (sessionId) => of(sessionId).stopSession(sessionId),
    stopTask: (runId, taskId) => ofRun(runId).stopTask(runId, taskId),
    taskOutput: (runId, taskId) => ofRun(runId).taskOutput(runId, taskId),
    tune: (sessionId, change) => of(sessionId).tune(sessionId, change),
    resumeAfterLimits: (now) => {
      for (const runner of all) runner.resumeAfterLimits?.(now);
    },
    async idle() {
      await Promise.all(all.map((runner) => runner.idle()));
    },
    close() {
      for (const runner of all) runner.close();
    },
  };
}
