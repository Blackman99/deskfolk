/**
 * Project sessions' agents (ADR 0095, ADR 0099): each session runs the agent it was started with,
 * Claude Code (`project-runner.ts`), Codex (`project-runner-codex.ts`), Antigravity
 * (`project-runner-agy.ts`) or Grok (`project-runner-grok.ts`). This only sends a line,
 * an answer, a Stop or a change to the runner of the session's agent. Every agent has a runner of
 * its own: no session falls through to another agent's.
 */
import type { ProjectAgent } from "@real-bot/protocol";
import type { ResolvedAgent } from "./agents/runtime";
import type { CommandMemory } from "./project-acp";
import { createAgyProjectRunner } from "./project-runner-agy";
import { createGrokProjectRunner } from "./project-runner-grok";
import type { RpcPeer } from "./engine/agent/jsonrpc";
import { createCodexProjectRunner } from "./project-runner-codex";
import { createConsultDesk } from "./project-consult";
import { createProjectRunner, type ProjectRunner, type ProjectRunnerDeps } from "./project-runner";

export type ProjectRunnersDeps = ProjectRunnerDeps & {
  /** The Codex a Codex session's run starts; a test brings its stand-in. */
  resolveCodex?: () => Promise<ResolvedAgent>;
  /** The `agy` an Antigravity session's run starts (ADR 0111), and its version; a test brings stand-ins. */
  resolveAgy?: () => Promise<ResolvedAgent>;
  agyVersion?: (executable: string, env: Record<string, string>) => Promise<string>;
  /** The commands `agy` offered in each directory, kept for the `/` list. */
  agyCommands?: CommandMemory;
  /** The Grok a Grok session's run starts on an account (ADR 0115), how long a call waits on a card, its billing, and its `/` commands; a test brings stand-ins. */
  resolveGrok?: (configDir: string | null) => Promise<ResolvedAgent>;
  grokHoldMs?: number;
  grokBilling?: (rpc: RpcPeer) => Promise<{ percent: number | null; end: number | null }>;
  grokCommands?: CommandMemory;
  /** How often a consultant's call looks at it (ADR 0116); a test's is short. */
  consultPollMs?: number;
  /** How long a consultant's call waits before saying it is still at it, whatever the asking agent; a test's is short. */
  consultWaitMs?: number;
};

export function createProjectRunners(deps: ProjectRunnersDeps): ProjectRunner {
  const { store } = deps;
  // Consultants (ADR 0116) run on these same runners: the desk reaches them through the whole.
  let whole: ProjectRunner | null = null;
  const consult = createConsultDesk({ store, runner: () => whole!, ...(deps.consultPollMs !== undefined ? { pollMs: deps.consultPollMs } : {}),
    ...(deps.consultWaitMs !== undefined ? { waitMs: deps.consultWaitMs } : {}) });
  const runners: Record<ProjectAgent, ProjectRunner> = {
    claude_code: createProjectRunner({ ...deps, consult }),
    codex: createCodexProjectRunner({ store, consult, onTool: deps.onTool, ...(deps.resolveCodex ? { resolve: deps.resolveCodex } : {}) }),
    antigravity: createAgyProjectRunner({
      store, consult, onTool: deps.onTool, ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}), ...(deps.resolveAgy ? { resolve: deps.resolveAgy } : {}),
      ...(deps.agyVersion ? { version: deps.agyVersion } : {}), ...(deps.agyCommands ? { commands: deps.agyCommands } : {}),
    }),
    grok: createGrokProjectRunner({
      store, consult, onTool: deps.onTool, ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}), ...(deps.resolveGrok ? { resolve: deps.resolveGrok } : {}),
      ...(deps.grokHoldMs !== undefined ? { holdMs: deps.grokHoldMs } : {}), ...(deps.grokBilling ? { billing: deps.grokBilling } : {}),
      ...(deps.grokCommands ? { commands: deps.grokCommands } : {}),
    }),
  };
  const all = Object.values(runners);
  // A row older than the agent column is Claude Code's (`projectOf` reads it so).
  const of = (sessionId: string): ProjectRunner => runners[store.projectOf(sessionId)?.agent ?? "claude_code"];
  const ofRun = (runId: string): ProjectRunner => of(store.getAgentRun(runId).session_id);
  whole = {
    heard: (message) => of(message.session_id).heard(message),
    answer: (runId, allow) => ofRun(runId).answer(runId, allow),
    answerAsk: (sessionId, askId, input) => of(sessionId).answerAsk(sessionId, askId, input),
    // A session's consultants stop with it (ADR 0116): its Stop, its history cleared, it deleted.
    stop: (runId) => {
      const run = ofRun(runId).stop(runId);
      consult.stopConsultants(run.session_id);
      return run;
    },
    stopSession: (sessionId) => {
      consult.stopConsultants(sessionId);
      of(sessionId).stopSession(sessionId);
    },
    // A consultant's task stops that consultant; any other is the agent's own.
    stopTask: (runId, taskId) => (consult.stopTask(runId, taskId) ? store.getAgentRun(runId) : ofRun(runId).stopTask(runId, taskId)),
    taskOutput: (runId, taskId) => ofRun(runId).taskOutput(runId, taskId),
    tune: (sessionId, change) => of(sessionId).tune(sessionId, change),
    resumeAfterLimits: (now) => {
      for (const runner of all) runner.resumeAfterLimits?.(now);
    },
    async idle() {
      await Promise.all(all.map((runner) => runner.idle()));
    },
    close() {
      consult.close();
      for (const runner of all) runner.close();
    },
  };
  return whole;
}
