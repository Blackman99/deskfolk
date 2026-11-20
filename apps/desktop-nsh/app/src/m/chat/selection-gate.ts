/**
 * What a selection waits for before the conversation shows. On the phone's page the route provides
 * it (`PageRoute.entryFirst`, `platform/page-route-install.ts`): the conversation's history entry
 * is written first, so the screen it opens from is what Chrome on Android pictures as the entry
 * under it, the picture a back swipe slides the page off. Nothing to wait for elsewhere.
 */
let gate: ((id: string) => Promise<void> | null) | null = null;

/** The page's route offers its wait; the returned function takes it away. */
export function provideSelectionGate(next: (id: string) => Promise<void> | null): () => void {
  gate = next;
  return () => {
    if (gate === next) gate = null;
  };
}

/** What selecting `id` waits for, or null to select at once. */
export function selectionGate(id: string): Promise<void> | null {
  return gate?.(id) ?? null;
}
