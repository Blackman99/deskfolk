export type MentionTrigger =
  | { active: true; query: string; anchorIndex: number }
  | { active: false };

export type MentionPopupState = {
  show: boolean;
  query: string;
  anchorIndex: number;
  highlightIndex: number;
  dismissed: boolean;
};

export const INITIAL_MENTION_STATE: MentionPopupState = {
  show: false,
  query: '',
  anchorIndex: -1,
  highlightIndex: 0,
  dismissed: false,
};

export function detectMentionTrigger(text: string, cursor: number): MentionTrigger {
  const textBefore = text.slice(0, cursor);
  const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    return { active: false };
  }
  return {
    active: true,
    query: match[1] ?? '',
    anchorIndex: textBefore.lastIndexOf('@'),
  };
}

export function stepMentionHighlight(
  currentIndex: number,
  totalCandidates: number,
  direction: 'up' | 'down',
): number {
  if (totalCandidates <= 0) return 0;
  if (direction === 'down') {
    return (currentIndex + 1) % totalCandidates;
  }
  return (currentIndex - 1 + totalCandidates) % totalCandidates;
}

/** Next `scrollTop` so `item` is fully inside the viewport, or unchanged if it already is. */
export function scrollTopToRevealRect(
  scrollTop: number,
  viewportTop: number,
  viewportBottom: number,
  itemTop: number,
  itemBottom: number,
): number {
  if (itemTop < viewportTop) {
    return Math.max(0, scrollTop - (viewportTop - itemTop));
  }
  if (itemBottom > viewportBottom) {
    return scrollTop + (itemBottom - viewportBottom);
  }
  return scrollTop;
}

export function shouldIgnoreKeyUp(key: string): boolean {
  return (
    key === 'ArrowDown' ||
    key === 'ArrowUp' ||
    key === 'Enter' ||
    key === 'Tab' ||
    key === 'Escape'
  );
}

export function updateMentionTrigger(
  state: MentionPopupState,
  text: string,
  cursor: number,
  candidateCount = 0,
): MentionPopupState {
  const trigger = detectMentionTrigger(text, cursor);
  if (!trigger.active) {
    return {
      show: false,
      query: '',
      anchorIndex: -1,
      highlightIndex: 0,
      dismissed: false,
    };
  }

  // If dismissed at this exact mention anchor and query, stay dismissed
  if (
    state.dismissed &&
    trigger.anchorIndex === state.anchorIndex &&
    trigger.query === state.query
  ) {
    return state;
  }

  // Query or anchor changed (user typed/deleted something): clear dismissed state
  const shouldResetHighlight =
    !state.show ||
    trigger.query !== state.query ||
    trigger.anchorIndex !== state.anchorIndex;

  const nextHighlight = shouldResetHighlight
    ? 0
    : candidateCount > 0
      ? Math.min(state.highlightIndex, candidateCount - 1)
      : state.highlightIndex;

  return {
    show: true,
    query: trigger.query,
    anchorIndex: trigger.anchorIndex,
    highlightIndex: nextHighlight,
    dismissed: false,
  };
}

export function handleMentionKeyDown(
  state: MentionPopupState,
  key: string,
  candidateCount: number,
): { state: MentionPopupState; handled: boolean } {
  if (!state.show) {
    return { state, handled: false };
  }

  if (key === 'Escape') {
    return {
      state: {
        ...state,
        show: false,
        dismissed: true,
      },
      handled: true,
    };
  }

  if (candidateCount > 0) {
    if (key === 'ArrowDown') {
      return {
        state: {
          ...state,
          highlightIndex: stepMentionHighlight(state.highlightIndex, candidateCount, 'down'),
        },
        handled: true,
      };
    }
    if (key === 'ArrowUp') {
      return {
        state: {
          ...state,
          highlightIndex: stepMentionHighlight(state.highlightIndex, candidateCount, 'up'),
        },
        handled: true,
      };
    }
    if (key === 'Enter' || key === 'Tab') {
      return {
        state,
        handled: true,
      };
    }
  }

  return { state, handled: false };
}

export function applyMentionCandidate(
  draft: string,
  anchorIndex: number,
  cursor: number,
  candidateName: string,
): { nextDraft: string; nextCursor: number } {
  const safeAnchor = anchorIndex >= 0 ? anchorIndex : cursor;
  const before = draft.slice(0, safeAnchor);
  const after = draft.slice(cursor);
  const inserted = `@${candidateName} `;
  return {
    nextDraft: `${before}${inserted}${after}`,
    nextCursor: before.length + inserted.length,
  };
}
