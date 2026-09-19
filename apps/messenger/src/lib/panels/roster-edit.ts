export type ProfileFields = {
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  model: string;
  /** Pinned thinking level as the picker value; `''` lets the app pick per message. */
  thinkingLevel: string;
};

/** Raw comparison: any keystroke counts, so a bot.upsert never clobbers text being typed. */
export function profileDraftDirty(draft: ProfileFields, baseline: ProfileFields): boolean {
  return (
    draft.name !== baseline.name ||
    draft.duties !== baseline.duties ||
    draft.boundaries !== baseline.boundaries ||
    (draft.avatar ?? null) !== (baseline.avatar ?? null) ||
    draft.model !== baseline.model ||
    draft.thinkingLevel !== baseline.thinkingLevel
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
    a.thinkingLevel.trim() === b.thinkingLevel.trim()
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
