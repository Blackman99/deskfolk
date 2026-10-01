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

export function filingLabel(filing: Filing, plans: readonly AttributionPlan[]): string {
  const plan = plans.find((row) => row.id === filing.task_id);
  const ticket = plan?.tickets.find((row) => row.id === filing.ticket_id);
  return [plan?.title || filing.task_id, ticket?.title || filing.ticket_id, filing.part_key].filter(Boolean).join(" · ");
}
