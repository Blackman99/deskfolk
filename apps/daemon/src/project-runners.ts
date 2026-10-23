/**
 * Project sessions' agents (ADR 0095, ADR 0099): each session runs the agent it was started with,
 * Claude Code (`project-runner.ts`) or Codex (`project-runner-codex.ts`). This only sends a line,
 * an answer, a Stop or a change to the runner of the session's agent.
 */
import type { ResolvedAgent } from "./agents/runtime";
import { createCodexProjectRunner } from "./project-runner-codex";
import { createProjectRunner, type ProjectRunner, type ProjectRunnerDeps } from "./project-runner";

export type ProjectRunnersDeps = ProjectRunnerDeps & {
  /** The Codex a Codex session's run starts; a test brings its stand-in. */
  resolveCodex?: () => Promise<ResolvedAgent>;
};

export function createProjectRunners(deps: ProjectRunnersDeps): ProjectRunner {
  const { store } = deps;
  const claude = createProjectRunner(deps);
  const codex = createCodexProjectRunner({ store, onTool: deps.onTool, ...(deps.resolveCodex ? { resolve: deps.resolveCodex } : {}) });
  const of = (sessionId: string): ProjectRunner => (store.projectOf(sessionId)?.agent === "codex" ? codex : claude);
  const ofRun = (runId: string): ProjectRunner => of(store.getAgentRun(runId).session_id);
  return {
    heard: (message) => of(message.session_id).heard(message),
    answer: (runId, allow) => ofRun(runId).answer(runId, allow),
    stop: (runId) => ofRun(runId).stop(runId),
    stopSession: (sessionId) => of(sessionId).stopSession(sessionId),
    tune: (sessionId, change) => of(sessionId).tune(sessionId, change),
    async idle() {
      await Promise.all([claude.idle(), codex.idle()]);
    },
    close() {
      claude.close();
      codex.close();
    },
  };
}
