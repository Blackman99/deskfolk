/**
 * A local agent's protocol, line by line, for diagnosing a turn (ADR 0079): set
 * `REAL_BOT_AGENT_TRACE` to a directory and each session writes `<turn>.jsonl` there. Off unless
 * set; what an agent says can hold file contents, so it is never on by default.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function agentTrace(turnId: string): ((direction: "in" | "out", message: unknown) => void) | undefined {
  const dir = process.env.REAL_BOT_AGENT_TRACE;
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const file = join(dir, `${turnId}.jsonl`);
  return (direction, message) => {
    try {
      appendFileSync(file, `${JSON.stringify({ t: Date.now(), direction, message })}\n`);
    } catch {
      // a trace is a convenience
    }
  };
}
