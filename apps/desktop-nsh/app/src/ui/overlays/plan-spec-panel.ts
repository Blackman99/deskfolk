/**
 * The pure parts of the plan's spec panel (`overlays/PlanSpecPanel.svelte`): which fields it lists
 * and in what order, their labels, who wrote a version, and how the acceptance checks are grouped
 * under it. No signals here; `plan-spec-state.ts` holds the state.
 */
import type { AcceptanceCheck, PlanSpec, TaskDetail } from "@real-bot/protocol";
import type { Copy } from "../../m/copy.ts";
import { bySeverity, checksByItem, checkSummary, derivedChecks, orphanChecks, sampleChecks } from "../../m/overlays/acceptance-checks.ts";
import { specLines, type SpecListField } from "../../m/overlays/plan-board.ts";

export type Editing = "title" | "goal" | SpecListField;

export const GUIDELINE_FIELDS: readonly SpecListField[] = ["acceptance", "rules", "process"];
/** Blocked, open, then done; a field with nothing written goes after those with something. */
export const PROGRESS_FIELDS: readonly SpecListField[] = ["progress.blocked", "progress.open", "progress.done"];
/** How many failed checks the "needs you" block names; the rest are counted. */
export const ATTENTION_CHECKS = 3;

export function progressFieldsOf(spec: PlanSpec | null): SpecListField[] {
  if (!spec) return [];
  return [...PROGRESS_FIELDS].sort((a, b) => Number(specLines(spec, a).length === 0) - Number(specLines(spec, b).length === 0));
}

export function fieldLabel(t: Copy, field: SpecListField): string {
  if (field === "acceptance") return t.plan.spec.acceptance;
  if (field === "rules") return t.plan.spec.rules;
  if (field === "process") return t.plan.spec.process;
  const sub = field === "progress.done" ? t.plan.spec.done : field === "progress.open" ? t.plan.spec.open : t.plan.spec.blocked;
  return `${t.plan.spec.progress} · ${sub}`;
}

/**
 * Who wrote a version: you, the app's filing, or a stop of yours parking the plan or putting it
 * back — the app wrote that one too, but it is no filing and says so.
 */
export function actorLabel(t: Copy, actor: "app" | "user" | null, cause: "hold" | null | undefined): string {
  if (cause === "hold") return t.plan.byHold;
  return actor === "user" ? t.plan.byUser : t.plan.byApp;
}

export function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** Done is folded while anything is still open or blocked. */
export function doneFoldedByDefault(spec: PlanSpec | null): boolean {
  return (spec?.progress.open.length ?? 0) + (spec?.progress.blocked.length ?? 0) > 0;
}

export type CheckGroups = {
  orphaned: AcceptanceCheck[];
  fromYourWords: AcceptanceCheck[];
  /** Held to the approved sample (ADR 0060): one line, each ticket's check under it, failures first. */
  heldToSample: Array<{ item: string; checks: AcceptanceCheck[] }>;
  total: { pass: number; total: number };
  anyRunning: boolean;
};

export function checkGroups(detail: TaskDetail): CheckGroups {
  const checks = detail.checks ?? [];
  const seqs = new Map(detail.tickets.map((ticket) => [ticket.id, ticket.seq] as const));
  /** A check under a ticket sorts by that ticket's number among checks in the same state. */
  const ticketSeq = (check: AcceptanceCheck): number => (check.ticket_id ? seqs.get(check.ticket_id) : undefined) ?? Number.MAX_SAFE_INTEGER;
  return {
    orphaned: bySeverity(orphanChecks(checks, detail.spec?.acceptance ?? []), ticketSeq),
    fromYourWords: derivedChecks(checks),
    heldToSample: checksByItem(sampleChecks(checks)).map((group) => ({ item: group.item, checks: bySeverity(group.checks, ticketSeq) })),
    total: checkSummary(checks),
    anyRunning: checks.some((check) => check.running),
  };
}
