import { isThinkingLevel, type Bot, type PatchBotsModelRequest, type Provider } from "@real-bot/protocol";
import { thinkingLevelLabel } from "../copy.ts";
import type { SelectOption } from "../select-options.ts";
import { parseModelSelectValue } from "../settings/provider-form.ts";
import { applyModelPin } from "./create-form.ts";

/**
 * The bulk model dialog's picker value for 自动. The profile pane spells automatic as `''`, but here
 * `''` has to mean "nothing picked yet" so the dialog can refuse to apply before you choose. A real
 * model is always `provider::name`, so this can never be mistaken for one.
 */
export const AUTO_CHOICE = "__auto__";

/**
 * What the dialog will write: `null` until you pick. `model` is the profile pane's encoding — `''`
 * for automatic, else `provider::name` — and `thinkingLevel` moves with it, as it does there.
 */
export type BulkModelChoice = { model: string; thinkingLevel: string } | null;

type ProviderCatalogs = Parameters<typeof applyModelPin>[2];

/** The Bots the dialog opens with ticked: the ones asked for that are on the roster and not archived. */
export function initialSelection(bots: readonly Bot[], preselect: readonly string[]): string[] {
  const wanted = new Set(preselect);
  return bots.filter((bot) => wanted.has(bot.id) && !bot.archived_at).map((bot) => bot.id);
}

/**
 * Row order: what the dialog opened with ticked, then the rest of the roster, then the archived.
 * Fixed by the opening pick, so ticking or unticking a row never moves it under the pointer.
 */
export function orderBulkRows(bots: readonly Bot[], openedWith: ReadonlySet<string>): Bot[] {
  const rank = (bot: Bot): number => (bot.archived_at ? 2 : openedWith.has(bot.id) ? 0 : 1);
  return [...bots].sort((a, b) => rank(a) - rank(b));
}

/** The ticks that still name a Bot on the roster; one deleted meanwhile drops out of the count and the request. */
export function liveSelection(bots: readonly Bot[], selected: readonly string[]): string[] {
  const alive = new Set(bots.map((bot) => bot.id));
  return [...new Set(selected)].filter((id) => alive.has(id));
}

/** Every Bot still in use. An archived Bot is only ever ticked by hand, and 全选 leaves such a tick alone. */
export function selectAllActive(bots: readonly Bot[], selected: readonly string[]): string[] {
  const held = new Set(selected);
  return bots.filter((bot) => !bot.archived_at || held.has(bot.id)).map((bot) => bot.id);
}

/** The profile pane's options, with 自动 first under its own value. */
export function bulkModelOptions(modelOptions: readonly SelectOption[], autoLabel: string): SelectOption[] {
  return [{ value: AUTO_CHOICE, label: autoLabel }, ...modelOptions];
}

/** The picker's value for a choice: empty (its placeholder) until you pick. */
export function choiceSelectValue(choice: BulkModelChoice): string {
  if (!choice) return "";
  return choice.model === "" ? AUTO_CHOICE : choice.model;
}

/**
 * A pick from the model picker. Model and level move together, as in the profile pane: automatic
 * clears both; a model keeps the level already chosen when it offers it, else takes its default.
 */
export function pickBulkModel(
  value: string,
  current: BulkModelChoice,
  providers: ProviderCatalogs,
): BulkModelChoice {
  if (value === "") return null;
  if (value === AUTO_CHOICE) return { model: "", thinkingLevel: "" };
  return applyModelPin(value, current?.thinkingLevel ?? "", providers);
}

/**
 * The request, or `null` while there is nothing to send: no Bot ticked or no model picked yet.
 * Automatic sends no level at all — the daemon rejects a level without a model. A pinned model
 * sends the level on screen, so every ticked Bot lands on exactly what the dialog showed.
 */
export function planBulkModel(
  selected: readonly string[],
  choice: BulkModelChoice,
): PatchBotsModelRequest | null {
  const botIds = [...new Set(selected)];
  if (botIds.length === 0 || !choice) return null;
  if (choice.model === "") return { bot_ids: botIds, model: null, provider_id: null };
  const parsed = parseModelSelectValue(choice.model);
  if (parsed.model.length === 0) return null;
  const body: PatchBotsModelRequest = {
    bot_ids: botIds,
    model: parsed.model,
    provider_id: parsed.provider_id,
  };
  const level = choice.thinkingLevel.trim();
  if (level.length > 0 && isThinkingLevel(level)) body.thinking_level = level;
  return body;
}

/**
 * What a Bot runs on now: model · level, or automatic. With more than one endpoint the endpoint's
 * name follows, as the model picker's hint does, so Bots on the same model name at different
 * endpoints read apart.
 */
export function botPinLabel(
  bot: Pick<Bot, "model" | "thinking_level"> & { provider_id?: string | null },
  labels: { auto: string; levels: Record<string, string> },
  providers: readonly Pick<Provider, "id" | "name">[] = [],
): string {
  if (!bot.model) return labels.auto;
  const parts = [bot.model];
  if (bot.thinking_level) parts.push(thinkingLevelLabel(labels.levels, bot.thinking_level));
  if (providers.length > 1 && bot.provider_id) {
    const endpoint = providers.find((provider) => provider.id === bot.provider_id);
    if (endpoint) parts.push(endpoint.name);
  }
  return parts.join(" · ");
}

export type BulkModelFailure =
  | { kind: "model" }
  | { kind: "thinking" }
  | { kind: "bot"; name: string | null }
  | { kind: "too_many"; max: number }
  | { kind: "generic" };

/**
 * The daemon's refusal, sorted into what the dialog can tell you to do about it. A missing Bot is
 * named when the message carries its id (the daemon writes `bot not found: <id>`) or its name in
 * quotes. A bare "not found" is not a Bot: that is a daemon without this endpoint.
 */
export function mapBulkModelError(
  status: number,
  message: string,
  bots: readonly Pick<Bot, "id" | "name">[],
): BulkModelFailure {
  const text = message.toLowerCase();
  if (text.includes("thinking_level")) return { kind: "thinking" };
  if (/\bmodels?\b|provider/.test(text)) return { kind: "model" };
  const cap = /\bat most (\d+)/.exec(text);
  if (cap && text.includes("bot")) return { kind: "too_many", max: Number(cap[1]) };
  const missing =
    /\bbots?\b/.test(text) && (status === 404 || /not found|unknown|deleted|no longer/.test(text));
  if (missing) return { kind: "bot", name: namedBot(message, bots) };
  return { kind: "generic" };
}

function namedBot(message: string, bots: readonly Pick<Bot, "id" | "name">[]): string | null {
  const byId = bots.find((bot) => message.includes(bot.id));
  if (byId) return byId.name;
  const quoted = bots.find((bot) =>
    [`"${bot.name}"`, `'${bot.name}'`, `「${bot.name}」`, `“${bot.name}”`].some((form) =>
      message.includes(form),
    ),
  );
  return quoted?.name ?? null;
}

/** Nothing was written whatever the reason — the request is one transaction — and every line says so. */
export function bulkModelErrorCopy(
  failure: BulkModelFailure,
  copy: {
    errorModel: string;
    errorThinking: string;
    errorBot: (name: string) => string;
    errorBotGone: string;
    errorTooMany: (max: number) => string;
    errorGeneric: string;
  },
): string {
  if (failure.kind === "model") return copy.errorModel;
  if (failure.kind === "thinking") return copy.errorThinking;
  if (failure.kind === "bot") return failure.name ? copy.errorBot(failure.name) : copy.errorBotGone;
  if (failure.kind === "too_many") return copy.errorTooMany(failure.max);
  return copy.errorGeneric;
}
