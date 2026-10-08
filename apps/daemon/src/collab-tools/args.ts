/** Reading a collaboration tool's arguments, and the small lookups several tools share. */
import { BORING_AVATAR_VARIANTS, isThinkingLevel, USER_MEMBER, type BoringAvatarVariant, type SessionDetail, type SessionSummary, type ThinkingLevel } from "@real-bot/protocol";
import { existsSync } from "node:fs";
import type { ToolCtx } from "../collab-tools";
import { HttpError } from "../errors";
import type { Store } from "../store";
import { normalizeOptionalId } from "../store/shared";
import { classifyPath } from "../workspace-paths";

export function parseAvatarStyle(value: string): BoringAvatarVariant | null {
  return (BORING_AVATAR_VARIANTS as readonly string[]).includes(value)
    ? (value as BoringAvatarVariant)
    : null;
}

/**
 * The message that woke this turn: where the entry point to a new Bot↔Bot direct hangs, and the
 * receipt a memory carries. Both halves come off the turn so they cannot disagree. A turn that is
 * not on record — a test harness, or one deleted mid-flight — leaves the row without a source.
 */
export function turnOrigin(ctx: ToolCtx): { sessionId: string; messageId: string } | null {
  try {
    const turn = ctx.store.getTurn(ctx.turnId);
    return { sessionId: turn.session_id, messageId: turn.trigger_message_id };
  } catch {
    return null;
  }
}

/** `uses` is a list of MCP server names; the store trims, dedupes, and bounds it. */
export function parseUsesArg(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(422, "invalid_args", "uses must be an array of MCP server names");
  }
  return value as string[];
}

export function memberNames(store: Store, session: SessionDetail | SessionSummary): string[] {
  return session.participants
    .filter((p) => p.left_at === null)
    .map((p) => (p.member === USER_MEMBER ? "user" : store.getBot(p.member).name));
}

export function nullableThinkingLevel(value: unknown): ThinkingLevel | null {
  const raw = normalizeOptionalId(value, "thinking_level");
  if (raw === null) return null;
  if (!isThinkingLevel(raw)) {
    throw new HttpError(422, "invalid_args", "thinking_level must be a reasoning_effort name");
  }
  return raw;
}

/** Whether a workspace-relative path names something on disk inside the workspace. */
export function pathExists(store: Store, relpath: string): boolean {
  const root = store.workspacePath();
  if (!root) return false;
  const classified = classifyPath(root, relpath);
  if (classified.zone !== "inside") return false;
  try {
    return existsSync(classified.abs);
  } catch {
    return false;
  }
}

export function resolveCitedPaths(store: Store, inputs: string[]): { paths: string[]; unresolved: string[] } {
  const root = store.workspacePath();
  if (!root) return { paths: [], unresolved: [...inputs] };
  const paths: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const classified = classifyPath(root, input);
    if (classified.zone !== "inside") {
      unresolved.push(input);
      continue;
    }
    const rel = classified.rel;
    if (seen.has(rel)) continue;
    seen.add(rel);
    paths.push(rel);
  }
  return { paths, unresolved };
}

export function optionalStringArray(value: unknown, field = "args"): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new HttpError(422, "invalid_args", `${field} must be an array of strings`);
  return value.map((item) => {
    if (typeof item !== "string") throw new HttpError(422, "invalid_args", `${field} must be an array of strings`);
    return item;
  });
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(422, "invalid_args", `${field} is required`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "expected a string");
  return value;
}

export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(422, "invalid_args", "avatar_seed must be a non-negative integer");
  }
  return value;
}

export function presentMemberNames(
  store: Store,
  sessionId: string,
  roster: ReturnType<Store["listBots"]>,
): string[] {
  const byId = new Map(roster.map((b) => [b.id, b.name] as const));
  return store
    .presentBotIds(sessionId)
    .map((id) => byId.get(id))
    .filter((name): name is string => typeof name === "string");
}

/** Tool error for `@token`s that match nobody present; lists the exact names to use. */
export function unknownMentionError(tokens: string[], members: string[]): string {
  const label = tokens.length === 1 ? "unknown mention" : "unknown mentions";
  const list = tokens.map((token) => `@${token}`).join(", ");
  const who = members.length > 0 ? members.join(", ") : "(nobody else)";
  return `${label} ${list}: no member here has that name. Members here: ${who}. Use one of these exact names, or drop the @ and send again.`;
}
