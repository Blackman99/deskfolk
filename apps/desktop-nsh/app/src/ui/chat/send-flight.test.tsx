/** When a sent line flies from the box into the transcript, and that its row is never left hidden. */
import { View, type ViewRef } from "nsh";
import { expect, test } from "nsh/test";
import { createSendFlight, type Rect } from "./send-flight";

/** A view that measures as `rect` (null: not in the tree). */
const at = (rect: Rect | null) =>
  ({
    measure: async () => (rect ? { bounds: { origin: { x: 0, y: 0 }, size: { width: rect.width, height: rect.height } }, pagePosition: { x: rect.x, y: rect.y } } : null),
  }) as unknown as ViewRef;

const STAGE: Rect = { x: 264, y: 105, width: 828, height: 647 };
const LIST: Rect = { x: 264, y: 105, width: 828, height: 542 };
const BOX: Rect = { x: 307, y: 664, width: 700, height: 32 };
const BUBBLE: Rect = { x: 676, y: 526, width: 376, height: 44 };
const ghost = () => <View />;

function flightOver(list: Rect = LIST, opts: { atLatest?: boolean } = {}) {
  let session = "s1";
  const flight = createSendFlight({
    frame: () => at(STAGE),
    list: () => at(list),
    atLatest: () => opts.atLatest ?? true,
    session: () => session,
    nextFrame: (fn) => setTimeout(fn, 0),
  });
  return { flight, switchTo: (id: string) => ((session = id), flight.switched(id)) };
}

const frame = () => new Promise<void>((done) => setTimeout(done, 0));
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 5));
  }
}

test("a line that went flies from where its words were to its bubble, its row hidden until it lands", async () => {
  const { flight } = flightOver();
  const landed = flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "  hello there \n", true);
  expect(flight.claim("m1", "hello there", true)).toBe(true);
  // A row made anew for the same line says the same.
  expect(flight.claim("m1", "hello there", true)).toBe(true);
  expect(flight.hides("m1")?.opacity).toBe(0);
  flight.placed("m1", at(BUBBLE), ghost);
  expect(flight.flying()).toBe(null);
  landed(true);
  await frame();
  await until(() => flight.flying() !== null);
  const f = flight.flying()!;
  expect(f.words).toEqual({ x: BOX.x + 4, y: BOX.y + 6 });
  expect(f.to).toEqual(BUBBLE);
  expect(f.clip).toEqual(STAGE);
  expect(flight.hides("m1")?.opacity).toBe(0);
  flight.finish();
  expect(flight.flying()).toBe(null);
  expect(flight.hides("m1")).toBe(undefined);
});

test("a send that came back before its row waits for the row", async () => {
  const { flight } = flightOver();
  const landed = flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "hi", true);
  landed(true);
  expect(flight.claim("m1", "hi", true)).toBe(true);
  flight.placed("m1", at(BUBBLE), ghost);
  await frame();
  await until(() => flight.flying() !== null);
  expect(flight.flying()!.messageId).toBe("m1");
});

test("only your line saying what was sent takes the flight, and only one", () => {
  const { flight } = flightOver();
  flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "hi", true);
  expect(flight.claim("b1", "hi", false)).toBe(false);
  expect(flight.claim("m0", "something else", true)).toBe(false);
  expect(flight.claim("m1", "hi", true)).toBe(true);
  expect(flight.claim("m2", "hi", true)).toBe(false);
  expect(flight.hides("b1")).toBe(undefined);
  expect(flight.hides("m2")).toBe(undefined);
});

test("files, a quote, an empty draft, no box, or a reader away from the newest line: nothing flies", () => {
  const box = { node: at(BOX), inset: { x: 4, y: 6 } };
  for (const [flight, words, text, alone] of [
    [flightOver().flight, box, "hi", false],
    [flightOver().flight, box, "   ", true],
    [flightOver().flight, null, "hi", true],
    [flightOver(LIST, { atLatest: false }).flight, box, "hi", true],
  ] as const) {
    flight.arm(words, text, alone)(true);
    expect(flight.claim("m1", "hi", true)).toBe(false);
    expect(flight.hides("m1")).toBe(undefined);
  }
});

test("a refused send shows the row it hid, fading in", () => {
  const { flight } = flightOver();
  const landed = flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "hi", true);
  flight.claim("m1", "hi", true);
  landed(false);
  expect(flight.hides("m1")?.opacity).toBe(1);
  expect(flight.hides("m1")?.transitionProperty).toBe("opacity");
});

test("a row placed while the send hangs waits only a moment, then shows without flying", async () => {
  const { flight } = flightOver();
  const landed = flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "hi", true);
  flight.claim("m1", "hi", true);
  flight.placed("m1", at(BUBBLE), ghost);
  await until(() => flight.hides("m1")?.opacity !== 0);
  landed(true);
  await frame();
  await new Promise((done) => setTimeout(done, 30));
  expect(flight.flying()).toBe(null);
});

test("a bubble not whole in the transcript, or not measured, shows without flying", async () => {
  for (const [list, bubble] of [
    [{ ...LIST, height: 100 }, BUBBLE],
    [LIST, null],
  ] as const) {
    const { flight } = flightOver(list);
    const landed = flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "hi", true);
    flight.claim("m1", "hi", true);
    flight.placed("m1", at(bubble), ghost);
    landed(true);
    await frame();
    await until(() => flight.hides("m1")?.opacity !== 0);
    expect(flight.flying()).toBe(null);
  }
});

test("switching conversations gives up what is on its way, and lands what is flying", async () => {
  const { flight, switchTo } = flightOver();
  flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "hi", true);
  flight.claim("m1", "hi", true);
  switchTo("s2");
  expect(flight.hides("m1")?.opacity).toBe(1);

  const other = flightOver();
  const landed = other.flight.arm({ node: at(BOX), inset: { x: 4, y: 6 } }, "hi", true);
  other.flight.claim("m1", "hi", true);
  other.flight.placed("m1", at(BUBBLE), ghost);
  landed(true);
  await frame();
  await until(() => other.flight.flying() !== null);
  other.switchTo("s2");
  expect(other.flight.flying()).toBe(null);
  expect(other.flight.hides("m1")).toBe(undefined);
});
