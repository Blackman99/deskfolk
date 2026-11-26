/**
 * Shared formatting and palette helpers for `ui/git/` components (ADR 0118).
 */
import type { GitFileStatus } from "@real-bot/protocol";
import { token } from "nsh";
import { RelativeTimeFormat } from "../../platform/relative-time.ts";

/** Formats an ISO timestamp as a concise relative string in zh or en. */
export function formatRelativeIso(iso: string | null | undefined, locale: "zh" | "en"): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const sec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(sec);
  const rtf = new RelativeTimeFormat(locale === "en" ? "en" : "zh-CN", { numeric: "auto" });
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
  if (abs < 86400 * 14) return rtf.format(Math.round(sec / 86400), "day");
  if (abs < 86400 * 60) return rtf.format(Math.round(sec / (86400 * 7)), "week");
  if (abs < 86400 * 365) return rtf.format(Math.round(sec / (86400 * 30)), "month");
  return rtf.format(Math.round(sec / (86400 * 365)), "year");
}

/** Semantic colour classes for git file status letters. */
export function statusBadgeClass(status: GitFileStatus): { bg: string; text: string } {
  switch (status) {
    case "A":
    case "?":
      return { bg: "bg-ok-bg", text: "text-ok-text" };
    case "D":
      return { bg: "bg-danger-bg", text: "text-danger-text" };
    case "U":
      return { bg: "bg-warn-bg", text: "text-warn-text" };
    case "R":
    case "C":
      return { bg: "bg-purple-bg", text: "text-purple-text" };
    default:
      return { bg: "bg-sky-bg", text: "text-sky-text" };
  }
}

/** Lane colours drawn from Deskfolk's own semantic theme tokens so dark/light mode stay harmonious. */
const LANE_TOKEN_KEYS = ["brand", "purple", "ok", "warn", "sky-text", "danger"] as const;

export function laneStrokeColor(colorIndex: number): string {
  const key = LANE_TOKEN_KEYS[Math.abs(colorIndex) % LANE_TOKEN_KEYS.length]!;
  return token(key);
}

/** Splits a repository-relative path into filename and parent directory for compact list display. */
export function splitRepoPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { name: path, dir: "" };
  return { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}
