/** Validate only the new attribution fields; legacy event parsing keeps its existing contract. */
export function validAttributionPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.event === "group_lead.changed") {
    if (typeof row.session_id !== "string" || !row.session_id
      || !(row.confirmed_bot_id === null || typeof row.confirmed_bot_id === "string")) return false;
    if (row.suggestion === null) return true;
    if (!row.suggestion || typeof row.suggestion !== "object" || Array.isArray(row.suggestion)) return false;
    const suggestion = row.suggestion as Record<string, unknown>;
    return typeof suggestion.bot_id === "string" && Boolean(suggestion.bot_id)
      && typeof suggestion.since === "string" && typeof suggestion.handoffs === "number"
      && Number.isSafeInteger(suggestion.handoffs) && suggestion.handoffs > 0;
  }
  const changed = row.event === "attribution.changed";
  const message = row.event === "message.created" || row.event === "message.upsert";
  if (!changed && !message) return true;
  const state = row.filing_state;
  if (state !== undefined && (typeof state !== "string" || !["filed", "undetermined", "none"].includes(state))) return false;
  if (changed && (typeof row.message_id !== "string" || typeof row.session_id !== "string" || state === undefined)) return false;
  if (row.filings === undefined) return !changed;
  if (!Array.isArray(row.filings) || row.filings.length > 100) return false;
  for (const value of row.filings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const filing = value as Record<string, unknown>;
    if (typeof filing.task_id !== "string" || !filing.task_id
      || !(filing.ticket_id === null || typeof filing.ticket_id === "string")
      || !(filing.part_key === null || typeof filing.part_key === "string")
      || (filing.filed_by !== undefined && typeof filing.filed_by !== "string")
      || (filing.is_primary !== undefined && typeof filing.is_primary !== "boolean")
      || (filing.strength !== undefined && (typeof filing.strength !== "string" || !["locked", "default", "bot", "user"].includes(filing.strength)))) return false;
  }
  return state === "filed" ? row.filings.length > 0 : state === undefined || row.filings.length === 0;
}
