/**
 * 界面方案 (Interface profile, ADR 0106): one row holding what you changed about how the app looks
 * and works, and every change as a revision of its own — who made it (you, or a Bot you asked, and
 * through which card), why, and the whole record before and after, the theme and language included.
 * Undo takes back only the latest change and only while the interface still says what it wrote;
 * any revision can be restored. A sitting of Settings folds into one revision while you keep typing,
 * except that typing it back to how it began is a revision of its own (2026-10-07's rule).
 *
 * Windows tell the daemon what they found after applying it (`InterfaceWindowReport`) and, on the
 * desktop, what the app has (`InterfaceCatalog`). Neither is a record: both live in memory, beside
 * the database they are about, until the next window says otherwise.
 */
import type { Database } from "bun:sqlite";
import {
  applyInterfacePatch,
  emptyInterfaceProfile,
  interfaceChanges,
  InterfacePatchError,
  INTERFACE_RECENT_MAX,
  INTERFACE_REASON_MAX,
  LOCALES,
  normalizeInterfaceProfile,
  sameInterfaceProfile,
  THEMES,
  type InterfaceCatalog,
  type InterfaceProfile,
  type InterfaceRecord,
  type InterfaceRevision,
  type InterfaceRevisionHead,
  type InterfaceRevisionOp,
  type InterfaceState,
  type InterfaceSurface,
  type InterfaceWindowReport,
  type Locale,
  type Theme,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { setSetting, settingsMap, type StoreContext } from "./shared";

/** Who changed it, and through what; the same fields an engine's revision keeps. */
export type InterfaceActor = {
  actor?: "user" | "bot";
  botId?: string | null;
  turnId?: string | null;
  approvalId?: string | null;
  messageId?: string | null;
  reason?: string | null;
  /** A sitting of Settings: saves in one fold into one revision. */
  editSession?: string | null;
  /** The latest revision the change was made against; a newer one is a 409. Absent: no check. */
  ifRevision?: string | null;
};

type ProfileRow = { profile: string; revision: number; updated_at: string };
type RevisionRow = Omit<InterfaceRevision, "before" | "after"> & { edit_session: string | null; before: string; after: string };

type WindowState = { catalog: InterfaceCatalog | null; reports: Partial<Record<InterfaceSurface, InterfaceWindowReport>> };
const windows = new WeakMap<Database, WindowState>();

function windowState(ctx: StoreContext): WindowState {
  let state = windows.get(ctx.db);
  if (!state) {
    state = { catalog: null, reports: {} };
    windows.set(ctx.db, state);
  }
  return state;
}

function profileRow(ctx: StoreContext): ProfileRow | null {
  return ctx.db.query<ProfileRow, []>("SELECT profile, revision, updated_at FROM interface_profile WHERE id = 1").get() ?? null;
}

export function interfaceProfile(ctx: StoreContext): InterfaceProfile {
  const row = profileRow(ctx);
  if (!row) return emptyInterfaceProfile();
  try {
    return normalizeInterfaceProfile(JSON.parse(row.profile));
  } catch {
    return emptyInterfaceProfile();
  }
}

/** The profile with the theme and language Settings holds beside it. */
export function interfaceRecord(ctx: StoreContext): InterfaceRecord {
  const map = settingsMap(ctx);
  const theme = map.get("theme");
  return {
    profile: interfaceProfile(ctx),
    theme: (THEMES as readonly string[]).includes(theme ?? "") ? (theme as Theme) : "system",
    locale: map.get("locale") === "en" ? "en" : "zh",
  };
}

function readRevision(row: RevisionRow): InterfaceRevision & { edit_session: string | null } {
  const record = (raw: string): InterfaceRecord => {
    const parsed = JSON.parse(raw) as Partial<InterfaceRecord>;
    return {
      profile: normalizeInterfaceProfile(parsed.profile),
      theme: (THEMES as readonly string[]).includes(parsed.theme ?? "") ? (parsed.theme as Theme) : "system",
      locale: parsed.locale === "en" ? "en" : "zh",
    };
  };
  return { ...row, before: record(row.before), after: record(row.after) };
}

function latestRevisionRow(ctx: StoreContext): RevisionRow | null {
  return ctx.db.query<RevisionRow, []>("SELECT * FROM interface_revisions ORDER BY revision DESC, rowid DESC LIMIT 1").get() ?? null;
}

function sameRecord(a: InterfaceRecord, b: InterfaceRecord): boolean {
  return a.theme === b.theme && a.locale === b.locale && sameInterfaceProfile(a.profile, b.profile);
}

function head(revision: InterfaceRevision, latestId: string | null, current: InterfaceRecord): InterfaceRevisionHead {
  const { before, after, ...rest } = revision;
  delete (rest as { edit_session?: unknown }).edit_session;
  return { ...rest, changes: interfaceChanges(before, after), undoable: revision.id === latestId && sameRecord(after, current) };
}

export function interfaceState(ctx: StoreContext): InterfaceState {
  const row = profileRow(ctx);
  const current = interfaceRecord(ctx);
  const rows = ctx.db.query<RevisionRow, [number]>("SELECT * FROM interface_revisions ORDER BY revision DESC, rowid DESC LIMIT ?").all(INTERFACE_RECENT_MAX);
  const latestId = rows[0]?.id ?? null;
  return {
    profile: current.profile,
    revision: row?.revision ?? 0,
    revision_id: latestId,
    recent: rows.map((found) => head(readRevision(found), latestId, current)),
  };
}

/** Revisions, newest first, as heads; by the turn or the card that made them when asked. */
export function listInterfaceRevisions(ctx: StoreContext, filter: { turnId?: string; approvalId?: string; limit?: number } = {}): InterfaceRevisionHead[] {
  const current = interfaceRecord(ctx);
  const latestId = latestRevisionRow(ctx)?.id ?? null;
  const where: string[] = [];
  const args: string[] = [];
  if (filter.turnId) {
    where.push("turn_id = ?");
    args.push(filter.turnId);
  }
  if (filter.approvalId) {
    where.push("approval_id = ?");
    args.push(filter.approvalId);
  }
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
  const rows = ctx.db.query<RevisionRow, string[]>(
    `SELECT * FROM interface_revisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY revision DESC, rowid DESC LIMIT ${limit}`,
  ).all(...args);
  return rows.map((found) => head(readRevision(found), latestId, current));
}

export function getInterfaceRevision(ctx: StoreContext, id: string): InterfaceRevision {
  const row = ctx.db.query<RevisionRow, [string]>("SELECT * FROM interface_revisions WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "not_found", "no such interface revision");
  const { edit_session: _session, ...revision } = readRevision(row);
  return revision;
}

function patchError(error: unknown): never {
  if (error instanceof InterfacePatchError) throw new HttpError(422, error.code, error.message);
  throw error;
}

function reasonOf(value: string | null | undefined): string | null {
  const reason = value?.trim() ?? "";
  if (!reason) return null;
  return [...reason].slice(0, INTERFACE_REASON_MAX).join("");
}

/** What the interface would be with the patch applied; nothing is written. */
export function previewInterfacePatch(ctx: StoreContext, patch: unknown): InterfaceRecord {
  const current = interfaceRecord(ctx);
  let profile: InterfaceProfile;
  try {
    profile = applyInterfacePatch(current.profile, patch);
  } catch (error) {
    patchError(error);
  }
  const raw = patch as { theme?: unknown; locale?: unknown };
  if (raw.theme !== undefined && !(THEMES as readonly unknown[]).includes(raw.theme)) {
    throw new HttpError(422, "invalid_args", `theme must be one of ${THEMES.join(", ")}`);
  }
  if (raw.locale !== undefined && !(LOCALES as readonly unknown[]).includes(raw.locale)) {
    throw new HttpError(422, "invalid_args", `locale must be one of ${LOCALES.join(", ")}`);
  }
  return {
    profile,
    theme: (raw.theme as Theme | undefined) ?? current.theme,
    locale: (raw.locale as Locale | undefined) ?? current.locale,
  };
}

function writeRecord(ctx: StoreContext, current: InterfaceRecord, next: InterfaceRecord, now: string, bump: boolean): number {
  const row = profileRow(ctx);
  const revision = (row?.revision ?? 0) + (bump ? 1 : 0);
  if (row) ctx.db.run("UPDATE interface_profile SET profile = ?, revision = ?, updated_at = ? WHERE id = 1", [JSON.stringify(next.profile), revision, now]);
  else ctx.db.run("INSERT INTO interface_profile (id, profile, revision, updated_at) VALUES (1, ?, ?, ?)", [JSON.stringify(next.profile), revision, now]);
  if (current.theme !== next.theme) setSetting(ctx, "theme", next.theme);
  if (current.locale !== next.locale) setSetting(ctx, "locale", next.locale);
  if (current.theme !== next.theme || current.locale !== next.locale) {
    ctx.db.run("UPDATE request_meta SET settings_rev = settings_rev + 1 WHERE singleton = 1");
  }
  return revision;
}

/**
 * Writes the interface as `next`, recording the change; returns the revision written or folded
 * into, or null when nothing changed.
 */
function record(ctx: StoreContext, next: InterfaceRecord, op: InterfaceRevisionOp, by: InterfaceActor): InterfaceRevision | null {
  const current = interfaceRecord(ctx);
  const latest = latestRevisionRow(ctx);
  if (by.ifRevision !== undefined && (latest?.id ?? null) !== by.ifRevision) {
    throw new HttpError(409, "conflict", "the interface changed since you opened it; reload and try again");
  }
  if (sameRecord(current, next)) return null;
  const now = isoNow();
  const actor = by.actor ?? "user";
  const session = actor === "user" && op === "edit" ? by.editSession ?? null : null;
  if (session && latest && latest.edit_session === session && latest.actor === "user" && latest.op === "edit") {
    const folded = readRevision(latest);
    // Typed back to how the sitting began: a change of its own, and nothing after it folds into it.
    if (!sameRecord(folded.before, next)) {
      writeRecord(ctx, current, next, now, false);
      ctx.db.run("UPDATE interface_revisions SET after = ? WHERE id = ?", [JSON.stringify(next), latest.id]);
      return getInterfaceRevision(ctx, latest.id);
    }
  }
  const revision = writeRecord(ctx, current, next, now, true);
  const id = ulid();
  const appVersion = windowState(ctx).catalog?.app_version ?? null;
  const editSession = session && !(latest && latest.edit_session === session && sameRecord(readRevision(latest).before, next)) ? session : null;
  ctx.db.run(
    `INSERT INTO interface_revisions (id, revision, op, actor, bot_id, turn_id, approval_id, message_id, reason, edit_session, app_version, before, after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, revision, op, actor, by.botId ?? null, by.turnId ?? null, by.approvalId ?? null, by.messageId ?? null, reasonOf(by.reason),
      editSession, appVersion, JSON.stringify(current), JSON.stringify(next), now],
  );
  return getInterfaceRevision(ctx, id);
}

/** A change to the interface, checked against the record as it stands; theme and language go to Settings. */
export function changeInterface(ctx: StoreContext, patch: unknown, by: InterfaceActor = {}): { state: InterfaceState; revision: InterfaceRevision | null } {
  return ctx.commit(() => {
    const next = previewInterfacePatch(ctx, patch);
    const raw = patch as { reset?: unknown };
    const op: InterfaceRevisionOp = Array.isArray(raw.reset) && raw.reset.length > 0 && Object.keys(patch as object).length === 1 ? "reset" : "edit";
    const revision = record(ctx, next, op, by);
    return { state: interfaceState(ctx), revision };
  });
}

/** Takes back the latest change, while the interface still says what it wrote. */
export function undoInterfaceRevision(ctx: StoreContext, id: string, by: InterfaceActor = {}): { state: InterfaceState; revision: InterfaceRevision | null } {
  return ctx.commit(() => {
    const target = getInterfaceRevision(ctx, id);
    const latest = latestRevisionRow(ctx);
    if (latest?.id !== id) throw new HttpError(409, "changed_since", "only the latest change can be taken back; restore an older one instead");
    if (!sameRecord(interfaceRecord(ctx), target.after)) throw new HttpError(409, "changed_since", "the interface changed after this; restore an older one instead");
    const revision = record(ctx, target.before, "undo", { ...by, reason: by.reason ?? `undo ${id}`, editSession: null, ifRevision: undefined });
    return { state: interfaceState(ctx), revision };
  });
}

/** Makes the interface what it was after a given change. */
export function restoreInterfaceRevision(ctx: StoreContext, id: string, by: InterfaceActor = {}): { state: InterfaceState; revision: InterfaceRevision | null } {
  return ctx.commit(() => {
    const target = getInterfaceRevision(ctx, id);
    const revision = record(ctx, target.after, "restore", { ...by, reason: by.reason ?? `restore ${id}`, editSession: null, ifRevision: undefined });
    return { state: interfaceState(ctx), revision };
  });
}

/** What a window found after applying the interface; the desktop's catalog when it sends one. */
export function noteInterfaceWindow(ctx: StoreContext, input: { report?: InterfaceWindowReport | null; catalog?: InterfaceCatalog | null }): void {
  const state = windowState(ctx);
  if (input.catalog) state.catalog = input.catalog;
  if (input.report) state.reports[input.report.surface] = input.report;
}

export function interfaceWindows(ctx: StoreContext): { catalog: InterfaceCatalog | null; reports: InterfaceWindowReport[] } {
  const state = windowState(ctx);
  return { catalog: state.catalog, reports: Object.values(state.reports).filter((report): report is InterfaceWindowReport => !!report) };
}
