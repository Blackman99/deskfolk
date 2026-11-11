/**
 * The fold of the sidebar's column over the quarter second of the Svelte shell's grid transition:
 * how wide the column is a while into easing from one width to another, and `null` once it is
 * there. A frame at a time, each frame laid out afresh (`shell-state.ts`).
 *
 * The curve leaves fast and settles as the Svelte one (`cubic-bezier(0.16, 1, 0.3, 1)`) does, but
 * gentler: that one covers some five frames' share of the way in its first, and beside a long reply
 * laying the panes out after a step that big took some 40 ms, so the edge stood still for two or
 * three frames at the start. This one's first and largest step is under twice the share.
 */
export const SIDEBAR_FOLD_MS = 250;
const ease = (u: number) => 1 - (1 - u) * (1 - u);

export function sidebarFoldAt(from: number, to: number, elapsedMs: number): number | null {
  if (elapsedMs >= SIDEBAR_FOLD_MS) return null;
  return from + (to - from) * ease(Math.max(0, elapsedMs) / SIDEBAR_FOLD_MS);
}
