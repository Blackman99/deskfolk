import type { SessionSummary } from "@real-bot/protocol";

const STORAGE_KEY = "real-bot-sidebar-working-only";

/** Whether the session list shows only the conversations a Bot is working in. */
export function loadWorkingOnly(): boolean {
  if (typeof window === "undefined" || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveWorkingOnly(on: boolean): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

type Listed = {
  groups: SessionSummary[];
  youBot: SessionSummary[];
  botBot: SessionSummary[];
  fileDrop: SessionSummary | null;
};

/**
 * The list's sections cut down to `ids`, or left alone when there is no filter. The pins are not
 * touched: they are a shortcut row, kept whole in the list and in its rail alike.
 */
export function onlyWorking<T extends Listed>(grouped: T, ids: ReadonlySet<string> | null): T {
  if (!ids) return grouped;
  const keep = (session: SessionSummary) => ids.has(session.id);
  return {
    ...grouped,
    groups: grouped.groups.filter(keep),
    youBot: grouped.youBot.filter(keep),
    botBot: grouped.botBot.filter(keep),
    fileDrop: grouped.fileDrop && keep(grouped.fileDrop) ? grouped.fileDrop : null,
  };
}
