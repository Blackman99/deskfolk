import { PLAYBOOK_STEPS, type Playbook, type PlaybookStepId, type SessionSummary } from "@real-bot/protocol";

/**
 * Which engine (ADR 0085) a job's own calls run under, read the way the daemon reads it
 * (`playbookFor`): the job's conversation names one, or the conversation it came from does (a
 * Bot↔Bot direct runs the engine of where it was opened), else Settings' default. An engine named
 * but since removed reads as the default.
 */
export type JobEngineWhy = "own" | "inherited" | "fallback" | "gone";

/** How far up a chain of directs opened from directs is followed. */
const ORIGIN_DEPTH = 8;

export function sessionEngine(
  sessions: readonly Pick<SessionSummary, "id" | "playbook_id" | "origin_session_id">[],
  sessionId: string | null,
  defaultId: string,
  known: (id: string) => boolean = () => true,
): { id: string; why: JobEngineWhy } {
  const byId = new Map(sessions.map((session) => [session.id, session] as const));
  let at = sessionId ? byId.get(sessionId) : undefined;
  if (!at) return { id: defaultId, why: "gone" };
  for (let depth = 0; at && depth < ORIGIN_DEPTH; depth += 1) {
    if (at.playbook_id) return known(at.playbook_id) ? { id: at.playbook_id, why: depth === 0 ? "own" : "inherited" } : { id: defaultId, why: "fallback" };
    at = at.origin_session_id ? byId.get(at.origin_session_id) : undefined;
  }
  return { id: defaultId, why: "fallback" };
}

/** How many conversations run this engine. */
export function sessionsOnEngine(
  sessions: readonly Pick<SessionSummary, "id" | "playbook_id" | "origin_session_id" | "archived_at">[],
  engineId: string,
  defaultId: string,
  known: (id: string) => boolean = () => true,
): number {
  return sessions.filter((session) => !session.archived_at && sessionEngine(sessions, session.id, defaultId, known).id === engineId).length;
}

/** The steps an engine has switched off, in the order Roles draws them; one that only stops with what it stands on is not listed. */
export function engineOffSteps(playbook: Pick<Playbook, "resolved"> | undefined): PlaybookStepId[] {
  if (!playbook) return [];
  const stops = (step: (typeof PLAYBOOK_STEPS)[number]) => step.requires?.some((id) => playbook.resolved[id]?.on === false) ?? false;
  return PLAYBOOK_STEPS.filter((step) => step.switchable && playbook.resolved[step.id]?.on === false && !stops(step)).map((step) => step.id);
}

/** Whether an engine works in no jobs (ADR 0103): what a job left in a conversation that moved to it shows. */
export function engineHasNoJobs(playbook: Pick<Playbook, "resolved"> | undefined): boolean {
  return playbook?.resolved.jobs?.on === false;
}
