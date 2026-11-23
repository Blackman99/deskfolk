import { expect, test } from "bun:test";
import { CHIP, chipsWidth, phoneChips } from "./phone-chips.ts";

/** A 360-wide phone's row: the card's 8 a side, the + 40, its gap, and the gaps either side of the spring. */
const roomAt = (width: number, right: number) => width - 16 - 40 - 3 * CHIP.gap - right;
/** Right of the chips: the context ring 28, the microphone 40, the stop menu 55, Send 40, gaps 6 between. */
const RIGHT_FULLEST = 28 + 6 + 40 + 6 + 55 + 6 + 40;
const RIGHT_IDLE = 28 + 6 + 40 + 6 + 40;

test("on a 360-wide phone at rest, plan mode keeps its word and three consultants their logos", () => {
  expect(phoneChips(roomAt(360, RIGHT_IDLE), true, 3)).toEqual({ planWords: true, consultLogos: true });
});

test("the fullest row at 360 (context, microphone, a run's stop menu) still fits: the logos and then plan mode's word give way", () => {
  const room = roomAt(360, RIGHT_FULLEST);
  const chips = phoneChips(room, true, 3);
  expect(chips).toEqual({ planWords: false, consultLogos: false });
  expect(chipsWidth(chips, true, 3)).toBeLessThanOrEqual(room);
});

test("the logos give way before plan mode's word, and either chip alone keeps the most it can", () => {
  const wordsAndCount = CHIP.planWords + CHIP.gap + CHIP.consultCount;
  expect(phoneChips(wordsAndCount, true, 3)).toEqual({ planWords: true, consultLogos: false });
  expect(phoneChips(CHIP.consultLogos(2), false, 2)).toEqual({ planWords: true, consultLogos: true });
  expect(phoneChips(CHIP.planWords, true, 0)).toEqual({ planWords: true, consultLogos: true });
});

test("with no room at all the barest chips are taken (the row clips them rather than Send)", () => {
  expect(phoneChips(0, true, 3)).toEqual({ planWords: false, consultLogos: false });
  expect(phoneChips(-20, false, 1)).toEqual({ planWords: false, consultLogos: false });
});
