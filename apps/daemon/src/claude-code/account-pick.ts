/**
 * Which of your Claude accounts a turn runs on once one is out of usage (ADR 0110). A Bot, a rung of
 * the ladder or a built-in call names one account (its `config_dir`, null for the daemon's own
 * environment). While that one's plan limit holds, the work goes on another of the accounts you
 * listed in Settings that is signed in and not out itself; with none left, it waits for the soonest
 * reset. Two handles reading the same directory, or signed in as the same email, are one account:
 * moving between them would hit the same limit.
 */
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import type { AccountOut } from "../store/account-limits";
import { defaultConfigDir, normalizeConfigDir, sameConfigDir } from "./account";
import { accountOf } from "./status";

/**
 * One account as the picker sees it: the handle a turn is given, the directory it reads, who it is,
 * and whether it is on a Claude plan (a claude.ai sign-in or its long-lived token) rather than billed
 * per token (an API key, a key helper, a cloud platform).
 */
export type ClaudeAccountSeat = { configDir: string | null; dir: string; email: string | null; signedIn: boolean; plan: boolean };

/** The sign-ins that spend a Claude plan's usage: only these are moved to (ADR 0110). */
const PLAN_SIGN_INS: ReadonlySet<string> = new Set(["claude.ai", "oauth_token"]);

/** The directory a handle reads: a listed one as it is, the daemon's own environment's as the variable or `~/.claude`. */
export function accountDir(configDir: string | null, env: Record<string, string | undefined> = process.env): string {
  if (configDir) return configDir;
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  return (fromEnv ? normalizeConfigDir(fromEnv) : null) ?? defaultConfigDir();
}

/** A handle as a seat: what `claude auth status` said of it, the daemon's own when the status lists none. */
export function seatOf(status: ClaudeCodeStatus, configDir: string | null, env?: Record<string, string | undefined>): ClaudeAccountSeat {
  const account = accountOf(status, configDir) ?? (configDir === null ? status : undefined);
  return {
    configDir,
    dir: accountDir(configDir, env),
    email: account?.email?.trim().toLowerCase() || null,
    signedIn: account?.logged_in === true,
    plan: PLAN_SIGN_INS.has(account?.auth_method ?? ""),
  };
}

function sameAccount(a: Pick<ClaudeAccountSeat, "dir" | "email">, b: Pick<ClaudeAccountSeat, "dir" | "email">): boolean {
  return sameConfigDir(a.dir, b.dir) || (a.email !== null && a.email === b.email);
}

/** Every account you have, in the order Settings lists them after the daemon's own; one seat per account. */
export function claudeSeats(status: ClaudeCodeStatus, listed: readonly string[], env?: Record<string, string | undefined>): ClaudeAccountSeat[] {
  const seats: ClaudeAccountSeat[] = [];
  for (const handle of [null, ...listed]) {
    const seat = seatOf(status, handle, env);
    if (!seats.some((kept) => sameAccount(kept, seat))) seats.push(seat);
  }
  return seats;
}

/** The note that holds an account out, if any. */
export function outNote(seat: Pick<ClaudeAccountSeat, "dir" | "email">, outs: readonly AccountOut[]): AccountOut | undefined {
  return outs.find((row) => row.runner === "claude_code" && sameAccount(seat, row));
}

/**
 * The account to run on: `preferred` while it is not out and not tried in this turn; otherwise the
 * first other account signed in on a Claude plan that is neither — never one billed per token, which
 * would turn a plan's limit into a bill. Null when there is none: the caller runs on `preferred`
 * anyway or waits for a reset.
 */
export function pickClaudeAccount(input: {
  status: ClaudeCodeStatus;
  listed: readonly string[];
  preferred: string | null;
  outs: readonly AccountOut[];
  /** Directories this turn already ran out on. */
  tried?: readonly string[];
  env?: Record<string, string | undefined>;
}): { configDir: string | null; switched: boolean } | null {
  const tried = input.tried ?? [];
  const usable = (seat: ClaudeAccountSeat) => !outNote(seat, input.outs) && !tried.some((dir) => sameConfigDir(dir, seat.dir));
  const own = seatOf(input.status, input.preferred, input.env);
  if (usable(own)) return { configDir: input.preferred, switched: false };
  const other = claudeSeats(input.status, input.listed, input.env).find((seat) => seat.signedIn && seat.plan && !sameAccount(seat, own) && usable(seat));
  return other ? { configDir: other.configDir, switched: true } : null;
}

/**
 * When the soonest of your signed-in accounts is back, by the resets the agent itself reported; null
 * when none said (a billing stop, an account on hold), and nothing is scheduled then.
 */
export function soonestBack(status: ClaudeCodeStatus, listed: readonly string[], outs: readonly AccountOut[], env?: Record<string, string | undefined>): number | null {
  const times = claudeSeats(status, listed, env).filter((seat) => seat.signedIn && seat.plan).flatMap((seat) => {
    const note = outNote(seat, outs);
    return note?.known ? [note.until] : [];
  });
  return times.length > 0 ? Math.min(...times) : null;
}
