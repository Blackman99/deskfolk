export type ProfileFields = {
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  model: string;
  /** Pinned thinking level as the picker value; `''` lets the app pick per message. */
  thinkingLevel: string;
  /**
   * Who runs its turns (ADR 0061, ADR 0079): `''` the app on an endpoint, a runner's name for a local
   * agent (`claude_code`, `codex`, …), `custom:<id>` for one of your own ACP agents. Absent reads as `''`.
   */
  runner?: string;
  /** The local agent's model and effort; `''` leaves them to the agent. */
  agentModel?: string;
  agentEffort?: string;
  /** The account it runs on (a config directory listed in Settings); `''` the daemon's own environment. */
  agentConfigDir?: string;
};

/** Raw comparison: any keystroke counts, so a bot.upsert never clobbers text being typed. */
export function profileDraftDirty(draft: ProfileFields, baseline: ProfileFields): boolean {
  return (
    draft.name !== baseline.name ||
    draft.duties !== baseline.duties ||
    draft.boundaries !== baseline.boundaries ||
    (draft.avatar ?? null) !== (baseline.avatar ?? null) ||
    draft.model !== baseline.model ||
    draft.thinkingLevel !== baseline.thinkingLevel ||
    (draft.runner ?? "") !== (baseline.runner ?? "") ||
    (draft.agentModel ?? "") !== (baseline.agentModel ?? "") ||
    (draft.agentEffort ?? "") !== (baseline.agentEffort ?? "") ||
    (draft.agentConfigDir ?? "") !== (baseline.agentConfigDir ?? "")
  );
}

/** Same persisted content: the daemon trims name / duties / boundaries, so surrounding whitespace is ignored. */
export function profileContentEqual(a: ProfileFields, b: ProfileFields): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.duties.trim() === b.duties.trim() &&
    a.boundaries.trim() === b.boundaries.trim() &&
    (a.avatar ?? "") === (b.avatar ?? "") &&
    a.model.trim() === b.model.trim() &&
    a.thinkingLevel.trim() === b.thinkingLevel.trim() &&
    (a.runner ?? "") === (b.runner ?? "") &&
    (a.agentModel ?? "").trim() === (b.agentModel ?? "").trim() &&
    (a.agentEffort ?? "") === (b.agentEffort ?? "") &&
    (a.agentConfigDir ?? "") === (b.agentConfigDir ?? "")
  );
}

/** True when autosave has something to send: the draft differs from the last saved state beyond trimmed whitespace. */
export function profileNeedsSave(draft: ProfileFields, baseline: ProfileFields): boolean {
  return !profileContentEqual(draft, baseline);
}

/**
 * Folds a bot.upsert into the panel.
 * - Unsaved local edits win: a dirty draft and its baseline are left alone.
 * - An upsert that only differs by trimmed whitespace (our own autosave echoing back) keeps the text as typed.
 * - Anything else (the Bot changed itself, or another window saved) replaces draft and baseline.
 */
export function reconcileProfileDraft(
  draft: ProfileFields,
  baseline: ProfileFields,
  incoming: ProfileFields,
): { draft: ProfileFields; baseline: ProfileFields } {
  if (profileDraftDirty(draft, baseline)) return { draft, baseline };
  if (profileContentEqual(draft, incoming)) return { draft, baseline: draft };
  return { draft: incoming, baseline: incoming };
}
