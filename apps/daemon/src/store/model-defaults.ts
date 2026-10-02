/**
 * A Bot's default model (ADR 0048, engine level 7): what it runs on when you have not pinned one,
 * so that no model call has to pick it before every turn. Inferred once from what it actually ran
 * on in the last seven days, and put to you on a card in its direct; you confirm it, or decline it
 * and it runs on the endpoint's default. Until you answer, the inferred one is used — it is what the
 * old per-turn pick settled on most.
 */
import type { TicketModel } from "@real-bot/protocol";
import { ticketModel } from "./tickets";
import type { Database } from "bun:sqlite";
import { USER_MEMBER, type Message, type ThinkingLevel } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { pictureMime } from "../loop-pictures";
import { isoNow } from "../ids";
import { getMessage, insertMessage, setMessageControl } from "./messages";
import { createNotification, updateNotificationActionState } from "./notifications";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { settingsCached } from "./settings";
import { requiredItems } from "./submissions";
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
  // How many thinking levels up a job runs after failing in a row (ADR 0049); 0 is its own.
  const work = db.query<{ name: string }, []>("PRAGMA table_info(work_items)").all().map((column) => column.name);
  if (work.length > 0 && !work.includes("escalation")) db.run("ALTER TABLE work_items ADD COLUMN escalation INTEGER NOT NULL DEFAULT 0");
  // The model a ticket's turns run on, set on the board (level 7): JSON {provider_id, model}, or null.
  const tickets = db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().map((column) => column.name);
  if (tickets.length > 0 && !tickets.includes("model_override")) db.run("ALTER TABLE tickets ADD COLUMN model_override TEXT");
}

/**
 * The model you set on this turn's ticket (level 7), if any — for its owner's turns only: whoever
 * reviews it keeps its own model, or every review of it would be a producer's model checking itself.
 * Before anyone owns it, any turn on it but its reviewer's.
 */
export function turnTicketModel(ctx: StoreContext, turnId: string): TicketModel | null {
  if (!routingOn(ctx)) return null;
  const raw = ctx.db.query<{ model_override: string | null }, [string]>(`SELECT k.model_override FROM turns t JOIN tickets k ON k.id = t.ticket_id
    WHERE t.id = ? AND (t.bot_id = COALESCE(k.owner_bot_id, k.worker)
      OR (COALESCE(k.owner_bot_id, k.worker) IS NULL AND t.bot_id IS NOT k.reviewer_bot_id))`).get(turnId)?.model_override;
  return ticketModel(raw);
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
 * ran that model on most. Null when it ran on nothing still listed. Turns on a model you set on their
 * ticket do not count: that model is about the ticket, not the Bot.
 */
export function inferredDefault(ctx: StoreContext, botId: string, listed: ReadonlyArray<{ providerId: string; model: string }>, now: string = isoNow()):
  { providerId: string; model: string; thinkingLevel: ThinkingLevel; turns: number } | null {
  const since = new Date(Date.parse(now) - DEFAULT_MODEL_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
  const rows = ctx.db.query<{ provider_id: string | null; model: string; thinking_level: string; n: number }, [string, string]>(`SELECT provider_id, model,
    thinking_level, COUNT(*) AS n FROM turn_route_decisions WHERE bot_id = ? AND created_at > ? AND reason_code IS NOT 'ticket_override'
    GROUP BY provider_id, model, thinking_level`).all(botId, since)
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
 * Tells you once, where you and the Bot talk, about its model: a pin no endpoint lists any more
 * (it runs on the endpoint's default meanwhile), a pin that cannot see the pictures its work needs,
 * or no model listed that can (ADR 0049). Once per Bot, kind and model.
 */
export function noteModelOnce(ctx: StoreContext, botId: string, kind: "pin_unlisted" | "pin_no_pictures" | "no_picture_model" | "escalation_top" | "ticket_override_unlisted" | "ticket_override_no_pictures",
  model: string): void {
  ctx.commit(() => {
    if (ctx.db.query(`SELECT 1 FROM work_events WHERE kind = ? AND bot_id = ? AND json_extract(payload, '$.model') = ?`).get(`model.${kind}`, botId, model)) return;
    recordWorkEvent(ctx, { kind: `model.${kind}`, actor: "app", botId, payload: { model } });
    const place = placeToAsk(ctx, botId);
    if (!place) return;
    const en = settingsCached(ctx).locale === "en";
    const name = ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(botId)?.name ?? botId;
    const body = kind === "ticket_override_unlisted"
      ? (en ? `The model you set on ${name}'s ticket, ${model}, is no longer listed by any endpoint: the ticket runs on ${name}'s own model until you set another one on the board.`
        : `你给 ${name} 这张任务指定的模型 ${model} 已经不在任何端点的名单上了：在你到看板上换一个之前，这张任务先用 ${name} 自己的模型。`)
      : kind === "ticket_override_no_pictures"
      ? (en ? `The model you set on ${name}'s ticket, ${model}, is marked as taking no pictures, but this work needs pictures seen: set one that can on the board, or it goes on without seeing them.`
        : `你给 ${name} 这张任务指定的模型 ${model} 标着看不了图，可这件活需要看图：到看板上换一个能看图的，不然它只能不看图做下去。`)
      : kind === "pin_unlisted"
      ? (en ? `${name} is pinned to ${model}, which no endpoint lists any more: it runs on the endpoint's default until you pin another model or clear the pin.`
        : `${name} 钉的模型 ${model} 已经不在任何端点的名单上了：在你换一个或清掉之前，它先用端点默认。`)
      : kind === "escalation_top"
        ? (en ? `${name}'s work keeps failing on ${model}, already at its top thinking level: switching models is yours to decide — pin another model to it if you want one.`
          : `${name} 这件活在 ${model} 上一直没过，思考档已经到顶：要不要换模型由你定，想换就给它钉一个。`)
        : kind === "pin_no_pictures"
        ? (en ? `${name} is pinned to ${model}, which is marked as taking no pictures, but its work needs pictures seen: pin a model that can, or it goes on without seeing them.`
          : `${name} 钉的模型 ${model} 标着看不了图，可它这件活需要看图：换钉一个能看图的模型，不然它只能不看图做下去。`)
        : (en ? `${name}'s work needs pictures seen, but every model listed is marked as taking none: it goes on with ${model}, without seeing them.`
          : `${name} 这件活需要看图，可名单上的模型都标着看不了图：它先用 ${model} 做下去，看不到图。`);
    insertMessage(ctx, { sessionId: place.id, kind: "system", author: USER_MEMBER, hiddenFromBots: true, body });
  });
}

/**
 * Whether this turn's work needs pictures seen (ADR 0049): the line that opened it carries one, or
 * the Bot reviews a ticket with a requirement about the picture. Off below level 7.
 */
export function turnNeedsPictures(ctx: StoreContext, turnId: string): boolean {
  if (!routingOn(ctx)) return false;
  const turn = ctx.db.query<{ bot_id: string; task_id: string | null; ticket_id: string | null; trigger_message_id: string }, [string]>(
    "SELECT bot_id, task_id, ticket_id, trigger_message_id FROM turns WHERE id = ?").get(turnId);
  if (!turn) return false;
  const carried = ctx.db.query<{ path: string }, [string]>("SELECT workspace_relpath AS path FROM attachments WHERE message_id = ?").all(turn.trigger_message_id);
  if (carried.some((row) => pictureMime(row.path) !== null)) return true;
  if (!turn.task_id || !turn.ticket_id) return false;
  const reviewer = ctx.db.query<{ reviewer_bot_id: string | null }, [string]>("SELECT reviewer_bot_id FROM tickets WHERE id = ?").get(turn.ticket_id)?.reviewer_bot_id;
  return reviewer === turn.bot_id && requiredItems(ctx, { task_id: turn.task_id, ticket_id: turn.ticket_id }).some((item) => item.reasons.includes("visual"));
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
