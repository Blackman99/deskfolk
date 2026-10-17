/**
 * 引擎 (Playbook, ADR 0085): which of the app's own calls run around a conversation, and with what
 * numbers. The built-ins are code (`BUILTIN_PLAYBOOKS`); a row here holds what you changed from one
 * — a built-in's own row once you edit it, or a custom engine based on one — and every change is a
 * revision of its own, never rewritten. `playbookFor` says which engine a call runs under: the
 * job's conversation, else the conversation it is in (a Bot↔Bot direct or a job's thread running the
 * engine of where it came from), its own engine if it names one, else Settings' default.
 */
import {
  BUILTIN_PLAYBOOK_IDS,
  DEFAULT_PLAYBOOK_ID,
  emptyPlaybookDiff,
  isBuiltinPlaybookId,
  isPlaybookStepId,
  PlaybookDiffError,
  playbookStep,
  resolvePlaybook,
  validatePlaybookDiff,
  type BuiltinPlaybookId,
  type Playbook,
  type PlaybookDiff,
  type PlaybookList,
  type PlaybookResolved,
  type PlaybookRevision,
  type PlaybookRevisionOp,
  type PlaybookStepDiff,
  type PlaybookStepId,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { setSetting, type StoreContext } from "./shared";

/** How long a custom engine's name may be. */
export const PLAYBOOK_NAME_MAX = 40;
/** How deep a conversation's origin is followed for its engine (a direct of a direct of a thread…). */
const ORIGIN_DEPTH = 4;

type PlaybookRow = {
  id: string;
  base_id: string;
  name: string | null;
  diff: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type RevisionRow = Omit<PlaybookRevision, "before" | "after"> & { before: string | null; after: string | null };

/** Who changed an engine, and from where: you, the app, or a Bot whose proposal you let through. */
export type PlaybookActor = {
  actor?: string;
  botId?: string | null;
  turnId?: string | null;
  approvalId?: string | null;
  messageId?: string | null;
  reason?: string | null;
};

function parseDiff(text: string | null): PlaybookDiff {
  if (!text) return emptyPlaybookDiff();
  try {
    const value = JSON.parse(text) as PlaybookDiff;
    return value && typeof value === "object" && value.steps ? withoutRetired(value.steps) : emptyPlaybookDiff();
  } catch {
    return emptyPlaybookDiff();
  }
}

/**
 * A stored diff without what the engine no longer has, so the API never hands back a number a save
 * would refuse: diffs saved before 2026-10-17 can hold pacing.hop_limit, retired then. The row keeps
 * it until the next change and the revisions keep it for good.
 */
function withoutRetired(stored: PlaybookDiff["steps"]): PlaybookDiff {
  const out = emptyPlaybookDiff();
  for (const [id, change] of Object.entries(stored)) {
    if (!isPlaybookStepId(id) || !change || typeof change !== "object") continue;
    const keys = new Set(playbookStep(id).params.map((param) => param.key));
    const params = Object.fromEntries(Object.entries(change.params ?? {}).filter(([key]) => keys.has(key)));
    const kept: PlaybookStepDiff = {};
    if (change.on !== undefined) kept.on = change.on;
    if (Object.keys(params).length > 0) kept.params = params;
    if (kept.on !== undefined || kept.params) out.steps[id] = kept;
  }
  return out;
}

function row(ctx: StoreContext, id: string): PlaybookRow | null {
  return ctx.db.query<PlaybookRow, [string]>("SELECT * FROM playbooks WHERE id = ?").get(id) ?? null;
}

function latestRevisionId(ctx: StoreContext, id: string): string | null {
  return ctx.db.query<{ id: string }, [string]>("SELECT id FROM playbook_revisions WHERE playbook_id = ? ORDER BY revision DESC, rowid DESC LIMIT 1")
    .get(id)?.id ?? null;
}

function toPlaybook(ctx: StoreContext, id: string, found: PlaybookRow | null): Playbook {
  const builtin = isBuiltinPlaybookId(id);
  const base = (builtin ? id : found?.base_id) as BuiltinPlaybookId;
  const diff = parseDiff(found?.diff ?? null);
  return {
    id,
    builtin,
    base_id: base,
    name: builtin ? null : found?.name ?? null,
    revision: found?.revision ?? 0,
    revision_id: found ? latestRevisionId(ctx, id) : null,
    diff,
    resolved: resolvePlaybook(base, diff),
    updated_at: found?.updated_at ?? null,
  };
}

/** One engine; 404 when there is none of that id (or it was removed). */
export function getPlaybook(ctx: StoreContext, id: string): Playbook {
  const found = row(ctx, id);
  if (isBuiltinPlaybookId(id)) return toPlaybook(ctx, id, found);
  if (!found || found.deleted_at || !isBuiltinPlaybookId(found.base_id)) throw new HttpError(404, "not_found", "no such engine");
  return toPlaybook(ctx, id, found);
}

function defaultSetting(ctx: StoreContext): string | null {
  return ctx.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'default_playbook'").get()?.value || null;
}

/** Settings' default engine, as set; a removed one reads as the built-in default. */
export function defaultPlaybookId(ctx: StoreContext): string {
  const set = defaultSetting(ctx);
  if (!set) return DEFAULT_PLAYBOOK_ID;
  if (isBuiltinPlaybookId(set)) return set;
  const found = row(ctx, set);
  return found && !found.deleted_at && isBuiltinPlaybookId(found.base_id) ? set : DEFAULT_PLAYBOOK_ID;
}

/** The three built-ins first, then the custom engines oldest first. */
export function listPlaybooks(ctx: StoreContext): PlaybookList {
  const custom = ctx.db.query<PlaybookRow, []>(`SELECT * FROM playbooks WHERE deleted_at IS NULL
    AND id NOT IN ('general', 'video', 'coding') ORDER BY created_at, id`).all().filter((found) => isBuiltinPlaybookId(found.base_id));
  return {
    default_id: defaultPlaybookId(ctx),
    items: [
      ...BUILTIN_PLAYBOOK_IDS.map((id) => toPlaybook(ctx, id, row(ctx, id))),
      ...custom.map((found) => toPlaybook(ctx, found.id, found)),
    ],
  };
}

/** Which engine a call runs under, and what it runs. */
export type PlaybookScope = { sessionId?: string | null; taskId?: string | null; turnId?: string | null };
export type PlaybookInForce = { id: string; revision: number; resolved: PlaybookResolved };

/** The engine a conversation names: its own, else (for a job's thread or a Bot↔Bot direct) the one of where it came from. */
function sessionPlaybook(ctx: StoreContext, sessionId: string | null): string | null {
  let at = sessionId;
  for (let depth = 0; at && depth < ORIGIN_DEPTH; depth++) {
    const session = ctx.db.query<{ playbook_id: string | null; origin_session_id: string | null; thread_task_id: string | null }, [string]>(
      "SELECT playbook_id, origin_session_id, thread_task_id FROM sessions WHERE id = ?").get(at);
    if (!session) return null;
    if (session.playbook_id) return session.playbook_id;
    at = session.thread_task_id
      ? ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(session.thread_task_id)?.session_id ?? null
      : session.origin_session_id;
  }
  return null;
}

/**
 * The engine a call runs under (ADR 0085): a turn's job, else its conversation; a job's own
 * conversation decides for anything about the job, wherever it was said; that conversation's engine,
 * else Settings' default, else 通用. An engine since removed reads as the default.
 */
export function playbookFor(ctx: StoreContext, scope: PlaybookScope): PlaybookInForce {
  let taskId = scope.taskId ?? null;
  let sessionId = scope.sessionId ?? null;
  if (scope.turnId && (!taskId || !sessionId)) {
    const turn = ctx.db.query<{ task_id: string | null; session_id: string }, [string]>("SELECT task_id, session_id FROM turns WHERE id = ?").get(scope.turnId);
    taskId ??= turn?.task_id ?? null;
    sessionId ??= turn?.session_id ?? null;
  }
  if (taskId) {
    const home = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(taskId)?.session_id;
    if (home) sessionId = home;
  }
  const named = sessionPlaybook(ctx, sessionId);
  for (const id of [named, defaultPlaybookId(ctx)]) {
    if (!id) continue;
    const found = row(ctx, id);
    if (isBuiltinPlaybookId(id)) return { id, revision: found?.revision ?? 0, resolved: resolvePlaybook(id, parseDiff(found?.diff ?? null)) };
    if (found && !found.deleted_at && isBuiltinPlaybookId(found.base_id)) {
      return { id, revision: found.revision, resolved: resolvePlaybook(found.base_id, parseDiff(found.diff)) };
    }
  }
  return { id: DEFAULT_PLAYBOOK_ID, revision: 0, resolved: resolvePlaybook(DEFAULT_PLAYBOOK_ID, null) };
}

/** Whether a step runs under the engine in force here. */
export function playbookStepOn(ctx: StoreContext, scope: PlaybookScope, step: PlaybookStepId): boolean {
  return playbookFor(ctx, scope).resolved[step].on;
}

/** A number a step runs with under the engine in force here. */
export function playbookParam(ctx: StoreContext, scope: PlaybookScope, step: PlaybookStepId, key: string): number {
  const value = playbookFor(ctx, scope).resolved[step].params[key];
  if (value === undefined) throw new Error(`no number ${step}.${key}`);
  return value;
}

function checkRevision(ctx: StoreContext, id: string, ifRevision: string | null | undefined): void {
  if (ifRevision === undefined) return;
  if (latestRevisionId(ctx, id) !== ifRevision) {
    throw new HttpError(409, "conflict", "this engine changed since you opened it; reload and try again");
  }
}

function writeRevision(ctx: StoreContext, input: {
  id: string; revision: number; op: PlaybookRevisionOp; by: PlaybookActor;
  before: { name: string | null; diff: PlaybookDiff } | null; after: { name: string | null; diff: PlaybookDiff } | null; now: string;
}): void {
  ctx.db.run(`INSERT INTO playbook_revisions (id, playbook_id, revision, op, actor, bot_id, turn_id, approval_id, message_id, reason, before, after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    ulid(), input.id, input.revision, input.op, input.by.actor ?? "user", input.by.botId ?? null, input.by.turnId ?? null, input.by.approvalId ?? null,
    input.by.messageId ?? null, input.by.reason ?? null, input.before ? JSON.stringify(input.before) : null, input.after ? JSON.stringify(input.after) : null, input.now,
  ]);
}

function sameDiff(a: PlaybookDiff, b: PlaybookDiff): boolean {
  return JSON.stringify(a.steps) === JSON.stringify(b.steps);
}

/** Writes an engine's diff (and name) as one revision; a built-in's own row is made on its first change. */
function writeDiff(ctx: StoreContext, id: string, input: { diff: PlaybookDiff; name?: string | null; op: PlaybookRevisionOp; by: PlaybookActor; ifRevision?: string | null }): Playbook {
  return ctx.commit(() => {
    const before = getPlaybook(ctx, id);
    checkRevision(ctx, id, input.ifRevision);
    const name = input.name === undefined ? before.name : input.name;
    if (sameDiff(before.diff, input.diff) && name === before.name) return before;
    const now = isoNow();
    const revision = before.revision + 1;
    if (row(ctx, id)) {
      ctx.db.run("UPDATE playbooks SET diff = ?, name = ?, revision = ?, updated_at = ? WHERE id = ?", [JSON.stringify(input.diff), name, revision, now, id]);
    } else {
      ctx.db.run("INSERT INTO playbooks (id, base_id, name, diff, revision, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
        [id, before.base_id, JSON.stringify(input.diff), revision, now, now]);
    }
    writeRevision(ctx, { id, revision, op: input.op, by: input.by, before: { name: before.name, diff: before.diff }, after: { name, diff: input.diff }, now });
    return getPlaybook(ctx, id);
  });
}

/** Your changes to an engine, as a whole diff from its built-in (`PUT /v1/playbooks/:id`). */
export function savePlaybook(ctx: StoreContext, id: string, input: { diff: unknown; ifRevision?: string | null } & PlaybookActor): Playbook {
  const current = getPlaybook(ctx, id);
  let diff: PlaybookDiff;
  try {
    diff = validatePlaybookDiff(input.diff, current.base_id);
  } catch (error) {
    if (error instanceof PlaybookDiffError) throw new HttpError(422, "invalid_args", error.message);
    throw error;
  }
  return writeDiff(ctx, id, { diff, op: "edit", by: input, ifRevision: input.ifRevision });
}

/** One step back to its built-in, or the whole engine when no step is named. */
export function resetPlaybook(ctx: StoreContext, id: string, input: { step?: PlaybookStepId | null; ifRevision?: string | null } & PlaybookActor): Playbook {
  const current = getPlaybook(ctx, id);
  const diff: PlaybookDiff = input.step ? { v: 1, steps: { ...current.diff.steps } } : emptyPlaybookDiff();
  if (input.step) delete diff.steps[input.step];
  return writeDiff(ctx, id, { diff, op: "reset", by: input, ifRevision: input.ifRevision });
}

function engineName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new HttpError(422, "invalid_args", "name is required");
  if ([...name].length > PLAYBOOK_NAME_MAX) throw new HttpError(422, "invalid_args", `name is at most ${PLAYBOOK_NAME_MAX} characters`);
  return name;
}

/** A new engine based on another (a built-in, or a copy of a custom one's changes). */
export function createPlaybook(ctx: StoreContext, input: { from: string; name: unknown } & PlaybookActor): Playbook {
  return ctx.commit(() => {
    const from = getPlaybook(ctx, input.from);
    const name = engineName(input.name);
    const id = ulid();
    const now = isoNow();
    ctx.db.run("INSERT INTO playbooks (id, base_id, name, diff, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      [id, from.base_id, name, JSON.stringify(from.diff), now, now]);
    writeRevision(ctx, { id, revision: 1, op: "create", by: { ...input, reason: input.reason ?? `from ${from.id}` }, before: null, after: { name, diff: from.diff }, now });
    return getPlaybook(ctx, id);
  });
}

export function renamePlaybook(ctx: StoreContext, id: string, input: { name: unknown; ifRevision?: string | null } & PlaybookActor): Playbook {
  if (isBuiltinPlaybookId(id)) throw new HttpError(422, "invalid_args", "a built-in engine keeps its name");
  const current = getPlaybook(ctx, id);
  return writeDiff(ctx, id, { diff: current.diff, name: engineName(input.name), op: "rename", by: input, ifRevision: input.ifRevision });
}

/** A custom engine removed: the conversations that ran it follow the default again. Not while it is the default. */
export function deletePlaybook(ctx: StoreContext, id: string, by: PlaybookActor = {}): void {
  if (isBuiltinPlaybookId(id)) throw new HttpError(422, "invalid_args", "a built-in engine cannot be removed");
  ctx.commit(() => {
    const current = getPlaybook(ctx, id);
    if (defaultSetting(ctx) === id) throw new HttpError(409, "conflict", "this engine is the default; choose another default first");
    const now = isoNow();
    const revision = current.revision + 1;
    ctx.db.run("UPDATE playbooks SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ?", [now, revision, now, id]);
    ctx.db.run("UPDATE sessions SET playbook_id = NULL, updated_at = ? WHERE playbook_id = ?", [now, id]);
    writeRevision(ctx, { id, revision, op: "delete", by, before: { name: current.name, diff: current.diff }, after: null, now });
  });
}

/** An engine's changes, newest first. */
export function listPlaybookRevisions(ctx: StoreContext, id: string): PlaybookRevision[] {
  if (!isBuiltinPlaybookId(id) && !row(ctx, id)) throw new HttpError(404, "not_found", "no such engine");
  return ctx.db.query<RevisionRow, [string]>("SELECT * FROM playbook_revisions WHERE playbook_id = ? ORDER BY revision DESC, rowid DESC").all(id)
    .map((found) => ({ ...found, before: found.before ? JSON.parse(found.before) : null, after: found.after ? JSON.parse(found.after) : null }));
}

/** An engine named for a new conversation: an existing engine's id, or null to follow the default. */
export function incomingPlaybookId(ctx: StoreContext, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "playbook_id must be an engine's id or null");
  getPlaybook(ctx, value);
  return value;
}

/** The engine a conversation runs; null follows Settings' default. */
export function setSessionPlaybook(ctx: StoreContext, sessionId: string, playbookId: unknown): void {
  ctx.commit(() => {
    if (!ctx.db.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) throw new HttpError(404, "not_found", "session not found");
    const id = incomingPlaybookId(ctx, playbookId);
    ctx.db.run("UPDATE sessions SET playbook_id = ?, updated_at = ? WHERE id = ?", [id, isoNow(), sessionId]);
  });
}

/** Settings' default engine; checked to exist. */
export function setDefaultPlaybook(ctx: StoreContext, value: unknown): void {
  if (typeof value !== "string" || !value) throw new HttpError(422, "invalid_args", "default_playbook must be an engine's id");
  getPlaybook(ctx, value);
  setSetting(ctx, "default_playbook", value);
}
