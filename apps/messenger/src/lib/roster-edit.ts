export type ProfileFields = {
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  model: string;
};

export function profileDraftDirty(draft: ProfileFields, baseline: ProfileFields): boolean {
  return (
    draft.name !== baseline.name ||
    draft.duties !== baseline.duties ||
    draft.boundaries !== baseline.boundaries ||
    (draft.avatar ?? null) !== (baseline.avatar ?? null) ||
    draft.model !== baseline.model
  );
}

export function reconcileProfileDraft(
  draft: ProfileFields,
  baseline: ProfileFields,
  incoming: ProfileFields,
): { draft: ProfileFields; baseline: ProfileFields } {
  if (profileDraftDirty(draft, baseline)) return { draft, baseline };
  return { draft: incoming, baseline: incoming };
}
