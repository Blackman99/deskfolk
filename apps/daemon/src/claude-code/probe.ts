/**
 * The one place the daemon keeps what it last learned about the user's Claude Code (ADR 0061), so
 * a turn and the Settings card read the same answer and only one `claude` probe runs at a time.
 */
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { describeClaudeCode, type DescribeDeps } from "./status";

export type ClaudeCodeProbe = {
  /** The last answer, without asking again; null before the first. */
  last(): ClaudeCodeStatus | null;
  /** The last answer when younger than `maxAgeMs`, otherwise a fresh one. */
  current(maxAgeMs?: number): Promise<ClaudeCodeStatus>;
  /** A fresh answer now (the card's re-check, a changed path). */
  detect(): Promise<ClaudeCodeStatus>;
};

export const CLAUDE_CODE_STATUS_MAX_AGE_MS = 60_000;

export function createClaudeCodeProbe(deps: {
  /** The path set in Settings, read at each ask. */
  setting: () => string | null;
  env?: Record<string, string | undefined>;
  describe?: (deps: DescribeDeps) => Promise<ClaudeCodeStatus>;
  now?: () => number;
  /** Extra seams for tests (which, login shell, run). */
  overrides?: Partial<DescribeDeps>;
}): ClaudeCodeProbe {
  const now = deps.now ?? Date.now;
  const describe = deps.describe ?? describeClaudeCode;
  let cached: { status: ClaudeCodeStatus; at: number } | null = null;
  let inFlight: Promise<ClaudeCodeStatus> | null = null;

  function detect(): Promise<ClaudeCodeStatus> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const status = await describe({ setting: deps.setting(), env: deps.env ?? process.env, ...deps.overrides });
        cached = { status, at: now() };
        return status;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    last: () => cached?.status ?? null,
    current(maxAgeMs = CLAUDE_CODE_STATUS_MAX_AGE_MS) {
      if (cached && now() - cached.at < maxAgeMs) return Promise.resolve(cached.status);
      return detect();
    },
    detect,
  };
}
