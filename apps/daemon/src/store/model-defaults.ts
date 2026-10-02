/**
 * A Bot's default model (ADR 0048, engine level 7): what it runs on when you have not pinned one,
 * so that no model call has to pick it before every turn. Inferred once from what it actually ran
 * on in the last seven days, and put to you on a card in its direct; you confirm it, or decline it
 * and it runs on the endpoint's default. Until you answer, the inferred one is used — it is what the
 * old per-turn pick settled on most.
 */
import type { Database } from "bun:sqlite";
import { USER_MEMBER, type Message, type ThinkingLevel } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { settingsCached } from "./settings";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

/** How far back the usage a default is inferred from reaches. */
export const DEFAULT_MODEL_WINDOW_DAYS = 7;

export type DefaultSource = "inferred" | "confirmed" | "declined";
export type BotDefault = { providerId: string | null; model: string | null; thinkingLevel: ThinkingLevel | null; source: DefaultSource | null; turns: number };

export function migrateModelDefaults(db: Database): void {
  const bots = db.query<{ name: string }, []>("PRAGMA table_info(bots)").all().map((column) => column.name);
  for (const [column, type] of [["default_provider_id", "TEXT"], ["default_model", "TEXT"], ["default_thinking_level", "TEXT"],
    ["default_source", "TEXT"], ["default_turns", "INTEGER"], ["default_set_at", "TEXT"]] as const) {
    if (!bots.includes(column)) db.run(`ALTER TABLE bots ADD COLUMN ${column} ${type}`);
  }
  const decisions = db.query<{ name: string }, []>("PRAGMA table_info(turn_route_decisions)").all().map((column) => column.name);
  // Why a turn ran on what it ran on, from level 7: pin, default, endpoint_default.
  if (decisions.length > 0 && !decisions.includes("reason_code")) db.run("ALTER TABLE turn_route_decisions ADD COLUMN reason_code TEXT");
}

export function routingOn(ctx: StoreContext): boolean {
  try {
    return readEngineLevel(ctx.db) >= ENGINE_LEVELS.routing;
  } catch {
    return false;
  }
}

export function botDefault(ctx: StoreContext, botId: string): BotDefault {
  const row = ctx.db.query<{ default_provider_id: string | null; default_model: string | null; default_thinking_level: string | null;
    default_source: string | null; default_turns: number | null }, [string]>(
    "SELECT default_provider_id, default_model, default_thinking_level, default_source, default_turns FROM bots WHERE id = ?").get(botId);
  return { providerId: row?.default_provider_id ?? null, model: row?.default_model ?? null, thinkingLevel: (row?.default_thinking_level as ThinkingLevel | null) ?? null,
    source: (row?.default_source as DefaultSource | null) ?? null, turns: row?.default_turns ?? 0 };
}

/**
 * What a Bot ran on most in the last {@link DEFAULT_MODEL_WINDOW_DAYS} days, among the models the
 * endpoints still list (a model since renamed or removed does not count), with the thinking level it
 * ran that model on most. Null when it ran on nothing still listed.
 */
export function inferredDefault(ctx: StoreContext, botId: string, listed: ReadonlyArray<{ providerId: string; model: string }>, now: string = isoNow()):
  { providerId: string; model: string; thinkingLevel: ThinkingLevel; turns: number } | null {
  const since = new Date(Date.parse(now) - DEFAULT_MODEL_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
  const rows = ctx.db.query<{ provider_id: string | null; model: string; thinking_level: string; n: number }, [string, string]>(`SELECT provider_id, model,
    thinking_level, COUNT(*) AS n FROM turn_route_decisions WHERE bot_id = ? AND created_at > ? GROUP BY provider_id, model, thinking_level`).all(botId, since)
    .filter((row) => row.provider_id && listed.some((entry) => entry.providerId === row.provider_id && entry.model === row.model));
  const byModel = new Map<string, { providerId: string; model: string; turns: number; levels: Map<string, number> }>();
  for (const row of rows) {
    const key = `${row.provider_id}\u0000${row.model}`;
    const entry = byModel.get(key) ?? { providerId: row.provider_id!, model: row.model, turns: 0, levels: new Map<string, number>() };
    entry.turns += row.n;
    entry.levels.set(row.thinking_level, (entry.levels.get(row.thinking_level) ?? 0) + row.n);
    byModel.set(key, entry);
  }
  const best = [...byModel.values()].sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model))[0];
  if (!best) return null;
  const level = [...best.levels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0] as ThinkingLevel;
  return { providerId: best.providerId, model: best.model, thinkingLevel: level, turns: best.turns };
}

/**
 * Infers a Bot's default the first time it is needed (no pin, never inferred or answered), records
 * it as `inferred`, and puts it to you on a card in the Bot's direct. Returns the default now in force.
 */
export function ensureBotDefault(ctx: StoreContext, botId: string, listed: ReadonlyArray<{ providerId: string; model: string }>, now: string = isoNow()): BotDefault {
  return ctx.commit(() => {
    const current = botDefault(ctx, botId);
    if (current.source !== null) return current;
    const inferred = inferredDefault(ctx, botId, listed, now);
    if (!inferred) return current;
    ctx.db.run(`UPDATE bots SET default_provider_id = ?, default_model = ?, default_thinking_level = ?, default_source = 'inferred', default_turns = ?,
      default_set_at = ? WHERE id = ?`, [inferred.providerId, inferred.model, inferred.thinkingLevel, inferred.turns, now, botId]);
    recordWorkEvent(ctx, { kind: "model.default_inferred", actor: "app", botId, payload: { ...inferred } });
    const direct = placeToAsk(ctx, botId);
    if (direct) {
      const en = settingsCached(ctx).locale === "en";
      const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(botId)?.name ?? botId;
      const card = insertMessage(ctx, {
        sessionId: direct.id, kind: "system", author: USER_MEMBER, hiddenFromBots: true,
        body: en
          ? `${name} now runs on ${inferred.model} (thinking ${inferred.thinkingLevel}) unless you pin a model: it is what it ran on most in the last ${DEFAULT_MODEL_WINDOW_DAYS} days (${inferred.turns} turns). No model picks it before every turn any more.`
          : `${name} 之后默认用 ${inferred.model}（思考档 ${inferred.thinkingLevel}），除非你给它钉了模型：这是它最近 ${DEFAULT_MODEL_WINDOW_DAYS} 天用得最多的（${inferred.turns} 轮）。以后不再每轮先调一次模型来挑。`,
        control: { kind: "model_default", bot_id: botId, provider_id: inferred.providerId, model: inferred.model, thinking_level: inferred.thinkingLevel, offer: ["confirm", "decline"] },
      });
      createNotification(ctx, { semantic_key: `model_default:${card.id}`, kind: "ask", session_id: direct.id, message_id: card.id, action_state: "open" });
    }
    return botDefault(ctx, botId);
  });
}

/**
 * Where to tell you about a Bot's model: your direct with it, else the conversation you and it were
 * last in together. Null when you share none.
 */
function placeToAsk(ctx: StoreContext, botId: string): { id: string } | null {
  return ctx.db.query<{ id: string }, [string, string]>(`SELECT s.id FROM sessions s
    JOIN session_participants u ON u.session_id = s.id AND u.member = ? AND u.left_at IS NULL
    JOIN session_participants b ON b.session_id = s.id AND b.member = ? AND b.left_at IS NULL
    WHERE s.archived_at IS NULL ORDER BY s.kind = 'direct' DESC, s.updated_at DESC LIMIT 1`).get(USER_MEMBER, botId) ?? null;
}

/**
 * A Bot pinned to a model no endpoint lists any more runs on the endpoint's default meanwhile; you
 * are told once per pinned name, where you and the Bot talk, to pin another or clear it.
 */
export function notePinUnlisted(ctx: StoreContext, botId: string, model: string): void {
  ctx.commit(() => {
    if (ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'model.pin_unlisted' AND bot_id = ? AND json_extract(payload, '$.model') = ?`).get(botId, model)) return;
    recordWorkEvent(ctx, { kind: "model.pin_unlisted", actor: "app", botId, payload: { model } });
    const place = placeToAsk(ctx, botId);
    if (!place) return;
    const en = settingsCached(ctx).locale === "en";
    const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(botId)?.name ?? botId;
    insertMessage(ctx, { sessionId: place.id, kind: "system", author: USER_MEMBER, hiddenFromBots: true,
      body: en ? `${name} is pinned to ${model}, which no endpoint lists any more: it runs on the endpoint's default until you pin another model or clear the pin.`
        : `${name} 钉的模型 ${model} 已经不在任何端点的名单上了：在你换一个或清掉之前，它先用端点默认。` });
  });
}

/** Your answer on a default-model card: confirm keeps it as the Bot's default; decline drops it, and the Bot runs on the endpoint's default. */
export function answerModelDefaultCard(ctx: StoreContext, messageId: string, action: unknown): Message {
  return ctx.commit(() => {
    const message = getMessage(ctx, messageId);
    const control = message.control;
    if (control?.kind !== "model_default") throw new HttpError(422, "invalid_args", "this line is not a default-model card");
    if (action !== "confirm" && action !== "decline") throw new HttpError(422, "invalid_args", "unknown action");
    if ((control.acted ?? []).length > 0 || !control.offer.includes(action)) throw new HttpError(409, "conflict", "this line no longer offers that");
    const now = isoNow();
    if (action === "confirm") {
      ctx.db.run("UPDATE bots SET default_source = 'confirmed', default_set_at = ? WHERE id = ? AND default_model = ?", [now, control.bot_id, control.model]);
    } else {
      ctx.db.run(`UPDATE bots SET default_provider_id = NULL, default_model = NULL, default_thinking_level = NULL, default_source = 'declined', default_set_at = ?
        WHERE id = ?`, [now, control.bot_id]);
    }
    recordWorkEvent(ctx, { kind: `model.default_${action === "confirm" ? "confirmed" : "declined"}`, actor: USER_MEMBER, botId: control.bot_id,
      payload: { model: control.model, provider_id: control.provider_id } });
    updateNotificationActionState(ctx, `model_default:${messageId}`, "resolved", action, true);
    return setMessageControl(ctx, messageId, { ...control, acted: [action] });
  });
}
