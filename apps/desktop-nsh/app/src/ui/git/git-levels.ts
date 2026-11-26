/**
 * Shared mobile page drill-down history helpers for `ui/git/` views (ADR 0118).
 * Ties view-internal drill-down steps to `PageRoute`'s `#l<n>` history entries via `stepIn` and
 * `holdLevels` so the phone's system Back steps cleanly one level at a time instead of exiting Git.
 */
import { cleanup } from "nsh";
import { holdLevels } from "../../platform/page-levels";
import { stepIn } from "../../platform/page-route";
import { runtime } from "../../runtime";

export type GitHost = "pane" | "page";

/** Pushes a history level entry before applying a mobile drill-down transition. */
export function drillIn(activePageNarrow: boolean, apply: () => void): void {
  if (runtime.hosted && activePageNarrow) stepIn(apply);
  else apply();
}

/** Registers a Git subview's drill-down depth with `PageRoute` while mounted on a hosted page. */
export function registerGitLevels(opts: {
  name: string;
  active: () => boolean;
  depth: () => number;
  stepOut: () => void;
}): void {
  cleanup(
    holdLevels({
      name: opts.name,
      depth: () => (opts.active() ? opts.depth() : null),
      inModal: false,
      stepOut: opts.stepOut,
    }),
  );
}
