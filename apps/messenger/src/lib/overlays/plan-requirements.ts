import type { PlanRequirement, RequirementAction, TaskDetail } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/**
 * The requirements ledger as a plan's board shows it (ADR 0040 P3): what is in force here — the
 * plan's own, then what it inherits from each other plan of its conversation — then what waits for
 * you (proposed replacements and complaints kept whole), the old rules nobody found your words
 * for, and last what you set not to hold for this plan. The same entries, in the same statuses, are
 * what the Bots read in their situation.
 */
export type RequirementGroups = {
  own: PlanRequirement[];
  inherited: Array<{ taskId: string; title: string; entries: PlanRequirement[] }>;
  proposed: PlanRequirement[];
  unverified: PlanRequirement[];
  excluded: PlanRequirement[];
};

/** Said most often first, then oldest first: an entry keeps its place as others are added. */
function byWeight(a: PlanRequirement, b: PlanRequirement): number {
  return b.times_raised - a.times_raised || a.seq - b.seq;
}

export function requirementGroups(entries: readonly PlanRequirement[]): RequirementGroups {
  const groups: RequirementGroups = { own: [], inherited: [], proposed: [], unverified: [], excluded: [] };
  const from = new Map<string, RequirementGroups["inherited"][number]>();
  for (const entry of entries) {
    if (entry.excluded) groups.excluded.push(entry);
    else if (entry.status === "proposed") groups.proposed.push(entry);
    else if (entry.status === "unverified") groups.unverified.push(entry);
    else if (entry.inherited_from) {
      const group = from.get(entry.inherited_from.task_id) ?? { taskId: entry.inherited_from.task_id, title: entry.inherited_from.title, entries: [] };
      group.entries.push(entry);
      from.set(group.taskId, group);
    } else groups.own.push(entry);
  }
  groups.own.sort(byWeight);
  groups.proposed.sort(byWeight);
  groups.unverified.sort(byWeight);
  groups.excluded.sort(byWeight);
  groups.inherited = [...from.values()];
  for (const group of groups.inherited) group.entries.sort(byWeight);
  return groups;
}

/**
 * The buttons an entry offers on this plan's board, each only where the daemon takes it: a proposed
 * one or an old rule is confirmed or turned down; one it inherits can be set not to hold here, and
 * back; one of its own can be let go — except a line you typed on this board, which goes when you
 * take it out of the rules or Done when — and one that holds for this plan only can be made to hold
 * for the whole conversation, when there is one.
 */
export function requirementActions(entry: PlanRequirement, detail: Pick<TaskDetail, "session_id">): RequirementAction[] {
  if (entry.excluded) return ["here_again"];
  const inherits = entry.scope === "project" || entry.scope === "standing";
  if (entry.status === "proposed" || entry.status === "unverified") {
    return inherits && entry.inherited_from ? ["confirm", "reject", "not_here"] : ["confirm", "reject"];
  }
  if (entry.inherited_from && inherits) return ["not_here"];
  const actions: RequirementAction[] = [];
  if (entry.scope === "plan" && detail.session_id) actions.push("whole_project");
  if (entry.source_kind !== "board" || inherits) actions.push("waive");
  return actions;
}

/** Where an entry holds, in words: the ticket by its number and title, the plan, the conversation, or every job of a kind. */
export function requirementScope(entry: PlanRequirement, detail: Pick<TaskDetail, "tickets">, t: Copy["plan"]["requirements"]): string {
  if (entry.scope === "ticket" || entry.scope === "part") {
    const ticket = detail.tickets.find((row) => row.id === entry.ticket_id);
    return t.scope.ticket(ticket ? `${String(ticket.seq).padStart(2, "0")} ${ticket.title}` : "?");
  }
  if (entry.scope === "project") return t.scope.project;
  if (entry.scope === "standing") return t.scope.standing(entry.domain);
  return t.scope.plan;
}

/** Where the words came from: a line of yours, an answer, an annotation, the board, a complaint kept whole, or an old rule. */
export function requirementSource(entry: PlanRequirement, t: Copy["plan"]["requirements"]): string {
  if (entry.added_by === "capture") return t.source.capture;
  if (entry.source_kind === "legacy" && !entry.source) return t.source.legacy;
  if (entry.source?.via === "ask_answer") return t.source.ask_answer;
  if (entry.source?.via === "annotation") return t.source.annotation;
  if (entry.source_kind === "board" || entry.source?.via === "board") return t.source.board;
  return t.source.message;
}

/** How often you said it: nothing for once, the count (and across how many jobs) for more. */
export function requirementTimes(entry: PlanRequirement, t: Copy["plan"]["requirements"]): string | null {
  if (entry.times_raised < 2) return null;
  return entry.plans_raised >= 2 ? t.saidAcross(entry.times_raised, entry.plans_raised) : t.said(entry.times_raised);
}

/** How long ago the plan last changed, for the board's head: the unit and the count. */
export function changeAge(at: string, nowMs: number): { unit: "now" | "minute" | "hour" | "day"; count: number } {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) return { unit: "now", count: 0 };
  if (seconds < 3600) return { unit: "minute", count: Math.floor(seconds / 60) };
  if (seconds < 86_400) return { unit: "hour", count: Math.floor(seconds / 3600) };
  return { unit: "day", count: Math.floor(seconds / 86_400) };
}

/** 「上次变化 3 分钟前（任务 02《粗剪》：待验收）」, or null for a daemon that does not say. */
export function lastChangeLabel(detail: Pick<TaskDetail, "last_change">, nowMs: number, t: Copy["plan"]): string | null {
  const change = detail.last_change;
  if (!change) return null;
  const age = changeAge(change.at, nowMs);
  const ago = age.unit === "now" ? t.ago.now : t.ago[age.unit](age.count);
  return t.lastChange(ago, change.what);
}
