/**
 * Which `agy` (Antigravity CLI) can do what the app asks of it, by its `--version` line. Kept apart
 * from the driver and the probes so both read the same floors without importing each other.
 */

/** The first `agy` that answers `-p "/quota"` itself instead of sending it to the model. */
export const AGY_QUOTA_SINCE = [1, 1, 11] as const;

/**
 * The first `agy` whose `agy acp` a Bot's turn can rely on: 1.5.0 brought it, 1.5.1 fixed cancelling
 * and closing a session mid-prompt, 1.5.4 a turn hanging on a second permission request.
 */
export const AGY_ACP_SINCE = [1, 5, 4] as const;

/** The `x.y.z` in an `agy --version` line, or null when it has none. */
export function agyVersionOf(text: string): [number, number, number] | null {
  const parts = text.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  return parts && parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : null;
}

/** Whether an `agy --version` line is at least `floor`; false when it names no version. */
export function agyAtLeast(text: string, floor: readonly [number, number, number]): boolean {
  const parts = agyVersionOf(text);
  if (!parts) return false;
  for (let i = 0; i < 3; i += 1) if (parts[i] !== floor[i]) return parts[i]! > floor[i]!;
  return true;
}

/** Whether this `agy` serves ACP well enough to run a Bot's turn. */
export function agyServesAcp(text: string): boolean {
  return agyAtLeast(text, AGY_ACP_SINCE);
}

/** Why an `agy` cannot run a Bot's turn, said as the app shows it; null when it can. */
export function agyTooOld(text: string, locale: "zh" | "en"): string | null {
  if (agyServesAcp(text)) return null;
  const named = agyVersionOf(text)?.join(".") ?? null;
  const floor = AGY_ACP_SINCE.join(".");
  return locale === "en"
    ? `agy ${named ?? "of an unknown version"}: Antigravity Bots need ${floor} or later`
    : `agy ${named ?? "版本不明"}：Antigravity 的 Bot 需要 ${floor} 或更高`;
}
