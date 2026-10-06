/**
 * Built-in prompts for one hop or one call (ADR 0064): your version of a slot where you edited it,
 * else the default the app ships, with the fixed answer format and the call's own values filled in.
 * A page is built when it is needed and thrown away; nothing here is cached or global, so two stores
 * (two tests, a copy of the database) never see each other's edits.
 */
import type { Locale } from "@real-bot/protocol";
import { toolShell } from "../platform";
import { fill, type Placeholder } from "./fill";
import { renderDefault, slotDef, slotLocale, type PromptEnv, type PromptRef } from "./registry";
import type { TurnPromptTexts } from "./system";

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
