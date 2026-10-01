/** The ended-work question is a persisted card, not a live ask or permission prompt. */
export function validWorkQuestionPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (payload.event !== "message.created" && payload.event !== "message.upsert") return true;
  const control = payload.control;
  if (!control || typeof control !== "object" || Array.isArray(control)) return true;
  const row = control as Record<string, unknown>;
  if (row.kind !== "work_question") return true;
  const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
  if (!nonempty(row.work_item_id) || !nonempty(row.task_id) || !(row.ticket_id === null || nonempty(row.ticket_id))
    || !nonempty(row.question) || !Array.isArray(row.offer) || row.offer.length !== 0) return false;
  if (row.answer === undefined) return true;
  if (!row.answer || typeof row.answer !== "object" || Array.isArray(row.answer)) return false;
  const answer = row.answer as Record<string, unknown>;
  return nonempty(answer.body) && nonempty(answer.at) && nonempty(answer.user_action_id)
    && typeof answer.inbox_seq === "number" && Number.isSafeInteger(answer.inbox_seq) && answer.inbox_seq > 0;
}
