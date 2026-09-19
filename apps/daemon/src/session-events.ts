/**
 * The `session.upsert` payload, in one place.
 *
 * It used to be inlined at a dozen call sites, and the copies in the turn engine had already
 * drifted — they dropped `archived_at`. A session now also carries where it came from, and a
 * dropped origin would quietly cost a Bot↔Bot direct its entry point, so every publisher
 * builds the payload here.
 */
export type SessionUpsertInput = {
  id: string;
  kind: "direct" | "group";
  name: string | null;
  last_read_at?: string | null;
  archived_at?: string | null;
  origin_session_id: string | null;
  origin_message_id: string | null;
  created_at: string;
  updated_at: string;
  participants: { member: string; joined_at: string; left_at: string | null }[];
  unread_count?: number;
};

export function sessionUpsertFields(session: SessionUpsertInput) {
  return {
    id: session.id,
    kind: session.kind,
    name: session.name,
    last_read_at: session.last_read_at ?? null,
    archived_at: session.archived_at ?? null,
    origin_session_id: session.origin_session_id,
    origin_message_id: session.origin_message_id,
    created_at: session.created_at,
    updated_at: session.updated_at,
    participants: session.participants,
    unread_count: session.unread_count ?? 0,
  };
}
