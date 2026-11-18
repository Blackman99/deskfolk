/** Narrow validation for persisted delegation events, shared by local and encrypted remote frames. */
export function validDelegationPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.event !== "delegation.changed") return true;
  const text = (value: unknown): value is string => typeof value === "string";
  const nullableText = (value: unknown) => value === null || text(value);
  const strings = (value: unknown) => Array.isArray(value) && value.every(text);
  if (![row.id, row.task_id, row.thread_session_id, row.from_bot_id, row.to_bot_id, row.ask, row.created_at].every(text)
    || !nullableText(row.ticket_id) || !nullableText(row.request_message_id) || !nullableText(row.result_message_id)
    || typeof row.expects !== "string" || !["deliverable", "review", "answer"].includes(row.expects)
    || typeof row.status !== "string" || !["open", "replied", "cancelled"].includes(row.status)
    || !strings(row.part_keys) || !strings(row.requirement_ids)) return false;
  if (row.reply !== null) {
    if (!row.reply || typeof row.reply !== "object" || Array.isArray(row.reply)) return false;
    const reply = row.reply as Record<string, unknown>;
    if (!text(reply.body) || !text(reply.created_at) || !nullableText(reply.ref)) return false;
  }
  if (row.wait === null) return true;
  if (row.status !== "open" || !row.wait || typeof row.wait !== "object" || Array.isArray(row.wait)) return false;
  const wait = row.wait as Record<string, unknown>;
  return (wait.state === "waiting" || wait.state === "held") && text(wait.since) && nullableText(wait.due_at);
}
