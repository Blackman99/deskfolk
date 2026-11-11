/**
 * How small each pane of a branch may go, as the Svelte grid's tracks have it (`trackTemplate`'s
 * `min(<floor>px, <share of the branch>)`, `allocate()`'s "nothing fits"): each child's own minimum
 * while they all fit, and when the window is too small for all of them, every minimum shrunk by the
 * same ratio, so the panes share what there is. A floor the branch could not hold made the last
 * panes run off the window's edge and out of sight.
 *
 * `extent` is what the branch's children divide up along its axis (its length less the dividers,
 * `contentExtent`); null before the workbench has been measured, when the minimums stand as they are.
 */
export function cellFloors(floors: readonly number[], extent: number | null): number[] {
  const total = floors.reduce((sum, floor) => sum + Math.max(0, floor), 0);
  if (extent === null || total <= 0 || total <= extent) return floors.map((floor) => Math.max(0, floor));
  const scale = Math.max(0, extent) / total;
  return floors.map((floor) => Math.max(0, floor) * scale);
}
