/**
 * The model ladder (ADR 0054, engine level 7): the listed models in the order you put them, weaker to
 * stronger. A job that keeps failing at its model's top thinking level — or on a model measured to
 * gain nothing from thinking — moves one rung up it, and so on per step. Only you order it: no
 * reference price is set on the models, so the app cannot tell which is stronger on its own. A rung
 * may also be a Claude model of yours run through Claude Code (ADR 0076), as Agent settings offer it.
 */
import { isClaudeEffort, isClaudeModelName, isLadderClaudeRung, MODEL_LADDER_MAX, sameLadderRung, type ModelLadderRung } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { catalogNames, parseStoredCatalog } from "../models";
import { listedConfigDir } from "./claude-code";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { setSetting, type StoreContext } from "./shared";

export { MODEL_LADDER_MAX };

export function providerListsModel(ctx: StoreContext, providerId: string, model: string): boolean {
  const row = ctx.db.query<{ models: string }, [string]>("SELECT models FROM providers WHERE id = ?").get(providerId);
  return Boolean(row && catalogNames(parseStoredCatalog(row.models)).includes(model));
}

function parseLadder(raw: string | null | undefined): ModelLadderRung[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((rung): rung is ModelLadderRung => Boolean(rung) && typeof rung.model === "string"
        && (rung.runner === "claude_code" ? (rung.effort === null || isClaudeEffort(rung.effort)) : typeof rung.provider_id === "string"))
      : [];
  } catch {
    return [];
  }
}

/** The ladder as you ordered it; empty below level 7. */
export function modelLadder(ctx: StoreContext): ModelLadderRung[] {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.routing) return [];
  return parseLadder(ctx.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'model_ladder'").get()?.value);
}

/** One rung as a request names it: a model an endpoint lists, or a Claude model on an account listed in Settings. */
function rungOf(ctx: StoreContext, item: unknown): ModelLadderRung {
  const rung = item as Record<string, unknown> | null;
  if (rung && typeof rung === "object" && "runner" in rung) {
    if (rung.runner !== "claude_code" || typeof rung.model !== "string" || !isClaudeModelName(rung.model)) {
      throw new HttpError(422, "invalid_args", "a Claude rung must be { runner: \"claude_code\", model, effort, config_dir } with a Claude model name");
    }
    const effort = rung.effort ?? null;
    if (effort !== null && !isClaudeEffort(effort)) throw new HttpError(422, "invalid_args", "a Claude rung's effort must be low, medium, high, xhigh, max or null");
    return { runner: "claude_code", model: rung.model, effort, config_dir: listedConfigDir(ctx, rung.config_dir, "config_dir") };
  }
  if (!rung || typeof rung !== "object" || typeof rung.provider_id !== "string" || typeof rung.model !== "string") {
    throw new HttpError(422, "invalid_args", "each rung must be {provider_id, model} or {runner, model, effort, config_dir}");
  }
  if (!providerListsModel(ctx, rung.provider_id, rung.model)) throw new HttpError(422, "invalid_args", `no endpoint lists ${rung.model} there`);
  return { provider_id: rung.provider_id, model: rung.model };
}

/** Your new order: listed models and Claude models of yours, each once. An empty list takes the ladder away. */
export function setModelLadder(ctx: StoreContext, items: unknown): ModelLadderRung[] {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.routing) throw new HttpError(409, "conflict", "the model ladder needs engine level 7");
  if (!Array.isArray(items)) throw new HttpError(422, "invalid_args", "items must be a list of rungs");
  if (items.length > MODEL_LADDER_MAX) throw new HttpError(422, "invalid_args", `a ladder has at most ${MODEL_LADDER_MAX} rungs`);
  const rungs: ModelLadderRung[] = [];
  for (const item of items) {
    const rung = rungOf(ctx, item);
    if (rungs.some((kept) => sameLadderRung(kept, rung))) throw new HttpError(422, "invalid_args", `${rung.model} is on the ladder twice`);
    rungs.push(rung);
  }
  setSetting(ctx, "model_ladder", JSON.stringify(rungs));
  return rungs;
}

/** A rung goes with its endpoint, or once the endpoint no longer lists its model; the rest, Claude rungs included, keep their order. */
export function dropUnknownLadderModels(ctx: StoreContext, providerId: string, models: string[]): void {
  const raw = ctx.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'model_ladder'").get()?.value;
  const rungs = parseLadder(raw);
  const kept = rungs.filter((rung) => isLadderClaudeRung(rung) || rung.provider_id !== providerId || models.includes(rung.model));
  if (kept.length !== rungs.length) setSetting(ctx, "model_ladder", JSON.stringify(kept));
}
