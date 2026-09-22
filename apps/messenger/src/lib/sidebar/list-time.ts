/**
 * The time a chat list shows next to a name: the clock for today, a word for yesterday, the
 * weekday for the rest of the week, then a date. It is the same ladder every messenger uses,
 * because the older a conversation is the less its hour matters.
 */
export function formatListTime(iso: string | null | undefined, nowMs: number, locale: "zh" | "en"): string {
  if (!iso) return "";
  const at = new Date(iso);
  const time = at.getTime();
  if (!Number.isFinite(time)) return "";
  const now = new Date(nowMs);
  const tag = locale === "zh" ? "zh-CN" : "en-US";

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= startOfToday) {
    return new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  }
  const dayMs = 86_400_000;
  if (time >= startOfToday - dayMs) return locale === "zh" ? "昨天" : "Yesterday";
  // Inside the last week the weekday is the quickest thing to read.
  if (time >= startOfToday - 6 * dayMs) {
    return new Intl.DateTimeFormat(tag, { weekday: "short" }).format(at);
  }
  if (at.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(tag, { month: "numeric", day: "numeric" }).format(at);
  }
  return new Intl.DateTimeFormat(tag, { year: "numeric", month: "numeric", day: "numeric" }).format(at);
}

/** What a row's time stands for: the last thing said, or when the conversation itself moved. */
export function listTimeSource(session: {
  last_message?: { created_at: string } | null;
  updated_at: string;
}): string {
  return session.last_message?.created_at ?? session.updated_at;
}
