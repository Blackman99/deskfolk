/**
 * The built-in prompts as the settings tab and the local API show them (ADR 0064): every text the
 * app ships to a model that you, or a Bot with your approval, can rewrite.
 */
import type { Locale } from "./constants.ts";
import type { BuiltinModelRole } from "./models.ts";

/** Where a prompt sits: every turn, the Claude Agent preface, tool descriptions, the app's own calls. */
export type PromptGroup = "turn" | "agent" | "tool" | "call";
/** Shipped as is; edited; edited, and a newer default did not merge with it (yours stays in force). */
export type PromptState = "default" | "edited" | "conflict";
export type PromptActor = "user" | "bot" | "app";
export type PromptOp = "edit" | "reset" | "merge" | "keep_mine" | "undo" | "restore";

export type PromptLocaleState = {
  locale: Locale;
  state: PromptState;
  /** Who made the latest change, and which Bot when it was one. */
  last_actor: PromptActor | null;
  last_bot_id: string | null;
  updated_at: string | null;
  /**
   * Answers to this call that came back and could not be read: since your edit (null while it is the
   * default), and in the last 7 days. Null for a prompt whose answers are not parsed.
   */
  parse_failures: { since_edit: number | null; last_7_days: number } | null;
};

export type PromptSummary = {
  id: string;
  group: PromptGroup;
  title: { zh: string; en: string };
  summary: { zh: string; en: string };
  /**
   * For one of the app's own calls, the built-in call whose model it runs on (ADR 0082); a daemon
   * from before it sends none.
   */
  role?: BuiltinModelRole;
  locales: PromptLocaleState[];
};

export type PromptRevision = {
  id: string;
  op: PromptOp;
  actor: PromptActor;
  bot_id: string | null;
  bot_name: string | null;
  turn_id: string | null;
  /** The conversation the Bot's change came from, to open at `message_id`. */
  session_id: string | null;
  message_id: string | null;
  approval_id: string | null;
  reason: string | null;
  /** Null is the default. */
  before_text: string | null;
  after_text: string | null;
  created_at: string;
  /** Only the latest change can be taken back, and only while the prompt still says what it wrote. */
  undoable: boolean;
};

export type PromptPlaceholder = {
  name: string;
  meaning: { zh: string; en: string };
  /** `{format}` goes in exactly once; the others at least once. */
  required: "once" | "at_least_once";
};

export type PromptDetail = PromptSummary & {
  locale: Locale;
  /** The editable part in force: yours, or the default. */
  text: string;
  /** The answer format the app fills in at `{format}`; never edited. Null for a prompt with none. */
  format: string | null;
  default_text: string;
  /** The default your version was written against; null while it is the default. */
  base_text: string | null;
  /** A newer default that did not merge with yours. */
  conflict_default: string | null;
  placeholders: PromptPlaceholder[];
  /** Once filled it may hold no `{` (its answer is read from the first one). */
  no_brace: boolean;
  max_chars: number;
  /** The latest change, to send back as `if_revision`. */
  head_revision_id: string | null;
  revisions: PromptRevision[];
  /** What the default is rendered for. */
  env: { level: number; shell: string };
};

export type PutPromptRequest = { text: string; if_revision: string | null; edit_session?: string };
export type PromptRevisionGuard = { if_revision: string | null };

/** A change an approval card let through: enough for the card's own Undo. */
export type PromptRevisionRef = { id: string; prompt_id: string; locale: Locale; undoable: boolean };
