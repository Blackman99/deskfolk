import type { DelegationView } from "@real-bot/protocol";

/** Synthetic only: no workspace paths, credentials, or real project records. */
export function aDelegation(over: Partial<DelegationView> = {}): DelegationView {
  return {
    id: "delegation-1", task_id: "plan-fixture", ticket_id: "ticket-fixture",
    thread_session_id: "botbot-1", from_bot_id: "bot-1", to_bot_id: "bot-2",
    ask: "审 Shot 11", expects: "review", status: "open",
    part_keys: ["Shot 11"], requirement_ids: ["requirement-fixture"],
    created_at: "2026-09-19T02:00:00.000Z", request_message_id: null, result_message_id: null,
    reply: null, wait: { state: "waiting", since: "2026-09-19T02:00:00.000Z", due_at: "2026-09-19T02:30:00.000Z" },
    ...over,
  };
}
