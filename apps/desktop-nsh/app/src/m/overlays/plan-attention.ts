import type { AcceptanceCheck, TaskDetail } from "@real-bot/protocol";
import { bySeverity, failingChecks } from "./acceptance-checks.ts";

/**
 * What in a plan needs you, said once wherever the plan is shown: the checks that failed, what is
 * written up as blocked, and your requirements waiting for your word. On 2026-10-09 the one failed
 * sample check sat as the first of eleven like-sized pills and nothing on the page said to look there.
 */
export type PlanAttention = {
  /** Failed checks, worst first, ties by their ticket's number. */
  failing: AcceptanceCheck[];
  /** Progress written up as blocked. */
  blocked: number;
  /** Requirements of yours waiting for your word: proposed, unverified, or asked to be withdrawn. */
  waitingRequirements: number;
  needsYou: boolean;
};

export function planAttention(detail: Pick<TaskDetail, "checks" | "requirements" | "spec" | "tickets">): PlanAttention {
  const seqs = new Map(detail.tickets.map((ticket) => [ticket.id, ticket.seq] as const));
  /** A check under a ticket sorts by that ticket's number among checks in the same state. */
  const ticketSeq = (check: AcceptanceCheck): number => (check.ticket_id ? seqs.get(check.ticket_id) : undefined) ?? Number.MAX_SAFE_INTEGER;
  const failing = bySeverity(failingChecks(detail.checks ?? []), ticketSeq);
  const blocked = detail.spec?.progress.blocked.length ?? 0;
  const waitingRequirements = (detail.requirements ?? []).filter(
    (entry) => !entry.excluded && (entry.status === "proposed" || entry.status === "unverified" || entry.withdraw_proposed),
  ).length;
  return { failing, blocked, waitingRequirements, needsYou: failing.length > 0 || blocked > 0 || waitingRequirements > 0 };
}

/** How many things need you: each failed check, the blocked progress, the waiting requirements. */
export function attentionCount(attention: PlanAttention): number {
  return attention.failing.length + attention.blocked + attention.waitingRequirements;
}
