/**
 * The two structured answers the routing agent gives, and the checks that decide whether to trust
 * them. A model picks the model: one short call before a turn opens says what to run this message
 * on, and one call after a correction chain closes says whether that pick was the thing at fault.
 *
 * Both answers arrive as free text from a completion, so nothing here trusts shape or spelling. An
 * answer that does not survive these checks is dropped: the turn falls back to the rules and the
 * review is simply not recorded. Nothing retries — the user is waiting.
 */
import type { CatalogEntry } from "./route-decision";

/** What the routing call must come back with. */
export type RoutePick = {
  model: string;
  thinkingLevel: string;
  providerId: string;
  reason: string;
  /** Whether this message is still about the Bot's previous trigger here. Closes a correction chain. */
  continuesPrevious: boolean;
};

/** Who was actually at fault for a correction chain. */
export type ReviewFault = "model" | "task" | "prompt" | "none";

/** Which way the pick should move when the model was at fault. */
export type ReviewDirection = "stronger" | "lighter" | "faster" | "cheaper" | "same";

export type RouteReviewVerdict = {
  fault: ReviewFault;
  direction: ReviewDirection;
  rounds: number;
  confidence: number;
  reason: string;
};

const FAULTS: readonly ReviewFault[] = ["model", "task", "prompt", "none"];
const DIRECTIONS: readonly ReviewDirection[] = ["stronger", "lighter", "faster", "cheaper", "same"];

/** Conclusions below this are not worth steering later picks with. */
export const REVIEW_CONFIDENCE_FLOOR = 0.5;

/** One reason line, long enough to be useful and short enough to keep the prompt small. */
const REASON_LIMIT = 200;

/**
 * Pulls the first JSON object out of a completion. Models wrap answers in prose or fences even when
 * told not to, so the first balanced `{...}` is taken rather than the whole body.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function cleanReason(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, REASON_LIMIT);
}

/**
 * A pick is only usable when it names a candidate this turn may actually run on and a level that
 * model offers. Matching ignores case and surrounding space; everything else is a miss.
 */
export function parseRoutePick(raw: string, candidates: readonly CatalogEntry[]): RoutePick | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const wantedModel = typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
  if (!wantedModel) return null;
  const entry = candidates.find((row) => row.name.trim().toLowerCase() === wantedModel);
  if (!entry) return null;

  const levels = entry.thinking_levels;
  const wantedLevel =
    typeof parsed.thinking_level === "string" ? parsed.thinking_level.trim().toLowerCase() : "";
  if (!wantedLevel) return null;
  const level = levels.find((item) => item.trim().toLowerCase() === wantedLevel);
  // An empty catalog row means "whatever the endpoint takes", so any token is honoured there.
  if (!level && levels.length > 0) return null;

  return {
    model: entry.name,
    thinkingLevel: level ?? wantedLevel,
    providerId: entry.providerId,
    reason: cleanReason(parsed.reason),
    // Anything but a plain true reads as "new topic": a chain left open costs a stale review.
    continuesPrevious: parsed.continues_previous === true,
  };
}

/**
 * A verdict is only recorded when it commits to a fault this code knows, and says so with enough
 * confidence to be worth steering later picks with. A hedged or unparsable answer changes nothing.
 */
export function parseRouteReview(raw: string): RouteReviewVerdict | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const fault = FAULTS.find(
    (item) => typeof parsed.fault === "string" && parsed.fault.trim().toLowerCase() === item,
  );
  if (!fault) return null;
  const direction =
    DIRECTIONS.find(
      (item) =>
        typeof parsed.direction === "string" && parsed.direction.trim().toLowerCase() === item,
    ) ?? "same";

  const confidenceRaw = typeof parsed.confidence === "number" ? parsed.confidence : Number.NaN;
  if (!Number.isFinite(confidenceRaw)) return null;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));

  const roundsRaw = typeof parsed.rounds === "number" ? parsed.rounds : 0;
  const rounds = Number.isFinite(roundsRaw) ? Math.max(0, Math.round(roundsRaw)) : 0;

  return { fault, direction, rounds, confidence, reason: cleanReason(parsed.reason) };
}

/**
 * Only a confident verdict that blames the model becomes experience. A chain the user drove because
 * the request was unclear, or because the job was simply hard, says nothing about which model to
 * run next time.
 */
export function verdictIsExperience(verdict: RouteReviewVerdict): boolean {
  return verdict.fault === "model" && verdict.confidence >= REVIEW_CONFIDENCE_FLOOR;
}

/**
 * A confident verdict that the request was unclear, after the user had to say so more than once,
 * is worth one memory of what they turned out to mean — the wording, scope or shape they had to
 * spell out is what the next request of the same kind should start from. One round is noise.
 */
export function verdictIsClarification(verdict: RouteReviewVerdict): boolean {
  return verdict.fault === "prompt" && verdict.rounds >= 2 && verdict.confidence >= REVIEW_CONFIDENCE_FLOOR;
}
