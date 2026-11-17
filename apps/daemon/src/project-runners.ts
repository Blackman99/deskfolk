/**
 * Project sessions' agents (ADR 0095, ADR 0099): each session runs the agent it was started with,
 * Claude Code (`project-runner.ts`) or Codex (`project-runner-codex.ts`). This only sends a line,
 * an answer, a Stop or a change to the runner of the session's agent. Every agent has a runner of
 * its own: no session falls through to another agent's.
 */
import type { ProjectAgent } from "@real-bot/protocol";
import type { ResolvedAgent } from "./agents/runtime";
import { createCodexProjectRunner } from "./project-runner-codex";
import { createProjectRunner, type ProjectRunner, type ProjectRunnerDeps } from "./project-runner";

export type ProjectRunnersDeps = ProjectRunnerDeps & {
  /** The Codex a Codex session's run starts; a test brings its stand-in. */
  resolveCodex?: () => Promise<ResolvedAgent>;
};

export function createProjectRunners(deps: ProjectRunnersDeps): ProjectRunner {
  const { store } = deps;
  const runners: Record<ProjectAgent, ProjectRunner> = {
    claude_code: createProjectRunner(deps),
    codex: createCodexProjectRunner({ store, onTool: deps.onTool, ...(deps.resolveCodex ? { resolve: deps.resolveCodex } : {}) }),
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
