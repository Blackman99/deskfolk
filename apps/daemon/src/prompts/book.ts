/**
 * Built-in prompts for one hop or one call (ADR 0064): your version of a slot where you edited it,
 * else the default the app ships, with the fixed answer format and the call's own values filled in.
 * A page is built when it is needed and thrown away; nothing here is cached or global, so two stores
 * (two tests, a copy of the database) never see each other's edits.
 */
import { merge3Lines, type Locale } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { toolShell } from "../platform";
import type { Store } from "../store";
import type { PromptLocale, PromptRevisionRow, WritePromptInput } from "../store/prompts";
import { fill, type Placeholder } from "./fill";
import { renderDefault, slotDef, slotLocale, type PromptEnv, type PromptRef, type SlotDef } from "./registry";
import type { TurnPromptTexts } from "./system";
import { validatePromptText, type PromptProblem } from "./validate";

/** One slot you edited, as the store keeps it. */
export type PromptOverrideRow = { prompt_id: string; locale: Locale; text: string; revision_id: string };

/** Where edits come from: the store. Without one a page gives only the defaults. */
export type PromptSource = {
  promptOverrides(): PromptOverrideRow[];
  capabilities(): { engine_level: number };
};

/** The text a call sends and which built-in prompt (and revision of yours) it is. */
export type PromptUse = { text: string; ref: PromptRef };

export type PromptPage = {
  /** The level and shell the defaults are rendered for. */
  env: PromptEnv;
  /** Your text for a slot, or undefined while it is the default. */
  edited(id: string): string | undefined;
  /** What to send: your text or the default, with the fixed format and `values` filled in. */
  resolve(id: string, values?: Partial<Record<Exclude<Placeholder, "format">, string>>, env?: PromptEnv): PromptUse;
};

export function promptPage(source: PromptSource | null, locale: Locale, env: Partial<PromptEnv> = {}): PromptPage {
  const at: PromptEnv = { level: env.level ?? source?.capabilities().engine_level ?? 0, shell: env.shell ?? toolShell().kind };
  const rows = new Map((source?.promptOverrides() ?? []).map((row) => [`${row.prompt_id}\u0000${row.locale}`, row]));
  const mine = (id: string): PromptOverrideRow | undefined => {
    const slot = slotDef(id);
    return slot ? rows.get(`${id}\u0000${slotLocale(slot, locale)}`) : undefined;
  };
  return {
    env: at,
    edited: (id) => mine(id)?.text,
    resolve(id, values = {}, renderAt = at) {
      const slot = slotDef(id);
      if (!slot) throw new Error(`no built-in prompt ${id}`);
      const used = slotLocale(slot, locale);
      const row = mine(id);
      const template = row?.text ?? renderDefault(slot, used, renderAt);
      const format = slot.format?.(used, renderAt);
      return {
        text: fill(template, format === undefined ? values : { ...values, format }),
        ref: { id, locale: used, revision_id: row?.revision_id ?? null },
      };
    },
  };
}

/** The turn texts you edited, for `turnSystemPrompt` and `agentSystemPrompt`; the rest stay default. */
export function turnPromptTexts(page: PromptPage): TurnPromptTexts & { preface?: string } {
  return {
    system: page.edited("turn.system"),
    skills: page.edited("turn.skills"),
    memory: page.edited("turn.memory"),
    mcp: page.edited("turn.mcp"),
    preface: page.edited("agent.preface"),
  };
}

/** Tool descriptions you edited, for `builtinTools`. */
export function editedToolDescription(page: PromptPage): (name: string) => string | undefined {
  return (name) => page.edited(`tool.${name}`);
}

// ---------------------------------------------------------------------------
// Changing them (ADR 0064): your edits, a Bot's you approved, and the app merging a newer default in.
// ---------------------------------------------------------------------------

/** The defaults this daemon renders: its engine level and its own shell. */
export function hostPromptEnv(store: Pick<Store, "capabilities">): PromptEnv {
  return { level: store.capabilities().engine_level, shell: toolShell().kind };
}

export function promptSlot(id: string): SlotDef {
  const slot = slotDef(id);
  if (!slot) throw new HttpError(404, "not_found", `no built-in prompt ${id}`);
  return slot;
}

function slotLanguage(slot: SlotDef, locale: string): PromptLocale {
  if (!(slot.locales as readonly string[]).includes(locale)) throw new HttpError(422, "prompt_locale", `${slot.id} comes in ${slot.locales.join(", ")}`);
  return locale as PromptLocale;
}

/** A refused text: the first problem's code, and every problem as `code[:detail]` in the message. */
export function promptProblemsError(problems: PromptProblem[]): HttpError {
  return new HttpError(422, problems[0]!.code, problems.map((p) => (p.detail ? `${p.code}:${p.detail}` : p.code)).join("; "));
}

export type PromptChangeBy = {
  actor: "user" | "bot";
  botId?: string | null;
  turnId?: string | null;
  approvalId?: string | null;
  messageId?: string | null;
  reason?: string | null;
};

/**
 * Saves a slot's new text: checked, written against the default it already stood on (or the current
 * one), and put back on the default when it says exactly what the default says.
 */
export function savePromptText(
  store: Store,
  input: { id: string; locale: string; text: string; ifRevision?: string | null; editSession?: string | null } & PromptChangeBy,
): PromptRevisionRow | null {
  const slot = promptSlot(input.id);
  const locale = slotLanguage(slot, input.locale);
  const env = hostPromptEnv(store);
  const current = renderDefault(slot, locale, env);
  const checked = validatePromptText(slot, locale, input.text, current);
  if (!checked.ok) throw promptProblemsError(checked.problems);
  const existing = store.promptOverride(input.id, locale);
  const toDefault = checked.text === current;
  return store.writePrompt({
    id: input.id,
    locale,
    text: toDefault ? null : checked.text,
    base: toDefault ? null : (existing?.base_text ?? current),
    baseEnv: existing ? undefined : env,
    op: "edit",
    actor: input.actor,
    botId: input.botId,
    turnId: input.turnId,
    approvalId: input.approvalId,
    messageId: input.messageId,
    reason: input.reason,
    ifRevision: input.ifRevision,
    editSession: input.editSession,
  });
}

/** Puts a slot back on its default. */
export function resetPromptText(store: Store, input: { id: string; locale: string; ifRevision?: string | null } & PromptChangeBy): PromptRevisionRow | null {
  const slot = promptSlot(input.id);
  const locale = slotLanguage(slot, input.locale);
  return store.writePrompt({
    id: input.id, locale, text: null, base: null, op: "reset", actor: input.actor, botId: input.botId, turnId: input.turnId,
    approvalId: input.approvalId, messageId: input.messageId, reason: input.reason, ifRevision: input.ifRevision,
  });
}

/** Your text against a newer default you were shown: keep yours, now standing on that default. */
export function keepMyPrompt(store: Store, input: { id: string; locale: string; ifRevision?: string | null }): PromptRevisionRow | null {
  const slot = promptSlot(input.id);
  const locale = slotLanguage(slot, input.locale);
  const existing = store.promptOverride(input.id, locale);
  if (!existing?.conflict_default) throw new HttpError(422, "prompt_no_conflict", "there is no newer default to keep yours against");
  return store.writePrompt({ id: input.id, locale, text: existing.text, base: existing.conflict_default, op: "keep_mine", actor: "user", ifRevision: input.ifRevision });
}

/**
 * Writes `text` standing on `base`, as of now: on the current default it is written as it is; on an
 * older one it is merged with the current default, and a merge that does not go through keeps the text
 * and marks the newer default as a conflict for you to settle.
 */
function writeAgainstNow(store: Store, slot: SlotDef, locale: PromptLocale, text: string | null, base: string | null, change: Omit<WritePromptInput, "id" | "locale" | "text" | "base">): PromptRevisionRow | null {
  const now = renderDefault(slot, locale, hostPromptEnv(store));
  if (text === null) return store.writePrompt({ ...change, id: slot.id, locale, text: null, base: null });
  const from = base ?? now;
  if (from !== now) {
    const merged = merge3Lines(from, text, now);
    const checked = merged.clean ? validatePromptText(slot, locale, merged.text, now) : null;
    if (checked?.ok) {
      return store.writePrompt({ ...change, id: slot.id, locale, text: checked.text === now ? null : checked.text, base: checked.text === now ? null : now });
    }
    return store.writePrompt({ ...change, id: slot.id, locale, text, base: from, conflictDefault: now });
  }
  return store.writePrompt({ ...change, id: slot.id, locale, text: text === now ? null : text, base: text === now ? null : now });
}

/**
 * Takes one change back (ADR 0062's rule): only the latest change to the slot, and only while the
 * slot still says what that change wrote; anything since is newer than it and is refused (409).
 * What it puts back stands on the default it stood on then; a newer default since is marked as a
 * conflict rather than merged, so taking back a merge does not merge it again.
 */
export function undoPromptRevision(store: Store, revisionId: string): PromptRevisionRow | null {
  const revision = store.promptRevision(revisionId);
  if (!revision) throw new HttpError(404, "not_found", "prompt revision not found");
  return store.transaction(() => {
    const head = store.promptHead(revision.prompt_id, revision.locale);
    const now = store.promptOverride(revision.prompt_id, revision.locale);
    if (head?.id !== revision.id || (now?.text ?? null) !== revision.after_text) {
      throw new HttpError(409, "changed_since", "this prompt changed after that change; take back the newer one first");
    }
    const slot = slotDef(revision.prompt_id);
    const current = slot ? renderDefault(slot, revision.locale, hostPromptEnv(store)) : null;
    const conflict = revision.before_text !== null && current !== null && revision.before_base !== current ? current : undefined;
    return store.writePrompt({
      id: revision.prompt_id, locale: revision.locale, text: revision.before_text, base: revision.before_base,
      op: "undo", actor: "user", undoes: revision.id, ...(conflict !== undefined ? { conflictDefault: conflict } : {}),
    });
  });
}

/** Puts back what one change wrote, whenever it was, merged onto the current default. */
export function restorePromptRevision(store: Store, revisionId: string): PromptRevisionRow | null {
  const revision = store.promptRevision(revisionId);
  if (!revision) throw new HttpError(404, "not_found", "prompt revision not found");
  const slot = promptSlot(revision.prompt_id);
  return store.transaction(() => writeAgainstNow(store, slot, revision.locale, revision.after_text, revision.after_base, { op: "restore", actor: "user" }));
}

/**
 * At open, and when the engine level rises: every slot you edited whose default changed since is
 * merged with the new default line by line (ADR 0064). A clean merge is written as the app's change,
 * undoable like any other; one that does not go through keeps your text in force and marks the new
 * default for you. A slot this build no longer has is kept as it is. One line per slot touched.
 */
export function reconcilePrompts(store: Store, env: PromptEnv = hostPromptEnv(store)): string[] {
  const lines: string[] = [];
  for (const row of store.listPromptOverrides()) {
    const slot = slotDef(row.prompt_id);
    const where = `${row.prompt_id} (${row.locale})`;
    if (!slot || !(slot.locales as readonly string[]).includes(row.locale)) {
      lines.push(`${where}: no such prompt in this build, kept`);
      continue;
    }
    const now = renderDefault(slot, row.locale, env);
    if (now === row.base_text) {
      if (row.conflict_default !== null) store.clearPromptConflict(row.prompt_id, row.locale);
      continue;
    }
    if (row.conflict_default === now) continue;
    const merged = merge3Lines(row.base_text, row.text, now);
    const checked = merged.clean ? validatePromptText(slot, row.locale, merged.text, now) : null;
    if (checked?.ok) {
      const back = checked.text === now;
      store.writePrompt({ id: row.prompt_id, locale: row.locale, text: back ? null : checked.text, base: back ? null : now, baseEnv: env, op: "merge", actor: "app" });
      lines.push(`${where}: merged the new default into your version${back ? " (now the default)" : ""}`);
    } else {
      store.markPromptConflict(row.prompt_id, row.locale, now);
      lines.push(`${where}: the new default does not merge with your version; yours stays until you choose`);
    }
  }
  return lines;
}
