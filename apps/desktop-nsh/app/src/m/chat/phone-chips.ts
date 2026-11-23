/**
 * What the phone composer's chips show in the room its row leaves them (ADR 0116 addendum
 * 2026-11-23): plan mode's chip with its word or its icon alone, the consultants' with their logos
 * or their number. The richest that fits is taken; the logos give way first, then plan mode's word.
 * The row measures itself and what stands right of the chips (the context ring, the microphone,
 * Stop, Send); the chips' own widths are these, read off their classes (a 36 pt high pill, a 16 pt
 * icon, 14 pt logos), the word's a little over its widest language.
 */
export const CHIP = {
  gap: 6,
  /** Plan mode's: 7 + icon 16 + 4 + the word + 9, and its border. */
  planWords: 64,
  planIcon: 32,
  /** The consultants': 7 + icon 16 + 4 + a digit + 7, and its border. */
  consultCount: 44,
  consultLogos: (members: number) => 7 + 16 + 4 + 14 * members + 3 * (members - 1) + 7 + 2,
} as const;

export type PhoneChips = { planWords: boolean; consultLogos: boolean };

const RICHEST_FIRST: PhoneChips[] = [
  { planWords: true, consultLogos: true },
  { planWords: true, consultLogos: false },
  { planWords: false, consultLogos: false },
];

/** How wide the chips are drawn so: plan mode's while `plan`, the consultants' while `members` > 0. */
export function chipsWidth(chips: PhoneChips, plan: boolean, members: number): number {
  const planWidth = plan ? (chips.planWords ? CHIP.planWords : CHIP.planIcon) : 0;
  const consultWidth = members > 0 ? (chips.consultLogos ? CHIP.consultLogos(members) : CHIP.consultCount) : 0;
  return planWidth + consultWidth + (plan && members > 0 ? CHIP.gap : 0);
}

/** The richest chips that fit `room` points; the barest when none does (the row then clips them, not Send). */
export function phoneChips(room: number, plan: boolean, members: number): PhoneChips {
  return RICHEST_FIRST.find((chips) => chipsWidth(chips, plan, members) <= room) ?? RICHEST_FIRST[RICHEST_FIRST.length - 1]!;
}
