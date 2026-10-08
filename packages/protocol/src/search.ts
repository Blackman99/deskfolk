import type { ListPage } from "./runtime.ts";

export type SearchKind = "bot" | "session" | "message" | "routine" | "file";

export type SearchHit = {
  kind: SearchKind;
  id?: string;
  path?: string;
  snippet?: string;
  session_id?: string;
  session_title?: string;
  parent_id?: string | null;
  avatar?: string | null;
};

/** One composer draft the user can send next, suggested from the current transcript. */
export type ComposerSuggestion = {
  id: string;
  /** Chip text shown above the composer. */
  label: string;
  /** Full draft inserted into the composer; may include `@Name` / `@everyone`. */
  prompt: string;
};

export type ComposerSuggestionsPage = ListPage<ComposerSuggestion>;
