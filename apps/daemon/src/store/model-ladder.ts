/**
 * The model ladder (ADR 0054, engine level 7): the listed models in the order you put them, weaker to
 * stronger. A job that keeps failing at its model's top thinking level — or on a model measured to
 * gain nothing from thinking — moves one rung up it, and so on per step. Only you order it: no
 * reference price is set on the models, so the app cannot tell which is stronger on its own.
 */
import { MODEL_LADDER_MAX, type ModelLadderRung } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { catalogNames, parseStoredCatalog } from "../models";
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
      ? parsed.filter((rung): rung is ModelLadderRung => Boolean(rung) && typeof rung.provider_id === "string" && typeof rung.model === "string")
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

/** Your new order: listed models only, each once. An empty list takes the ladder away. */
export function setModelLadder(ctx: StoreContext, items: unknown): ModelLadderRung[] {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.routing) throw new HttpError(409, "conflict", "the model ladder needs engine level 7");
  if (!Array.isArray(items)) throw new HttpError(422, "invalid_args", "items must be a list of {provider_id, model}");
  if (items.length > MODEL_LADDER_MAX) throw new HttpError(422, "invalid_args", `a ladder has at most ${MODEL_LADDER_MAX} rungs`);
  const rungs: ModelLadderRung[] = [];
  for (const item of items as Array<Partial<ModelLadderRung> | null>) {
    if (!item || typeof item !== "object" || typeof item.provider_id !== "string" || typeof item.model !== "string") {
      throw new HttpError(422, "invalid_args", "each rung must be {provider_id, model}");
    }
    if (!providerListsModel(ctx, item.provider_id, item.model)) throw new HttpError(422, "invalid_args", `no endpoint lists ${item.model} there`);
    if (rungs.some((rung) => rung.provider_id === item.provider_id && rung.model === item.model)) {
      throw new HttpError(422, "invalid_args", `${item.model} is on the ladder twice`);
    }
    rungs.push({ provider_id: item.provider_id, model: item.model });
  }
  setSetting(ctx, "model_ladder", JSON.stringify(rungs));
  return rungs;
}

/** A rung goes with its endpoint, or once the endpoint no longer lists its model; the rest keep their order. */
export function dropUnknownLadderModels(ctx: StoreContext, providerId: string, models: string[]): void {
  const raw = ctx.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'model_ladder'").get()?.value;
  const rungs = parseLadder(raw);
  const kept = rungs.filter((rung) => rung.provider_id !== providerId || models.includes(rung.model));
  if (kept.length !== rungs.length) setSetting(ctx, "model_ladder", JSON.stringify(kept));
}
