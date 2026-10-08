import type { ToolResult } from "./collab-tools";

/** A failed tool call: the code and message the model reads, with nothing emitted. */
export function toolFail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message }, emitted: [] };
}
