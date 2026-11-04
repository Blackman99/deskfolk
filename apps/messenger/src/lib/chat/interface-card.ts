import type { InterfacePatch } from "@real-bot/protocol";

/** What the daemon writes on a `ui-edit` card (collab-tools/interface.ts `interfaceEditSummary`). */
export type InterfaceCard = {
  head: string;
  reason: string;
  changes: string[];
  /** The change to try here; null when the card carries none, or it does not read. */
  patch: InterfacePatch | null;
  /** A revision to put back, when the card is a restore. */
  restore: string | null;
};

const MARK = "@@patch";

export function parseInterfaceCard(summary: string): InterfaceCard {
  const lines = summary.split("\n");
  const at = lines.indexOf(MARK);
  const text = at === -1 ? lines : lines.slice(0, at);
  const head = text[0]?.trim() ?? "";
  let reason = "";
  const changes: string[] = [];
  for (const line of text.slice(1)) {
    if (line.startsWith("- ")) changes.push(line.slice(2).trim());
    else if (!reason && line.trim()) reason = line.trim();
    // The daemon's "… N more" when the list was cut.
    else if (line.startsWith("…")) changes.push(line.trim());
  }
  let patch: InterfacePatch | null = null;
  let restore: string | null = null;
  if (at !== -1) {
    try {
      const parsed: unknown = JSON.parse(lines.slice(at + 1).join("\n").trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as Record<string, unknown>;
        if (typeof body.restore === "string" && body.restore) restore = body.restore;
        else patch = body as InterfacePatch;
      }
    } catch {
      // A card whose patch does not read still shows what it says.
    }
  }
  return { head, reason, changes, patch, restore };
}
