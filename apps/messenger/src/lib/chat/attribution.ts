import type { Message, MessageFiling, PatchMessageAttributionRequest } from "@real-bot/protocol";

export type Filing = MessageFiling;
export type AttributionInput = PatchMessageAttributionRequest["filings"][number];
export type AttributedMessage = Message;
export type AttributionPlan = {
  id: string;
  title: string;
  tickets: { id: string; title: string }[];
};

export function messageFilings(message: AttributedMessage): Filing[] {
  if (message.filing_state === "undetermined" || message.filing_state === "none") return [];
  if (message.filings !== undefined) return message.filings;
  return message.task_id ? [{ task_id: message.task_id, ticket_id: message.ticket_id ?? null, part_key: null }] : [];
}

/** A line of yours or a Bot's that can be filed; the app's own control lines are not. */
export function attributable(message: AttributedMessage): boolean {
  return !message.control && (message.kind === "user" || message.kind === "bot");
}

/**
 * One filing in words, in parts so a narrow line can cut the long one: the plan's title (a plan is
 * named after the request that opened it, so it can be a whole sentence), then the ticket and the
 * part. A plan that has not loaded, or is gone, is `null` rather than its id.
 */
export function filingParts(filing: Filing, plans: readonly AttributionPlan[]): { plan: string | null; ticket: string | null; part: string | null } {
  const plan = plans.find((row) => row.id === filing.task_id);
  const ticket = plan?.tickets.find((row) => row.id === filing.ticket_id);
  return { plan: plan?.title || null, ticket: filing.ticket_id ? (ticket?.title ?? null) : null, part: filing.part_key };
}

export function filingLabel(filing: Filing, plans: readonly AttributionPlan[], unknownPlan = ""): string {
  const { plan, ticket, part } = filingParts(filing, plans);
  return [plan ?? unknownPlan, ticket, part].filter(Boolean).join(" · ");
}

/** What a message is filed under, as one comparable string; two lines with the same key are about the same thing. */
export function filingKey(message: AttributedMessage): string {
  return messageFilings(message)
    .map((row) => `${row.task_id}/${row.ticket_id ?? ""}/${row.part_key ?? ""}`)
    .sort()
    .join("+");
}

/**
 * The messages that show their filing: the first line of a run about the same thing, in each
 * conversation. Eighteen lines in a row that all say 「归到：同一件事」 are one fact said eighteen
 * times; the run's first line says it, and a line below it can still be changed from its menu.
 */
export function attributionChipIds(messages: readonly AttributedMessage[]): Set<string> {
  const shown = new Set<string>();
  const last = new Map<string, string>();
  const ordered = messages
    .filter(attributable)
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const message of ordered) {
    const key = filingKey(message);
    if (last.get(message.session_id) !== key) shown.add(message.id);
    last.set(message.session_id, key);
  }
  return shown;
}

function matches(plan: AttributionPlan, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return plan.title.toLowerCase().includes(needle) || plan.tickets.some((ticket) => ticket.title.toLowerCase().includes(needle));
}

/** When each job was last used in a conversation: the newest line filed under it. */
export function planUsage(messages: readonly AttributedMessage[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const message of messages) {
    for (const filing of messageFilings(message)) {
      const seen = last.get(filing.task_id);
      if (!seen || seen < message.created_at) last.set(filing.task_id, message.created_at);
    }
  }
  return last;
}

/**
 * The plans to offer when changing a filing. The daemon lists every plan in the workspace, newest
 * first — sixty-odd, most of them other conversations' errands — so the list is cut by where you are:
 * what is chosen stays on top, then the plans this conversation has already used, the one used last
 * first, then the rest, which stay folded away until you search or ask for them.
 */
export function rankPlans(input: {
  plans: readonly AttributionPlan[];
  chosen: readonly string[];
  lastUsed: ReadonlyMap<string, string>;
  query: string;
}): { chosen: AttributionPlan[]; here: AttributionPlan[]; others: AttributionPlan[] } {
  const { plans, query, lastUsed } = input;
  const chosen = new Set(input.chosen);
  const rest = plans.filter((plan) => !chosen.has(plan.id) && matches(plan, query));
  const recency = (plan: AttributionPlan) => lastUsed.get(plan.id) ?? "";
  return {
    chosen: plans.filter((plan) => chosen.has(plan.id)),
    here: rest.filter((plan) => lastUsed.has(plan.id)).sort((a, b) => (recency(a) < recency(b) ? 1 : recency(a) > recency(b) ? -1 : 0)),
    others: rest.filter((plan) => !lastUsed.has(plan.id)),
  };
}
