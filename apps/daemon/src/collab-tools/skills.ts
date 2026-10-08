/** Skill tools: a Bot's own skills and the MCP tools they name. */
import type { Skill } from "@real-bot/protocol";
import type { ToolCtx, ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import { toolFail as fail } from "../tool-result";
import { optionalString, parseUsesArg, requireString } from "./args";

export function listSkills(ctx: ToolCtx): ToolResult {
  return {
    ok: true,
    data: {
      skills: ctx.store.listSkills(ctx.botId).map(serializeSkillSummary),
    },
    emitted: [],
  };
}

export function readSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const skill = resolveOwnSkill(ctx, args, { requireEnabled: true });
  if (!skill.ok) {
    // A project skill you shared (ADR 0052): read by name, never written by a Bot.
    const name = optionalString(args.name);
    const shared = name ? ctx.store.findSharedSkillByName(name) : null;
    if (!shared) return skill.error;
    return { ok: true, data: { name: shared.name, description: shared.description, body: shared.body, uses: shared.uses,
      shared: true, from: shared.source_bot_name }, emitted: [] };
  }
  const data = serializeSkill(skill.skill);
  const stale = staleMcpToolNames(skill.skill.body, ctx.availableToolNames);
  if (stale.length > 0) {
    data.stale_tool_names = stale;
    data.hint =
      "这些 mcp_ 工具名不在本轮 tools 数组里（服务器可能改名、停用，或撞名后缀变了）。按「本轮 MCP」段里的服务器名和工具说明找到现名再调用，并用 update_skill 把正文里的名字改过来。" +
      " / These mcp_ names are not in this hop's tools array (server renamed, disabled, or a collision suffix changed). Find the current name in the MCP block before calling, and fix the body with update_skill.";
  }
  return { ok: true, data, emitted: [] };
}

/**
 * `mcp_<server>_<tool>` names cited in a skill body that are not in this hop's tools array.
 * Tool names drift when a server is renamed or a collision suffix (`_2`) changes; a body that
 * hardcodes the old name would otherwise fail only at call time.
 */
export function staleMcpToolNames(body: string, available: ReadonlySet<string> | undefined): string[] {
  if (!available) return [];
  const cited = new Set(body.match(/\bmcp_[A-Za-z0-9_]+/g) ?? []);
  return [...cited].filter((name) => !available.has(name)).sort();
}

export function createSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  if (ctx.learnedChainId) {
    return fail(
      "invalid_args",
      "a learning hop records one incident as a memory; revise an existing skill with update_skill instead of creating one",
    );
  }
  const name = requireString(args.name, "name");
  const description = requireString(args.description, "description");
  const body = requireString(args.body, "body");
  const enabled = args.enabled === undefined ? undefined : Boolean(args.enabled);
  const skill = ctx.store.createSkill({
    bot_id: ctx.botId,
    name,
    description,
    body,
    enabled,
    uses: parseUsesArg(args.uses),
  });
  return { ok: true, data: serializeSkill(skill), emitted: [{ kind: "skill", skill }] };
}

export function updateSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const current = resolveOwnSkill(ctx, args, { requireEnabled: false });
  if (!current.ok) return current.error;
  const patch: Partial<{ name: string; description: string; body: string; enabled: boolean; uses: string[] }> = {};
  if (args.name !== undefined) patch.name = requireString(args.name, "name");
  if (args.description !== undefined) patch.description = requireString(args.description, "description");
  if (args.body !== undefined) patch.body = requireString(args.body, "body");
  if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
  if (args.uses !== undefined) patch.uses = parseUsesArg(args.uses);
  if (
    patch.name === undefined &&
    patch.description === undefined &&
    patch.body === undefined &&
    patch.enabled === undefined &&
    patch.uses === undefined
  ) {
    return fail("invalid_args", "name, description, body, enabled, or uses is required");
  }
  const skill = ctx.store.patchSkill(
    current.skill.id,
    patch,
    ctx.learnedChainId ? { learnedChainId: ctx.learnedChainId } : {},
  );
  return { ok: true, data: serializeSkill(skill), emitted: [{ kind: "skill", skill }] };
}

export function deleteSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const current = resolveOwnSkill(ctx, args, { requireEnabled: false });
  if (!current.ok) return current.error;
  ctx.store.deleteSkill(current.skill.id);
  return { ok: true, data: { id: current.skill.id }, emitted: [{ kind: "skill_removed", id: current.skill.id }] };
}

function resolveOwnSkill(
  ctx: ToolCtx,
  args: Record<string, unknown>,
  opts: { requireEnabled: boolean },
): { ok: true; skill: Skill } | { ok: false; error: ToolResult } {
  const id = optionalString(args.id);
  const name = optionalString(args.name);
  if (!id && !name) return { ok: false, error: fail("invalid_args", "id or name is required") };
  let skill: Skill | null = null;
  if (id) {
    try {
      skill = ctx.store.getSkill(id);
    } catch (error) {
      if (error instanceof HttpError && error.code === "not_found") {
        return { ok: false, error: fail("not_found", "skill not found") };
      }
      throw error;
    }
  } else if (name) {
    skill = ctx.store.findSkillByName(ctx.botId, name);
  }
  if (!skill || skill.bot_id !== ctx.botId) {
    return { ok: false, error: fail("not_found", "skill not found") };
  }
  if (opts.requireEnabled && !skill.enabled) {
    return { ok: false, error: fail("not_found", "skill not found") };
  }
  return { ok: true, skill };
}

function serializeSkillSummary(skill: Skill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    uses: skill.uses,
    enabled: skill.enabled,
  };
}

function serializeSkill(skill: Skill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    uses: skill.uses,
    enabled: skill.enabled,
  };
}
