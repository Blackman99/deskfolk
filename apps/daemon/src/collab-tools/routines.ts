/** Routine tools. */
import type { Routine } from "@real-bot/protocol";
import type { ToolCtx, ToolResult } from "../collab-tools";
import { optionalString, requireString } from "./args";
import { resolveNamedBot } from "./roster";

export function listRoutines(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const bot = resolveNamedBot(ctx, optionalString(args.name));
  if (!bot.ok) return bot.error;
  return {
    ok: true,
    data: {
      routines: ctx.store.listRoutines().filter((r) => r.bot_id === bot.id).map(serializeRoutine),
    },
    emitted: [],
  };
}

export function createRoutine(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const bot = resolveNamedBot(ctx, optionalString(args.name));
  if (!bot.ok) return bot.error;
  const title = requireString(args.title, "title");
  const instruction = requireString(args.instruction, "instruction");
  const schedule = args.schedule as Routine["schedule"] | undefined;
  const enabled = args.enabled === undefined ? undefined : Boolean(args.enabled);
  const routine = ctx.store.createRoutine({
    bot_id: bot.id,
    title,
    instruction,
    schedule: schedule as Routine["schedule"],
    enabled,
  });
  return { ok: true, data: serializeRoutine(routine), emitted: [{ kind: "routine", routine }] };
}

export function updateRoutine(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const id = requireString(args.id, "id");
  const current = ctx.store.getRoutine(id);
  const patch: Partial<{ title: string; instruction: string; schedule: Routine["schedule"]; enabled: boolean }> = {};
  if (args.title !== undefined) patch.title = requireString(args.title, "title");
  if (args.instruction !== undefined) patch.instruction = requireString(args.instruction, "instruction");
  if (args.schedule !== undefined) patch.schedule = args.schedule as Routine["schedule"];
  if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
  const routine = ctx.store.patchRoutine(current.id, patch);
  return { ok: true, data: serializeRoutine(routine), emitted: [{ kind: "routine", routine }] };
}

export function deleteRoutine(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const id = requireString(args.id, "id");
  ctx.store.getRoutine(id);
  ctx.store.deleteRoutine(id);
  return { ok: true, data: { id }, emitted: [{ kind: "routine_removed", id }] };
}

function serializeRoutine(routine: Routine): Record<string, unknown> {
  return {
    id: routine.id,
    bot_id: routine.bot_id,
    title: routine.title,
    instruction: routine.instruction,
    schedule: routine.schedule,
    enabled: routine.enabled,
    last_fired_for_due_at: routine.last_fired_for_due_at,
    created_at: routine.created_at,
    updated_at: routine.updated_at,
  };
}
