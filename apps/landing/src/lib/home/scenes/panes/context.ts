import { getContext, setContext } from 'svelte';

/** What the recursive pane view needs from the scene that owns the layout. Read through getters. */
export type PaneCtx = {
  /** False for the finished picture on narrow screens: nothing to click, drag or focus. */
  readonly interactive: boolean;
  readonly focusId: string;
  /** More than one pane, so a pane may be closed. */
  readonly closable: boolean;
  readonly closeLabel: string;
  readonly resizeLabel: string;
  tabName(tab: number): string;
  focus(leafId: string): void;
  close(leafId: string): void;
  resize(splitId: string, ratio: number): void;
  openMenu(leafId: string, e: MouseEvent): void;
};

const KEY = Symbol('panes-ctx');
export const providePanes = (ctx: PaneCtx) => setContext(KEY, ctx);
export const usePanes = () => getContext<PaneCtx>(KEY);
