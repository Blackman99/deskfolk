/**
 * Persisted fold state for sidebar sections (`bots`, `projects`) and project directories.
 * Stores only folded keys so newly created directories and sections default to open.
 */
import { forgetStored, readStored, writeStored } from "../storage.ts";

const DIRS_KEY = "real-bot-sidebar-folded-dirs";
const SECTIONS_KEY = "real-bot-sidebar-folded-sections";

export type SidebarSectionKey = "bots" | "projects";

function parseStringSet(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const item of parsed) {
      if (typeof item === "string" && item.length > 0) out[item] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function writeFoldedKeys(key: string, map: Readonly<Record<string, boolean>>): void {
  const folded = Object.entries(map)
    .filter(([, isFolded]) => isFolded)
    .map(([k]) => k);
  if (folded.length === 0) forgetStored(key);
  else writeStored(key, JSON.stringify(folded));
}

/** Directories the user explicitly folded (`true` means folded). */
export function loadFoldedDirs(): Record<string, boolean> {
  return parseStringSet(readStored(DIRS_KEY));
}

export function saveFoldedDirs(folded: Readonly<Record<string, boolean>>): void {
  writeFoldedKeys(DIRS_KEY, folded);
}

/** Top-level sidebar sections the user explicitly folded (`true` means folded). */
export function loadFoldedSections(): Partial<Record<SidebarSectionKey, boolean>> {
  const parsed = parseStringSet(readStored(SECTIONS_KEY));
  const out: Partial<Record<SidebarSectionKey, boolean>> = {};
  if (parsed.bots) out.bots = true;
  if (parsed.projects) out.projects = true;
  return out;
}

export function saveFoldedSections(folded: Readonly<Partial<Record<SidebarSectionKey, boolean>>>): void {
  writeFoldedKeys(SECTIONS_KEY, folded as Record<string, boolean>);
}
