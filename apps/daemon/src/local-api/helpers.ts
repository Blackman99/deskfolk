/** Helpers shared by the local API's request handling and its route groups. */

import { REACTION_EMOJI, SPEND_CATEGORY_OF, type ClientEvent, type SpendFilter, type SpendLine } from "@real-bot/protocol";
import { readFileSync, statSync } from "node:fs";
import { displayAvatar } from "../avatar-display";
import { HttpError } from "../errors";
import { fileEtag } from "../file-integrity";
import { fileRangeResponse } from "../file-range";
import { isUlid } from "../ids";
import { reduceImage, type ImageVariant } from "../image-variant";
import type { Store } from "../store";
import type { RouteLearningRow, RouteReviewRow } from "../store/routing";

export const REACTIONS = new Set<string>(REACTION_EMOJI);

export function occurred(): string {
  return new Date().toISOString();
}

/** A verdict as clients read it: the row, and what the next same-kind choice made of it. */
export function reviewOut(store: Store, row: RouteReviewRow) {
  return {
    chain_id: row.chain_id,
    turn_id: row.turn_id,
    session_id: row.session_id,
    bot_id: row.bot_id,
    signature: row.signature,
    model: row.model,
    thinking_level: row.thinking_level,
    fault: row.fault,
    direction: row.direction,
    rounds: row.rounds,
    confidence: row.confidence,
    reason: row.reason,
    created_at: row.created_at,
    retired_at: row.retired_at,
    effect: store.reviewEffect(row),
  };
}

/** A learning note as clients read it: the row, and whether later same-kind chains got shorter. */
export function learningOut(store: Store, row: RouteLearningRow) {
  return { ...row, outcome: store.learningOutcome({ botId: row.bot_id, chainId: row.chain_id }) };
}

/** The command line out of a `shell` call's arguments, so a finished row can name itself. */
export function shellCommandOf(name: string | undefined, args: string | undefined): string | undefined {
  if (name !== "shell" || !args) return undefined;
  try {
    const parsed = JSON.parse(args) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/** A pane's colours: `#rrggbb` text and background, optionally a cursor and the sixteen ANSI colours. */
export function terminalColors(body: Record<string, unknown>): { foreground: string; background: string; cursor?: string; palette?: string[] } {
  const hex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
  const { foreground, background, cursor, palette } = body;
  if (!hex(foreground) || !hex(background) || (cursor !== undefined && !hex(cursor))
    || (palette !== undefined && !(Array.isArray(palette) && palette.length <= 16 && palette.every(hex)))) {
    throw new HttpError(422, "invalid_args", "colours are #rrggbb");
  }
  return { foreground, background, ...(cursor ? { cursor } : {}), ...(palette ? { palette: palette as string[] } : {}) };
}

export function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A file's bytes, or with `size` a smaller copy of the picture. The copy is announced by
 * `X-Original-Size`, the original's length, so a client can offer the original and say what it
 * costs; without the header the bytes are the original.
 */
/** A Bot as clients are sent it: its portrait as the small marked copy (see avatar-display). */
export function displayBot<T extends { avatar: string | null }>(bot: T): T {
  return { ...bot, avatar: displayAvatar(bot.avatar) };
}

export async function fileResponse(abs: string, mime: string, filename: string, variant: ImageVariant | null, range: string | null): Promise<Response> {
  if (range !== null) {
    if (variant) throw new HttpError(422, "invalid_args", "range cannot be combined with image size");
    return fileRangeResponse(abs, mime, filename, range);
  }
  const reduced = variant ? await reduceImage(abs, mime, variant) : null;
  const file = reduced?.bytes ?? readFileSync(abs);
  return new Response(file, {
    status: 200,
    headers: {
      "ETag": fileEtag(file),
      "Content-Type": reduced?.mime ?? mime,
      "Content-Length": String(file.byteLength),
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
      ...(reduced ? { "X-Original-Size": String(statSync(abs).size) } : {}),
    },
  });
}

/** A `kind` filter names lines: the kinds, and the purposes split out of them (ADR 0042). */
const SPEND_LINES = new Set<SpendLine>(Object.keys(SPEND_CATEGORY_OF) as SpendLine[]);

/** Shared by the summary and the detail page. An empty `bot_id` or `model` means the null group. */
export function spendFilterFrom(url: URL): SpendFilter {
  const filter: SpendFilter = {};
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from) filter.from = canonicalIso(from, "from");
  if (to) filter.to = canonicalIso(to, "to");
  const unique = [...new Set(
    url.searchParams.getAll("kind").flatMap((kind) => kind.split(",")).map((kind) => kind.trim()).filter((kind) => kind.length > 0),
  )];
  if (unique.length > 0) {
    if (unique.some((kind) => !SPEND_LINES.has(kind as SpendLine))) {
      throw new HttpError(422, "invalid_args", "kind is not a spend kind");
    }
    filter.kind = unique as SpendLine[];
  }
  if (url.searchParams.has("bot_id")) {
    const botId = url.searchParams.get("bot_id") ?? "";
    if (botId === "") filter.bot_id = null;
    else if (!isUlid(botId)) throw new HttpError(422, "invalid_args", "bot_id must be empty or an id");
    else filter.bot_id = botId;
  }
  const sessionId = url.searchParams.get("session_id");
  if (sessionId) {
    if (!isUlid(sessionId)) throw new HttpError(422, "invalid_args", "session_id must be an id");
    filter.session_id = sessionId;
  }
  if (url.searchParams.has("model")) {
    const model = url.searchParams.get("model") ?? "";
    filter.model = model === "" ? null : model;
  }
  const providerId = url.searchParams.get("provider_id");
  if (providerId) {
    if (!isUlid(providerId)) throw new HttpError(422, "invalid_args", "provider_id must be an id");
    filter.provider_id = providerId;
  }
  const turnId = url.searchParams.get("turn_id");
  if (turnId) {
    if (!isUlid(turnId)) throw new HttpError(422, "invalid_args", "turn_id must be an id");
    filter.turn_id = turnId;
  }
  const tz = url.searchParams.get("tz");
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    } catch {
      throw new HttpError(422, "invalid_args", "tz must be an IANA time zone");
    }
  }
  return filter;
}

/**
 * Ledger rows are `YYYY-MM-DDTHH:mm:ss.sssZ`. A shorter instant would sort ahead of the same
 * millisecond, so the bound is stored in that form. A month or day that does not exist is rejected
 * rather than rolled into the next month.
 */
function canonicalIso(value: string, name: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) throw new HttpError(422, "invalid_args", `${name} must be an ISO timestamp`);
  const [, year, month, day, hour, minute, second, fraction] = match;
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) throw new HttpError(422, "invalid_args", `${name} must be an ISO timestamp`);
  const canonical = new Date(instant).toISOString();
  const millis = (fraction ?? "").padEnd(3, "0");
  if (canonical !== `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`) {
    throw new HttpError(422, "invalid_args", `${name} must be an ISO timestamp`);
  }
  return canonical;
}

export function publishBotModelChanges(
  store: Store,
  previousBots: Array<{ id: string; model: string | null; provider_id: string | null }>,
  at: string,
  publish: (event: ClientEvent) => void,
): void {
  for (const bot of store.listBots()) {
    const previous = previousBots.find((row) => row.id === bot.id);
    if (previous?.model === bot.model && previous.provider_id === bot.provider_id) continue;
    publish({ event: "bot.upsert", occurred_at: at, ...bot, deleted_at: null });
  }
}

/** Workspace paths a posted message points at. Multipart carries them as one JSON-encoded field. */
export function messagePaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  let list: unknown = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { list = null; }
  }
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.length > 0)) {
    throw new HttpError(422, "invalid_args", "paths must be a list of workspace paths");
  }
  return list;
}

/**
 * `erase_quotes` on clearing or deleting a conversation (`ClearSessionRequest`): erase what you said
 * there as well. Without it your words are kept apart from the transcript (ADR 0040).
 */
export function eraseQuotesOption(body: Record<string, unknown>): boolean {
  const value = body.erase_quotes ?? false;
  if (typeof value !== "boolean") throw new HttpError(422, "invalid_args", "erase_quotes must be a boolean");
  return value;
}

/**
 * The plans your words in this conversation were filed under: erasing those words takes the checks
 * made from them (ADR 0040 P3) with them, which only a sync of each plan does.
 */
export function plansQuotedIn(store: Store, sessionId: string): string[] {
  return [...new Set(store.listQuotes({ sessionId }).flatMap((quote) => (quote.task_id ? [quote.task_id] : [])))];
}
