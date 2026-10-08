/** Memory tools: what a Bot keeps across conversations. */
import type { Memory } from "@real-bot/protocol";
import type { ToolCtx, ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import { toolFail as fail } from "../tool-result";
import { optionalString, requireString, turnOrigin } from "./args";

/** How far back a new subject is shown the memories its session already produced. */
const SAME_SESSION_MEMORY_MS = 24 * 60 * 60_000;

/**
 * The Bot never passes bot_id or the source ids: they come off the turn, so a Bot can neither
 * write into another Bot's memory nor forge where a memory came from.
 *
 * A new subject comes back with the Bot's other memories from the same session in the last day.
 * Seen live: one Bot stored five successive versions of one layout preference in an hour, each
 * under a new subject, and every later turn read all five at once. The list is only shown; which
 * of them the new one replaces is the Bot's call.
 */
export function remember(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const origin = turnOrigin(ctx);
  const subject = requireString(args.subject, "subject");
  const existed = ctx.store.findMemoryBySubject(ctx.botId, subject) !== null;
  const memory = ctx.store.rememberMemory({
    bot_id: ctx.botId,
    subject,
    body: requireString(args.body, "body"),
    source_session_id: origin?.sessionId ?? ctx.sessionId,
    source_message_id: origin?.messageId ?? null,
    learned_chain_id: ctx.learnedChainId ?? null,
  });
  const data = serializeMemory(memory);
  const earlier =
    existed || !memory.source_session_id
      ? []
      : ctx.store.sessionMemoriesSince({
          botId: ctx.botId,
          sessionId: memory.source_session_id,
          since: new Date(Date.now() - SAME_SESSION_MEMORY_MS).toISOString(),
          exceptId: memory.id,
        });
  if (earlier.length > 0) {
    data.same_session = earlier.map(serializeMemory);
    data.note =
      "You also wrote these from this session in the last day. If the memory you just wrote revises one of them, forget the older one; if it is about something else, leave them.";
  }
  return { ok: true, data, emitted: [{ kind: "memory", memory }] };
}

export function forget(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const current = resolveOwnMemory(ctx, args);
  if (!current.ok) return current.error;
  ctx.store.deleteMemory(current.memory.id);
  return {
    ok: true,
    data: { id: current.memory.id, subject: current.memory.subject },
    emitted: [{ kind: "memory_removed", id: current.memory.id }],
  };
}

function resolveOwnMemory(
  ctx: ToolCtx,
  args: Record<string, unknown>,
): { ok: true; memory: Memory } | { ok: false; error: ToolResult } {
  const id = optionalString(args.id);
  const subject = optionalString(args.subject);
  if (!id && !subject) return { ok: false, error: fail("invalid_args", "id or subject is required") };
  let memory: Memory | null = null;
  if (id) {
    try {
      memory = ctx.store.getMemory(id);
    } catch (error) {
      if (error instanceof HttpError && error.code === "not_found") {
        return { ok: false, error: fail("not_found", "memory not found") };
      }
      throw error;
    }
  } else if (subject) {
    memory = ctx.store.findMemoryBySubject(ctx.botId, subject);
  }
  if (!memory || memory.bot_id !== ctx.botId) {
    return { ok: false, error: fail("not_found", "memory not found") };
  }
  return { ok: true, memory };
}

function serializeMemory(memory: Memory): Record<string, unknown> {
  return { id: memory.id, subject: memory.subject, body: memory.body };
}
