import { isHiddenTranscriptKind, USER_MEMBER, type Message, type SessionSummary } from "@real-bot/protocol";

export function isSessionUnread(unreadCount: number | undefined | null, _selected: boolean = false): boolean {
  return (unreadCount ?? 0) > 0;
}

export function unreadBadge(unreadCount: number): string {
  if (unreadCount > 99) return "99+";
  return String(unreadCount);
}

export function countsAsUnread(
  message: Pick<Message, "parent_id" | "author"> & { kind?: Message["kind"] },
): boolean {
  if (message.kind && isHiddenTranscriptKind(message.kind)) return false;
  return message.author !== USER_MEMBER;
}

export type SessionUnreadTarget = Pick<SessionSummary, "id" | "last_message"> & {
  unread_count?: number;
  last_read_at?: string | null;
};

export function sessionUnreadCount(
  session: SessionUnreadTarget,
  _selectedId?: string | null,
): number {
  if (typeof session.unread_count === "number") return session.unread_count;
  const last = session.last_message;
  if (!last || isHiddenTranscriptKind(last.kind) || !countsAsUnread(last)) return 0;
  if (!session.last_read_at || last.created_at > session.last_read_at) return 1;
  return 0;
}
