/**
 * Popups that dismiss on an outside click share this predicate. Each keeps its own open flag and
 * its own element refs; the window handler stays one place so the order of those checks is visible.
 */
export function isOutside(target: Node | null, ...containers: (Node | null | undefined)[]): boolean {
  if (!target) return true;
  return containers.every((container) => !container?.contains(target));
}
