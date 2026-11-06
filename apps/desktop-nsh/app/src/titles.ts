/** A conversation's name in the list, as the messenger's `sidebar/session-title.ts` gives it. */
import { type Bot, type SessionSummary, USER_MEMBER as USER } from "@real-bot/protocol";

export function sessionTitle(session: SessionSummary, bots: Record<string, Bot>): string {
  if (session.kind === "group") return session.name ?? "群聊";
  if (session.kind === "project") return session.name ?? "新项目会话";
  const names = session.participants
    .filter((p) => !p.left_at && p.member !== USER)
    .map((p) => bots[p.member]?.name ?? "已删除的 Bot");
  return names.join(" ↔ ") || "私聊";
}

export function authorName(author: string, bots: Record<string, Bot>): string {
  if (author === USER) return "你";
  return bots[author]?.name ?? "Bot";
}

export function preview(session: SessionSummary, bots: Record<string, Bot>): string {
  const last = session.last_message;
  if (!last) return "";
  const who = last.author === USER ? "你：" : session.kind === "group" ? `${authorName(last.author, bots)}：` : "";
  return `${who}${last.body.replace(/\s+/g, " ").slice(0, 80)}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
