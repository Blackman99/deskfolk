import {
  THINKING_LEVELS,
  type CreateBotRequest,
  type CreateGroupRequest,
  type ThinkingLevel,
} from "@real-bot/protocol";
import { modelSelectValue, parseModelSelectValue } from "./provider-form.ts";

export type CreateBotDraft = {
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  model: string;
  /** Pinned thinking level; `''` lets the app pick. Omit to leave the field out of the request. */
  thinkingLevel?: string;
};

export type CreateBotFieldErrors = {
  name?: "empty" | "conflict";
  duties?: "empty";
  boundaries?: "empty";
  model?: "empty" | "invalid";
  thinkingLevel?: "invalid";
};

export type CreateBotPlan =
  | { ok: true; body: CreateBotRequest }
  | { ok: false; errors: CreateBotFieldErrors };

export type CreateGroupDraft = {
  name: string;
  members: string[];
};

export type CreateGroupFieldErrors = {
  name?: "empty";
  members?: "too_few";
};

export type CreateGroupPlan =
  | { ok: true; body: CreateGroupRequest }
  | { ok: false; errors: CreateGroupFieldErrors };

export function planCreateBot(
  draft: CreateBotDraft,
  allowedModels: readonly string[] = [],
): CreateBotPlan {
  const name = draft.name.trim();
  const duties = draft.duties.trim();
  const boundaries = draft.boundaries.trim();
  const avatar = draft.avatar?.trim();
  const rawModel = draft.model.trim();
  const parsed = parseModelSelectValue(rawModel);
  const rawThinking = draft.thinkingLevel === undefined ? undefined : draft.thinkingLevel.trim();
  const errors: CreateBotFieldErrors = {};
  if (name.length === 0) errors.name = "empty";
  if (duties.length === 0) errors.duties = "empty";
  if (boundaries.length === 0) errors.boundaries = "empty";
  if (rawModel.length > 0) {
    const encoded = parsed.provider_id
      ? modelSelectValue(parsed.provider_id, parsed.model)
      : parsed.model;
    if (!allowedModels.includes(encoded) && !allowedModels.includes(parsed.model)) {
      errors.model = "invalid";
    }
  }
  if (rawThinking !== undefined && rawThinking.length > 0 && !isThinkingLevel(rawThinking)) {
    errors.thinkingLevel = "invalid";
  }
  if (errors.name || errors.duties || errors.boundaries || errors.model || errors.thinkingLevel) {
    return { ok: false, errors };
  }
  const body: CreateBotRequest = {
    name,
    duties,
    boundaries,
    model: parsed.model.length > 0 ? parsed.model : null,
    provider_id: parsed.provider_id,
  };
  if (rawThinking !== undefined) {
    body.thinking_level = rawThinking.length > 0 && isThinkingLevel(rawThinking) ? rawThinking : null;
  }
  if (avatar && avatar.length > 0) {
    body.avatar = avatar;
  }
  return {
    ok: true,
    body,
  };
}

export function planCreateGroup(draft: CreateGroupDraft): CreateGroupPlan {
  const name = draft.name.trim();
  const members = uniqueIds(draft.members);
  const errors: CreateGroupFieldErrors = {};
  if (name.length === 0) errors.name = "empty";
  if (members.length < 2) errors.members = "too_few";
  if (errors.name || errors.members) return { ok: false, errors };
  return { ok: true, body: { name, members } };
}

export function mapCreateBotError(
  status: number,
  message: string,
): CreateBotFieldErrors | { top: true } {
  if (status === 409 || message === "that name is already used") return { name: "conflict" };
  if (message === "name is required") return { name: "empty" };
  if (
    message === "model must be one of endpoint_models" ||
    message === "model must be one of the provider models"
  ) {
    return { model: "invalid" };
  }
  if (message.startsWith("thinking_level")) return { thinkingLevel: "invalid" };
  return { top: true };
}

/** Thinking levels a Bot may pin for the picked model: the catalog's list, or every level when nothing is pinned. */
export function pinnableThinkingLevels(
  modelValue: string,
  providers: readonly {
    id: string;
    model_catalog: readonly { name: string; thinking_levels: readonly ThinkingLevel[] }[];
  }[],
): ThinkingLevel[] {
  const parsed = parseModelSelectValue(modelValue);
  if (parsed.model.length === 0) return [...THINKING_LEVELS];
  const scoped = parsed.provider_id
    ? providers.filter((provider) => provider.id === parsed.provider_id)
    : providers;
  const entries = scoped
    .flatMap((provider) => provider.model_catalog)
    .filter((entry) => entry.name === parsed.model);
  if (entries.length === 0) return [...THINKING_LEVELS];
  const union = new Set<ThinkingLevel>();
  for (const entry of entries) {
    for (const level of entry.thinking_levels.length > 0 ? entry.thinking_levels : THINKING_LEVELS) {
      union.add(level);
    }
  }
  return THINKING_LEVELS.filter((level) => union.has(level));
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function mapCreateGroupError(
  _status: number,
  message: string,
): CreateGroupFieldErrors | { top: true } {
  if (message === "name is required") return { name: "empty" };
  if (
    message === "a group needs at least two bots" ||
    message === "members must include at least two bots"
  ) {
    return { members: "too_few" };
  }
  return { top: true };
}

export type SkillDraft = {
  name: string;
  description: string;
  body: string;
  /** MCP server names the body relies on, as typed: comma / newline separated. */
  uses: string;
  enabled: boolean;
};

export type SkillFieldErrors = {
  name?: "empty" | "conflict";
  description?: "empty";
  body?: "empty";
};

export type SkillPlan =
  | { ok: true; body: { name: string; description: string; body: string; uses: string[]; enabled: boolean } }
  | { ok: false; errors: SkillFieldErrors };

export function emptySkillDraft(): SkillDraft {
  return { name: "", description: "", body: "", uses: "", enabled: true };
}

export function skillDraftDirty(draft: SkillDraft, baseline: SkillDraft): boolean {
  return (
    draft.name !== baseline.name ||
    draft.description !== baseline.description ||
    draft.body !== baseline.body ||
    draft.uses !== baseline.uses ||
    draft.enabled !== baseline.enabled
  );
}

/** Splits the typed server list on commas (ASCII or CJK), semicolons, or newlines; dedupes case-insensitively. */
export function parseSkillUses(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,，、;；]+/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function formatSkillUses(uses: readonly string[]): string {
  return uses.join(", ");
}

export function reconcileSkillDraft(
  draft: SkillDraft,
  baseline: SkillDraft,
  incoming: SkillDraft,
): { draft: SkillDraft; baseline: SkillDraft } {
  return {
    draft: skillDraftDirty(draft, baseline) ? draft : incoming,
    baseline: incoming,
  };
}

export function planSkill(draft: SkillDraft): SkillPlan {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const body = draft.body.trim();
  const errors: SkillFieldErrors = {};
  if (name.length === 0) errors.name = "empty";
  if (description.length === 0) errors.description = "empty";
  if (body.length === 0) errors.body = "empty";
  if (errors.name || errors.description || errors.body) return { ok: false, errors };
  return { ok: true, body: { name, description, body, uses: parseSkillUses(draft.uses ?? ""), enabled: draft.enabled } };
}

export function mapSkillError(status: number, message: string): SkillFieldErrors | { top: true } {
  if (status === 409 || message === "that skill name is already used") return { name: "conflict" };
  if (message === "name is required") return { name: "empty" };
  if (message === "description is required") return { description: "empty" };
  if (message === "body is required") return { body: "empty" };
  return { top: true };
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
