/**
 * Per-conversation composer drafts kept in `localStorage` so what you typed survives a crash,
 * a sudden quit, or a dev reload. Stored one key per conversation rather than one JSON blob so
 * each keystroke writes only that conversation's text and two windows editing different
 * conversations never overwrite each other.
 */
import { forgetStored, localStore, readStored, writeStored } from "../storage.ts";

export const COMPOSER_DRAFT_PREFIX = "real-bot-composer-draft:";

export function draftStorageKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_PREFIX}${sessionId}`;
}

/** The draft last kept for this conversation, or empty when none is stored. */
export function loadComposerDraft(sessionId: string): string {
  if (!sessionId) return "";
  return readStored(draftStorageKey(sessionId)) ?? "";
}

/** Keeps `text` verbatim (including spaces and newlines); an empty string removes the entry. */
export function saveComposerDraft(sessionId: string, text: string): void {
  if (!sessionId) return;
  const key = draftStorageKey(sessionId);
  if (text.length === 0) forgetStored(key);
  else writeStored(key, text);
}

/** Drops the stored draft for one conversation (e.g. once the conversation itself is deleted). */
export function forgetComposerDraft(sessionId: string): void {
  if (!sessionId) return;
  forgetStored(draftStorageKey(sessionId));
}

function storedDraftKeys(): string[] {
  const kept = localStore();
  if (!kept) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < kept.length; i++) {
      const key = kept.key(i);
      if (key && key.startsWith(COMPOSER_DRAFT_PREFIX)) keys.push(key);
    }
  } catch {
    return keys;
  }
  return keys;
}

/** Drops stored drafts for conversations that are no longer in the runtime's snapshot. */
export function pruneComposerDrafts(validSessionIds: ReadonlySet<string>): void {
  for (const key of storedDraftKeys()) {
    const sessionId = key.slice(COMPOSER_DRAFT_PREFIX.length);
    if (!validSessionIds.has(sessionId)) forgetStored(key);
  }
}

/** Drops every stored composer draft (used by tests to isolate runs). */
export function clearComposerDrafts(): void {
  for (const key of storedDraftKeys()) forgetStored(key);
}
