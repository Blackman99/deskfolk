/** Controllable tooltip (`Tip` / `tip`) bounds, wrapping, line clamping, empty guard, and command lists. */
import { expect, open, test } from "nsh/test";
import { formatTipLabel, tip, TIP_DEFAULT_MAX_WIDTH } from "./tip";

type App = Awaited<ReturnType<typeof open>>;

const openHarness = (width = 900, height = 720) =>
  open("../../stories/tip-harness.tsx", {
    platform: "macos",
    width,
    height,
    locale: "zh-CN",
    clock: {},
  });

function measuredSize(app: App, name: string): { w: number; h: number } | null {
  const line = app.texts().find((t) => t.startsWith("sizes:"));
  if (!line) return null;
  const map = JSON.parse(line.slice("sizes:".length)) as Record<string, string>;
  const raw = map[name];
  if (!raw) return null;
  const [w, h] = raw.split("x").map(Number);
  return { w: w!, h: h! };
}

test("formatTipLabel trims whitespace and caps giant clamped labels", () => {
  expect(formatTipLabel("")).toBe("");
  expect(formatTipLabel("   \n\t  ")).toBe("");
  expect(formatTipLabel("  Pin  ")).toBe("Pin");
  const huge = "x".repeat(5000);
  const clamped = formatTipLabel(huge, 6);
  expect(clamped.length).toBeLessThanOrEqual(1440);
  expect(clamped.endsWith("…")).toBe(true);
  // Unclamped keeps the whole string.
  expect(formatTipLabel(huge, null)).toBe(huge);
  expect(formatTipLabel(huge, 0)).toBe(huge);
  // tip() returns undefined for empty labels when uncontrolled.
  expect(tip("")).toBeUndefined();
  expect(tip("   ")).toBeUndefined();
  expect(tip(null)).toBeUndefined();
});

test("short tips stay compact while long prose and unbroken commands wrap inside maxWidth and maxLines", async () => {
  const app = await openHarness(900, 720);
  await app.waitFor("id:anchor-short");

  await app.hover("id:anchor-short");
  await app.clock!.runFor(550);
  await app.waitFor("id:tip-short");
  const shortSize = measuredSize(app, "short");
  expect(shortSize).not.toBeNull();
  expect(shortSize!.w).toBeGreaterThan(20);
  expect(shortSize!.w).toBeLessThan(120);

  await app.hover("id:anchor-long");
  await app.clock!.runFor(50);
  await app.waitFor("id:tip-long");
  const longSize = measuredSize(app, "long");
  expect(longSize).not.toBeNull();
  expect(longSize!.w).toBeLessThanOrEqual(TIP_DEFAULT_MAX_WIDTH);
  expect(longSize!.h).toBeGreaterThan(36);
  expect(longSize!.h).toBeLessThanOrEqual(150);

  await app.hover("id:anchor-unbroken");
  await app.clock!.runFor(50);
  await app.waitFor("id:tip-unbroken");
  const unbrokenSize = measuredSize(app, "unbroken");
  expect(unbrokenSize).not.toBeNull();
  expect(unbrokenSize!.w).toBeLessThanOrEqual(TIP_DEFAULT_MAX_WIDTH);

  await app.hover("id:anchor-lines");
  await app.clock!.runFor(50);
  await app.waitFor("id:tip-lines");
  const linesSize = measuredSize(app, "lines");
  expect(linesSize).not.toBeNull();
  expect(linesSize!.w).toBeLessThanOrEqual(TIP_DEFAULT_MAX_WIDTH);
  // 4 lines at 12pt * 1.45 (~17.4pt/line) + vertical chrome (~12pt) is well under 110pt (24 lines would be > 400pt).
  expect(linesSize!.h).toBeLessThan(120);

  // Empty Tip stays disabled and never opens a blank bubble.
  await app.hover("id:anchor-empty");
  await app.clock!.runFor(600);
  expect(app.shows("id:tip-empty")).toBe(false);
});

test("a long tooltip stays inside a narrow viewport smaller than maxWidth", async () => {
  const app = await openHarness(240, 600);
  await app.waitFor("id:anchor-long");
  await app.hover("id:anchor-long");
  await app.clock!.runFor(550);
  await app.waitFor("id:tip-long");
  const narrowSize = measuredSize(app, "long");
  expect(narrowSize).not.toBeNull();
  // Viewport 240 minus 8pt margin on both sides = 224pt.
  expect(narrowSize!.w).toBeLessThanOrEqual(224);
});

test("Tip supports controlled open, onOpenChange, Escape cancel, and disabled suppression", async () => {
  const app = await openHarness(900, 720);
  await app.waitFor("id:anchor-controlled");
  expect(app.shows("id:tip-controlled")).toBe(false);

  // Programmatic open without hover.
  await app.press("id:toggle-controlled");
  await app.waitFor("id:tip-controlled");
  expect(app.shows("id:tip-controlled")).toBe(true);

  // Escape asks to close with reason "cancel".
  await app.keyboard.press("escape");
  await app.waitFor("id:tip-controlled", { state: "gone" });
  expect(app.texts().find((t) => t.startsWith("events:"))).toContain("close:cancel");

  // Hover opens through onOpenChange.
  await app.hover("id:anchor-controlled");
  await app.clock!.runFor(550);
  await app.waitFor("id:tip-controlled");
  expect(app.texts().find((t) => t.startsWith("events:"))).toContain("open:hover");

  // Moving away closes through onOpenChange.
  await app.hover("id:away");
  await app.clock!.runFor(50);
  await app.waitFor("id:tip-controlled", { state: "gone" });

  // Disabled suppresses opening even when toggled open or hovered.
  await app.press("id:toggle-disabled");
  await app.hover("id:anchor-controlled");
  await app.clock!.runFor(600);
  expect(app.shows("id:tip-controlled")).toBe(false);
  await app.press("id:toggle-controlled");
  await app.clock!.runFor(50);
  expect(app.shows("id:tip-controlled")).toBe(false);
});

test("CommandActivity shows a controlled tooltip on folded rows and hides it on click, scroll, or collapse", async () => {
  const app = await openHarness(900, 720);
  await app.waitFor("id:command-summary");
  await app.press("id:command-summary");
  await app.waitFor("id:command-card");

  // CommandActivity starts scrolled to its end; the last row carries the long shell command.
  const lastLine = "id:command-line >> nth=14";
  await app.hover(lastLine);
  await app.clock!.runFor(550);
  await app.waitFor("id:command-tip-c:16");
  expect(app.shows("id:command-tip-c:16")).toBe(true);

  // Scrolling the command list dismisses the open tooltip immediately.
  await app.scroll("id:command-scroll", -80);
  await app.waitFor("id:command-tip-c:16", { state: "gone" });

  // Scroll back down, re-hover to show again, then press to open output and dismiss the tooltip.
  await app.scroll("id:command-scroll", 80);
  await app.hover("id:away");
  await app.clock!.runFor(50);
  await app.hover(lastLine);
  await app.clock!.runFor(550);
  await app.waitFor("id:command-tip-c:16");
  await app.press(lastLine);
  await app.waitFor("id:command-output");
  await app.waitFor("id:command-tip-c:16", { state: "gone" });

  // Collapsing the command card leaves no tooltip behind.
  await app.press("id:command-summary");
  await app.waitFor("id:command-card", { state: "gone" });
  expect(app.shows("id:command-tip-c:16")).toBe(false);
});

test("ProjectCommandMenu shows a controlled tooltip for long skill descriptions and skips empty ones", async () => {
  const app = await openHarness(900, 720);
  await app.waitFor("id:command-run-workflow");

  await app.hover("id:command-run-workflow");
  await app.clock!.runFor(550);
  await app.waitFor("id:command-tip-run-workflow");
  expect(app.shows("id:command-tip-run-workflow")).toBe(true);

  // Escape dismisses the tooltip.
  await app.keyboard.press("escape");
  await app.waitFor("id:command-tip-run-workflow", { state: "gone" });

  // Empty description opens no blank tooltip.
  await app.hover("id:command-empty");
  await app.clock!.runFor(600);
  expect(app.shows("id:command-tip-empty")).toBe(false);

  // Picking a command dismisses any open tooltip.
  await app.hover("id:command-run-workflow");
  await app.clock!.runFor(550);
  await app.waitFor("id:command-tip-run-workflow");
  await app.press("id:command-run-workflow");
  await app.waitFor("id:command-tip-run-workflow", { state: "gone" });
  expect(app.texts()).toContain("picked:run-workflow");
});
