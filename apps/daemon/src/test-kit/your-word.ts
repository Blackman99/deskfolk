/**
 * Your 放行 in words, as the reader read it (ADR 0084), for scenarios about what an approval sets
 * going: the hand-over waiting on you on `ticketId` is let through by a line of yours in `room`, and
 * the work that wakes goes on. The line itself wakes nobody, so the test sees only what the approval
 * does; the reading of a real line is `submissions-engine.test.ts`'s.
 */
import { expect } from "bun:test";
import type { Scenario } from "./scenario";

export function letThroughByWord(h: Scenario, room: string, ticketId: string, body = "可以"): void {
  const [waiting] = h.store.listSubmissions({ ticketId }).filter((row) => row.awaiting?.kind === "approval");
  if (!waiting) throw new Error(`nothing on ticket ${ticketId} waits on you`);
  const line = h.store.postMessage(room, { body });
  expect(h.store.passByYourWord(line.id, { passes: [waiting.id], source: "model" }).lines).toHaveLength(1);
  h.engine.dispatchQueuedWork();
}
