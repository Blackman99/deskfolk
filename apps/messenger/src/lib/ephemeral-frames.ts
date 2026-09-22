import type { StreamFrame, ToolFrame } from "@real-bot/protocol";

/**
 * Frames that ride the event socket without belonging to its cursor: a terminal's bytes, and a
 * command starting or finishing.
 *
 * They have no `event_instance_id` and no sequence, so handing one to `EventSync` reads as a
 * cursor mismatch and drops the connection — on a phone that surfaces as "the host is
 * unreachable" the moment a terminal is opened. Both readers (the local WebSocket and the
 * remote link) must take them out first, which is why the rule lives in one place rather than
 * being written twice.
 */
export function parseStreamFrame(value: unknown): StreamFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== "stream") return null;
  if (typeof frame.id !== "string" || !frame.id) return null;
  if (!Number.isSafeInteger(frame.offset) || (frame.offset as number) < 0) return null;
  if (typeof frame.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) return null;
  if (frame.skipped !== undefined && (!Number.isSafeInteger(frame.skipped) || (frame.skipped as number) < 0)) return null;
  if (frame.closed !== undefined && typeof frame.closed !== "boolean") return null;
  return frame as unknown as StreamFrame;
}

export function parseToolFrame(value: unknown): ToolFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== "tool") return null;
  if (typeof frame.turn_id !== "string" || typeof frame.id !== "string" || typeof frame.name !== "string") return null;
  if (frame.phase !== "started" && frame.phase !== "exited") return null;
  if (frame.command !== undefined && typeof frame.command !== "string") return null;
  if (frame.exit_code !== undefined && frame.exit_code !== null && !Number.isSafeInteger(frame.exit_code)) return null;
  if (frame.duration_ms !== undefined && !Number.isSafeInteger(frame.duration_ms)) return null;
  return frame as unknown as ToolFrame;
}

/** True when this frame is ephemeral and must never reach the sequenced reader. */
export function isEphemeralFrame(value: unknown): boolean {
  return Boolean(parseStreamFrame(value) || parseToolFrame(value));
}
