/**
 * G's labelled attribution: for each scripted line labelled with the plan it is meant to end up
 * filed under, does the plan it actually landed on agree? "kickoff" means the same plan the task
 * line itself opened; "new" means any plan other than that one. `run.ts` reads the plan a posted
 * line landed on from `messages.task_id`. The organizer's filing writes it (`applyOrganizerResult`,
 * `src/store/plan-spec.ts`) before any turn opens on the line or hears it, so a line delivered into
 * an already-running turn carries it as well. When the filing wrote nothing (the organizer skipped
 * the line, its call failed, or its answer was refused), the first turn that opens on the line
 * fills it in (`createTurn`, `src/store/turns.ts`). A line with neither reads as unfiled: a miss
 * under either label, since nothing records which plan it stayed on. `actual_bots` rides along for
 * the run log — which Bots this line woke, by turn trigger or a join judgement — but a hit is never
 * scored on it: which Bot answers is participation, not attribution.
 * Pure over that read, so the rule is unit-tested on its own.
 */
export type AttributionInput = {
  step_id: string;
  expect_plan: "kickoff" | "new";
  /** This step's message's `task_id` once the run ended, or null if it was never filed to a plan. */
  actual_task_id: string | null;
  /** The plan the task line itself opened, or null if that never got filed either. */
  kickoff_task_id: string | null;
  /** Informational only — see the doc comment above. */
  actual_bots: readonly string[];
};
export type AttributionRow = AttributionInput & { hit: boolean };
export type AttributionResult = { total: number; hits: number; rows: AttributionRow[] };

export function scoreAttribution(rows: readonly AttributionInput[]): AttributionResult {
  const scored = rows.map((row) => {
    const filed = row.actual_task_id !== null;
    const hit = row.expect_plan === "kickoff" ? filed && row.actual_task_id === row.kickoff_task_id : filed && row.actual_task_id !== row.kickoff_task_id;
    return { ...row, hit };
  });
  return { total: scored.length, hits: scored.filter((row) => row.hit).length, rows: scored };
}
