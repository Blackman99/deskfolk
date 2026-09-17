import type { Approval, Turn } from "@real-bot/protocol";

export function pendingCounts(approvals: readonly Approval[], turns: readonly Turn[]): Map<string, number> {
  const turnSession = new Map(turns.map((t) => [t.id, t.session_id]));
  const counts = new Map<string, number>();
  for (const a of approvals) {
    if (a.status !== "pending") continue;
    const sessionId = turnSession.get(a.turn_id);
    if (!sessionId) continue;
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  }
  return counts;
}
