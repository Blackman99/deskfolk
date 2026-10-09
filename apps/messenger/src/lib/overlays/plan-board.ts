/**
 * Pure helpers for the plan board: the spec panel and the ticket rail beside the trace.
 *
 * Nothing here touches the DOM or the network — it is the arithmetic and shaping that
 * `PlanSpecPanel.svelte` and `TicketList.svelte` lean on, kept testable on its own.
 */
import {
  USER_MEMBER,
  type AcceptanceCheck,
  type Attachment,
  type Bot,
  type PlanRequirement,
  type PlanSpec,
  type SessionTaskSummary,
  type TaskDetail,
  type TaskTraceNode,
  type TicketCounts,
  type TicketStatus,
  type TicketWithArtifacts,
} from "@real-bot/protocol";
import { avatarSrc, botAvatarColor, type AvatarPalette } from "../avatar.ts";
import { rosterLetter } from "../sidebar/roster-letter.ts";

/** The spec's list-shaped fields, in the order the panel lays them out. */
export type SpecListField = "acceptance" | "rules" | "process" | "progress.done" | "progress.open" | "progress.blocked";

export const SPEC_LIST_FIELDS: readonly SpecListField[] = [
  "acceptance",
  "rules",
  "process",
  "progress.done",
  "progress.open",
  "progress.blocked",
];

/** The order tickets and their status pills read in, todo to parked. */
export const TICKET_STATUS_ORDER: readonly TicketStatus[] = ["todo", "doing", "review", "done", "parked"];

/** The two-digit tag on a ticket's card: "01", "12". */
export function ticketTag(seq: number): string {
  return String(seq).padStart(2, "0");
}

/**
 * What a job is called on the board: its name — the one its tags and every Bot's picture use, and
 * that you can change in its 要点 — else its goal, else the work dir. The goal came first while a
 * name could not be changed (2026-10-03: the board called 《一拳超人》 by its goal while its tags
 * and the Bots called it 「让审片员回复视频导演…」).
 */
export function planTitle(row: { goal?: string | null; title: string; dir: string }): string {
  const title = row.title?.trim();
  if (title) return title;
  const goal = row.goal?.trim();
  if (goal) return goal;
  return row.dir;
}

/** The non-zero counts, in status order. */
export function countsEntries(counts: TicketCounts | null | undefined): Array<{ status: TicketStatus; count: number }> {
  if (!counts) return [];
  const entries: Array<{ status: TicketStatus; count: number }> = [];
  for (const status of TICKET_STATUS_ORDER) {
    const count = counts[status] ?? 0;
    if (count > 0) entries.push({ status, count });
  }
  return entries;
}

/** Tickets still moving: todo, doing, and review. */
export function openTicketCount(counts: TicketCounts | null | undefined): number {
  if (!counts) return 0;
  return (counts.todo ?? 0) + (counts.doing ?? 0) + (counts.review ?? 0);
}

/** Every ticket the plan has, in any status. */
export function totalTicketCount(counts: TicketCounts | null | undefined): number {
  if (!counts) return 0;
  return TICKET_STATUS_ORDER.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
}

/** Tickets dropped by their lead or set aside on the board: parked, work nobody is left to do. */
export function parkedTicketCount(counts: TicketCounts | null | undefined): number {
  return counts?.parked ?? 0;
}

/** Every ticket that is not parked: the ones the job's progress is a share of. */
export function countedTicketCount(counts: TicketCounts | null | undefined): number {
  return totalTicketCount(counts) - parkedTicketCount(counts);
}

/**
 * Percentage of tickets in done status (0 to 100, rounded). A dropped or set-aside ticket is neither
 * done nor still to do, so it is left out of the whole: a job that finished everything it kept reads 100.
 */
export function completionPercentage(counts: TicketCounts | null | undefined): number {
  const total = countedTicketCount(counts);
  if (total === 0) return 0;
  const done = counts?.done ?? 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/**
 * How a job that is no longer being worked on reads on its board: `dormant` (set aside with its
 * conversation), `parked` (set aside), `ended` (done); null while it is going. The same order the
 * daemon's ball goes by (`ballMoves` in plan-spec.ts): in none of these does anyone pick up a ticket
 * left open.
 */
export type BoardState = "dormant" | "parked" | "ended";

export function boardState(detail: Pick<SessionTaskSummary, "status" | "dormant_since">): BoardState | null {
  if (detail.dormant_since) return "dormant";
  if (detail.status === "parked") return "parked";
  if (detail.status === "done") return "ended";
  return null;
}

/**
 * A job that was one question and its answer: no tickets, one turn at most, and closed. The switcher
 * folds those, so the jobs that were work stay in view. A daemon that does not count turns (no
 * `turn_count`) never folds a job.
 */
export function isOneShot(summary: SessionTaskSummary): boolean {
  if (summary.turn_count === undefined || summary.turn_count > 1) return false;
  if (totalTicketCount(summary.ticket_counts) > 0) return false;
  return summary.status !== "active" || Boolean(summary.closed_at) || Boolean(summary.dormant_since);
}

/** The job the board opens on when none is asked for: the newest that is not a one-shot, else the newest. `jobs` is newest first. */
export function defaultJob<T extends SessionTaskSummary>(jobs: readonly T[]): T | null {
  return jobs.find((job) => !isOneShot(job)) ?? jobs[0] ?? null;
}

/** The newest node that worked in that ticket — by `created_at`, ties broken by array order. */
export function latestTurnOfTicket(nodes: readonly TaskTraceNode[], ticketId: string): TaskTraceNode | null {
  let best: TaskTraceNode | null = null;
  let bestTime = -Infinity;
  for (const node of nodes) {
    if (node.ticket_id !== ticketId) continue;
    const time = new Date(node.created_at).getTime();
    if (best === null || time >= bestTime) {
      best = node;
      bestTime = time;
    }
  }
  return best;
}

/**
 * How one item of the plan — a requirement of yours, a check — stands to the ticket in focus: held
 * to that ticket alone (`mine`), to another ticket alone (`other`), or to the whole plan (null), and
 * so to every ticket, the one in focus among them. Nothing is in focus: null throughout.
 */
export function ticketBinding(itemTicketId: string | null | undefined, focus: string | null): "mine" | "other" | null {
  if (!focus || !itemTicketId) return null;
  return itemTicketId === focus ? "mine" : "other";
}

/** The ticket a requirement holds for alone: a ticket's or a part's entry; null for one over the plan or wider. */
export function requirementTicket(entry: Pick<PlanRequirement, "scope" | "ticket_id">): string | null {
  return entry.scope === "ticket" || entry.scope === "part" ? entry.ticket_id : null;
}

/**
 * What one ticket has to meet. Every ticket meets the plan's acceptance and rules — its `ticket.md`
 * carries them under its own description — and your requirements in force over the plan; on top of
 * those, the requirements and checks held to it alone. Proposed, old and excluded entries hold
 * nothing yet, so they are not counted.
 */
export type TicketObligations = {
  acceptance: number;
  rules: number;
  /** Your requirements in force over the whole plan, and so over this ticket. */
  planRequirements: number;
  /** Your requirements in force for this ticket alone. */
  requirements: PlanRequirement[];
  /** The checks filed under this ticket. */
  checks: AcceptanceCheck[];
};

export function ticketObligations(
  detail: Pick<TaskDetail, "spec" | "requirements" | "checks">,
  ticketId: string,
): TicketObligations {
  const inForce = (detail.requirements ?? []).filter((entry) => entry.status === "open" && !entry.excluded);
  return {
    acceptance: detail.spec?.acceptance.length ?? 0,
    rules: detail.spec?.rules.length ?? 0,
    planRequirements: inForce.filter((entry) => requirementTicket(entry) === null).length,
    requirements: inForce.filter((entry) => requirementTicket(entry) === ticketId).sort((a, b) => a.seq - b.seq),
    checks: (detail.checks ?? []).filter((check) => check.ticket_id === ticketId),
  };
}

/** A ticket's artifacts as `Attachment`s, built the way `TraceView.openNodeArtifacts` builds siblings. */
export function ticketArtifactAttachments(ticket: TicketWithArtifacts): Attachment[] {
  return ticket.artifacts.map((file) => ({
    id: file.attachment_id,
    message_id: file.message_id,
    workspace_relpath: file.path,
    original_filename: file.path.split("/").pop() || file.path,
    created_at: ticket.updated_at,
    ...(file.exists === undefined ? {} : { exists: file.exists }),
  }));
}

/** The row to open first: an existing non-dir file, else any existing row, else the first row. */
export function firstPreviewable(rows: readonly Attachment[]): Attachment | null {
  if (rows.length === 0) return null;
  return (
    rows.find((row) => row.exists !== false && !row.is_dir) ??
    rows.find((row) => row.exists !== false) ??
    rows[0]!
  );
}

/** One list field of a spec, read out as its lines. */
export function specLines(spec: PlanSpec, field: SpecListField): string[] {
  if (field === "progress.done") return spec.progress.done;
  if (field === "progress.open") return spec.progress.open;
  if (field === "progress.blocked") return spec.progress.blocked;
  return spec[field];
}

const BULLET_PREFIX = /^[-•]\s*(.*)$/;

/** A textarea's text, one line per item: trimmed, blanks and exact repeats dropped, bullets stripped. */
export function parseSpecLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const bullet = BULLET_PREFIX.exec(trimmed);
    const stripped = bullet ? bullet[1]!.trim() : trimmed;
    if (!stripped || seen.has(stripped)) continue;
    seen.add(stripped);
    lines.push(stripped);
  }
  return lines;
}

/** A new spec with one list field replaced. Never mutates `spec`. */
export function specWithLines(spec: PlanSpec, field: SpecListField, lines: string[]): PlanSpec {
  const next: PlanSpec = { ...spec, progress: { ...spec.progress } };
  if (field === "progress.done") next.progress.done = lines;
  else if (field === "progress.open") next.progress.open = lines;
  else if (field === "progress.blocked") next.progress.blocked = lines;
  else next[field] = lines;
  return next;
}

/** A new spec with the goal replaced. A blank edit keeps the old goal. */
export function specWithGoal(spec: PlanSpec, goal: string): PlanSpec {
  const trimmed = goal.trim();
  return { ...spec, progress: { ...spec.progress }, goal: trimmed || spec.goal };
}

export type ActorFace = { src: string | null; letter: string; palette: AvatarPalette | null };

/** How to draw an actor's face: you, a known Bot, or a Bot that has since been deleted. */
export function actorFace(
  actor: string,
  botsById: ReadonlyMap<string, Bot>,
  youLabel: string,
  deletedLabel: string,
): ActorFace {
  if (actor === USER_MEMBER) return { src: null, letter: rosterLetter(youLabel), palette: null };
  const bot = botsById.get(actor);
  const name = bot?.name ?? deletedLabel;
  return { src: avatarSrc(bot?.avatar), letter: rosterLetter(name), palette: botAvatarColor(actor) };
}

/** An actor's display name: you, a known Bot's name, or the deleted label. */
export function actorName(
  actor: string,
  botsById: ReadonlyMap<string, Bot>,
  youLabel: string,
  deletedLabel: string,
): string {
  if (actor === USER_MEMBER) return youLabel;
  return botsById.get(actor)?.name ?? deletedLabel;
}
