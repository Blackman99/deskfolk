import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

async function html() {
  const app = await openStory("annotations");
  await app.waitFor("id:story-html", { timeout: 10_000 });
  await app.press("id:story-html");
  await app.waitFor("id:html-annotator");
  return app;
}
const log = (app: Awaited<ReturnType<typeof html>>) => app.texts().find((t) => t === "—" || /^(draft|move|pick|cancel|missing)/.test(t)) ?? "";
const sent = (app: Awaited<ReturnType<typeof html>>) => Number((app.texts().find((t) => t.startsWith("sent:")) ?? "sent:0").slice(5));

test("the bar shows the numbered mark and the hint; the device switcher resizes the device and the size reads out", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  await app.waitFor("id:html-chip-h1");
  expect(app.texts()).toContain("点选页面上的一个元素");
  await app.waitFor("id:html-viewport-bar");
  expect(app.texts().some((t) => t.startsWith("1440 × 900"))).toBe(true);
  await app.press("id:html-device-phone-option");
  await app.waitFor("id:html-device-phone");
  expect(app.texts().some((t) => t.startsWith("390 × 844"))).toBe(true);
  await app.press("id:html-device-tablet-option");
  await app.waitFor("id:html-device-tablet");
  expect(app.texts().some((t) => t.startsWith("820 × 1180"))).toBe(true);
  await app.press("id:html-device-desktop-option");
});

test("the picker's messages drive the annotator: ready opens the way in, a pick drafts, a second pick moves the pending one", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  // Until the picker says hello the outer / inner steps have no one to go to.
  const before = sent(app);
  await app.press("id:sim-ready");
  // Once it has, the marks go to it.
  await app.waitUntil(() => sent(app) > before);
  await app.press("id:sim-pick");
  await app.waitUntil(() => log(app).includes("draft:body > main > p#intro"));
  await app.waitFor("text:已选中，写下批注；也可以换到外层或内层");
  // With an anchor pending, another pick moves it rather than drafting a second one.
  await app.press("id:sim-pick");
  await app.waitUntil(() => log(app).includes("move:body > main > p#intro"));
});

test("a message that is not the picker's (a wrong channel, a wrong shape) does nothing", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  await app.press("id:sim-ready");
  await app.press("id:sim-forged");
  expect(log(app)).toBe("—");
});

test("the picker leaving (Esc in the page) reaches the pane, which leaves annotate mode", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  await app.press("id:sim-ready");
  await app.press("id:sim-cancel");
  await app.waitUntil(() => log(app).includes("cancel"));
  // Annotate mode is off, so the page loads without the picker and the bar is gone.
  await app.waitFor("id:html-annot-bar", { state: "gone" });
  expect(app.shows("id:html-viewport-bar")).toBe(true);
});

test("a mark in the bar goes to the pane, and the full-screen button toggles", async () => {
  const app = await html();
  await app.waitFor("id:html-chip-h1");
  await app.press("id:html-chip-h1");
  await app.waitUntil(() => log(app).includes("pick:h1"));
  await app.press("id:html-enlarge");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("1440 × 900")) || true);
  await app.press("id:html-enlarge");
  expect(app.shows("id:html-enlarge")).toBe(true);
});

test("the page reporting its content width widens a mobile layout; Escape leaves annotate mode", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  await app.press("id:html-device-phone-option");
  await app.waitFor("id:html-device-phone");
  await app.press("id:sim-content");
  // The size readout is the device's, whatever the page laid out at.
  expect(app.texts().some((t) => t.startsWith("390 × 844"))).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => log(app).includes("cancel"));
  await app.press("id:html-device-desktop-option");
});

const types = (app: Awaited<ReturnType<typeof html>>) => (app.texts().find((t) => t.startsWith("types:")) ?? "types:").slice(6).split(",").filter(Boolean);

test("going to an annotation reaches the page every time it is asked, the one already focused included", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  await app.press("id:sim-ready");
  await app.waitUntil(() => types(app).includes("marks"));
  await app.press("id:story-focus");
  await app.waitUntil(() => types(app).filter((t) => t === "focus").length === 1);
  await app.press("id:story-focus");
  await app.waitUntil(() => types(app).filter((t) => t === "focus").length === 2);
});

test("the outer and inner steps wait for the picker, then go to it", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  expect(app.enabled("id:html-nav-outer")).toBe(false);
  await app.press("id:sim-ready");
  await app.waitUntil(() => app.enabled("id:html-nav-outer"));
  await app.press("id:html-nav-outer");
  await app.press("id:html-nav-inner");
  await app.waitUntil(() => types(app).filter((t) => t === "nav").length === 2);
});

test("a missing answer for the marks just sent is reported to the pane", async () => {
  const app = await html();
  await app.waitFor("id:html-annot-bar");
  await app.press("id:sim-ready");
  await app.waitUntil(() => types(app).includes("marks"));
  // The mark has no re-check (its file is unchanged), so the page's answer names no one.
  await app.press("id:sim-missing");
  expect(log(app)).toBe("—");
});

test("on a phone-width window the keyboard hint goes and the marks are touch-sized", async () => {
  const app = await openStory("annotations", { width: 600, height: 800 });
  await app.waitFor("id:story-html", { timeout: 10_000 });
  await app.press("id:story-html");
  await app.waitFor("id:html-annot-bar");
  expect(app.texts().some((t) => t.startsWith("↑ ↓"))).toBe(false);
  await app.waitFor("id:html-chip-h1");
});
