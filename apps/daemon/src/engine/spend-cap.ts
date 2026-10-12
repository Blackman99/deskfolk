/**
 * The day's spend cap (ADR 0088), from the scheduler's tick: once the calls made since local
 * midnight have cost what you set, every Bot is stopped by one hold of the app's, which waits for
 * your Lift. It stops them once a day per cap: a Lift lets them go on for the rest of the day, and
 * a new cap — or tomorrow — arms it again. A cap stop already in force is not made twice.
 */
import type { Store } from "../store";
import type { Stop } from "./stop";

export function createSpendCapWatch(deps: { store: Store; stops: Pick<Stop, "on" | "holdForSpendCap"> }) {
  const { store, stops } = deps;
  return function capSpend(at: Date): void {
    if (!stops.on()) return;
    const due = store.spendCapDue(at);
    if (!due) return;
    const standing = store.listHolds({ inForce: true }).some((hold) => hold.source === "spend_cap");
    const hold = standing ? null : stops.holdForSpendCap();
    store.transaction(() => store.noteSpendCapTrip({ day: due.day, capUsd: due.capUsd, spentUsd: due.spentUsd, holdId: hold?.id ?? null }));
  };
}
