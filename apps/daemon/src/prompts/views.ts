/**
 * The built-in prompts as the settings tab, the local API and a Bot's `list_prompts` / `read_prompt`
 * see them (ADR 0064): each slot's state in each of its languages, and one slot in full — the text in
 * force, the fixed format, the default, and every change with who made it.
 */
import type { Locale, PromptDetail, PromptLocaleState, PromptRevision, PromptSummary } from "@real-bot/protocol";
import { HttpError } from "../errors";
import type { Store } from "../store";
import type { PromptOverride, PromptRevisionRow } from "../store/prompts";
import { hostPromptEnv, promptSlot } from "./book";
import { PLACEHOLDER_MEANING, renderDefault, SLOTS, type SlotDef } from "./registry";
import { promptMaxChars } from "./validate";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function localeState(store: Store, slot: SlotDef, locale: Locale, row: PromptOverride | null): PromptLocaleState {
  const head = store.promptHead(slot.id, locale);
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  return {
    locale,
    state: row ? (row.conflict_default !== null ? "conflict" : "edited") : "default",
    last_actor: head?.actor ?? null,
    last_bot_id: head?.bot_id ?? null,
    updated_at: head?.updated_at ?? null,
    parse_failures: slot.format
      ? {
          since_edit: row ? store.promptParseFailures(slot.id, locale, row.revision_id) : null,
          last_7_days: store.promptParseFailures(slot.id, locale, "any", since),
        }
      : null,
  };
}

function summaryOf(store: Store, slot: SlotDef, rows: Map<string, PromptOverride>): PromptSummary {
  return {
    id: slot.id,
    group: slot.group,
    title: slot.title,
    summary: slot.summary,
    ...(slot.role ? { role: slot.role } : {}),
    locales: slot.locales.map((locale) => localeState(store, slot, locale, rows.get(`${slot.id}\u0000${locale}`) ?? null)),
  };
}

function overridesByKey(store: Store): Map<string, PromptOverride> {
  return new Map(store.listPromptOverrides().map((row) => [`${row.prompt_id}\u0000${row.locale}`, row]));
}

/** Every slot, in the registry's order. */
export function listPromptSummaries(store: Store): PromptSummary[] {
  const rows = overridesByKey(store);
  return SLOTS.map((slot) => summaryOf(store, slot, rows));
}

function revisionView(store: Store, row: PromptRevisionRow, head: PromptRevisionRow | null, current: PromptOverride | null): PromptRevision {
  const source = store.promptRevisionSource(row);
  return {
    id: row.id,
    op: row.op,
    actor: row.actor,
    bot_id: row.bot_id,
    bot_name: source.bot_name,
    turn_id: row.turn_id,
    session_id: source.session_id,
    message_id: row.message_id,
    approval_id: row.approval_id,
    reason: row.reason,
    before_text: row.before_text,
    after_text: row.after_text,
    created_at: row.created_at,
    undoable: head?.id === row.id && (current?.text ?? null) === row.after_text,
  };
}

/** One slot in one of its languages, in full. */
export function promptDetail(store: Store, id: string, locale: string): PromptDetail {
  const slot = promptSlot(id);
  if (!(slot.locales as readonly string[]).includes(locale)) {
    throw new HttpError(422, "prompt_locale", `${id} comes in ${slot.locales.join(", ")}`);
  }
  const at = locale as Locale;
  const env = hostPromptEnv(store);
  const defaultText = renderDefault(slot, at, env);
  const rows = overridesByKey(store);
  const row = rows.get(`${id}\u0000${at}`) ?? null;
  const head = store.promptHead(id, at);
  return {
    ...summaryOf(store, slot, rows),
    locale: at,
    text: row?.text ?? defaultText,
    format: slot.format ? slot.format(at, env) : null,
    default_text: defaultText,
    base_text: row?.base_text ?? null,
    conflict_default: row?.conflict_default ?? null,
    placeholders: slot.placeholders.map((name) => ({ name, meaning: PLACEHOLDER_MEANING[name], required: name === "format" ? "once" : "at_least_once" })),
    no_brace: Boolean(slot.noBrace),
    max_chars: promptMaxChars(defaultText),
    head_revision_id: head?.id ?? null,
    revisions: store.listPromptRevisions(id, at, 50).map((revision) => revisionView(store, revision, head, row)),
    env,
  };
}
