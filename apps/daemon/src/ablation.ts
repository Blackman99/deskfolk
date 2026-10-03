/**
 * Switches that turn off one side-call of the turn loop, so the golden-path benchmark can measure
 * what each one is worth. Benchmark-only: the shipped daemon never sets them — they are not read
 * from the environment or from settings, and `main.ts` passes none — so the default, an empty set,
 * is today's behaviour exactly.
 *
 * Each switch is checked inside the function that would make the call (`grep 'ablation.has('`
 * lists every site), and "off" is the path the loop already takes when that call fails or is not
 * warranted, except `judgement`, whose off is "every Bot joins": passing everyone would leave an
 * unmentioned group line with nobody to answer it.
 *
 * A leaf module on purpose: engine modules import it, it imports nothing.
 */

export const SIDE_CALLS = [
  "organize-message",
  "organize-settle",
  "scribe",
  "closing-check",
  "route-pick",
  "review",
  "learning",
  "judgement",
  "plan-nudge",
  "direct-report",
  "acceptance-checks",
  "reader",
] as const;

export type SideCall = (typeof SIDE_CALLS)[number];
export type Ablation = ReadonlySet<SideCall>;

export const NO_ABLATION: Ablation = new Set<SideCall>();

export type AblationGroup = "organizer" | "calls" | "nudges" | "bare";

export const ABLATION_GROUPS: Record<AblationGroup, readonly SideCall[]> = {
  organizer: ["organize-message", "organize-settle"],
  calls: ["organize-message", "organize-settle", "scribe", "closing-check", "route-pick", "review", "learning", "judgement", "reader"],
  nudges: ["plan-nudge", "direct-report"],
  bare: SIDE_CALLS,
};

/** The `reason` on a judgement row that joined because judgement was switched off. */
export const ABLATED_JOIN_REASON = "ablated: join-all";

export class AblationError extends Error {}

function isSideCall(value: string): value is SideCall {
  return (SIDE_CALLS as readonly string[]).includes(value);
}

function isGroup(value: string): value is AblationGroup {
  return Object.hasOwn(ABLATION_GROUPS, value);
}

/** `""` or `"none"` → nothing off; otherwise switch and group names separated by `,` or `+` (so a label parses back). */
export function parseAblation(value: string): Ablation {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none") return NO_ABLATION;
  const out = new Set<SideCall>();
  for (const raw of trimmed.split(/[,+]/)) {
    const name = raw.trim();
    if (!name) continue;
    if (isGroup(name)) {
      for (const call of ABLATION_GROUPS[name]) out.add(call);
    } else if (isSideCall(name)) {
      out.add(name);
    } else {
      const known = [...Object.keys(ABLATION_GROUPS), ...SIDE_CALLS].join(", ");
      throw new AblationError(`unknown ablation "${name}" (known: none, ${known})`);
    }
  }
  return out;
}

/** The switches that are off, in `SIDE_CALLS` order, for results files. */
export function ablationList(ablation: Ablation): SideCall[] {
  return SIDE_CALLS.filter((call) => ablation.has(call));
}

/** A short name for a set: `none`, a group's name when it is exactly that group, else the switches joined by `+`. */
export function ablationLabel(ablation: Ablation): string {
  const list = ablationList(ablation);
  if (list.length === 0) return "none";
  for (const [name, calls] of Object.entries(ABLATION_GROUPS) as Array<[AblationGroup, readonly SideCall[]]>) {
    if (calls.length === list.length && calls.every((call) => ablation.has(call))) return name;
  }
  return list.join("+");
}
