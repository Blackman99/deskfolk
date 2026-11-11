import { afterEach, expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { APP_THEME } from "../src/ui/interface/theme";
import { openStory } from "./fixture";

const t = copyFor("zh");
type App = Awaited<ReturnType<typeof openStory>>;

/** The colour `token()` gives for a theme value written `#rrggbb`. */
const hex = (value: string) => `${value.toLowerCase()}ff`;
const APP = APP_THEME.cssVars;

let open: App | null = null;

/**
 * The daemon keeps one profile for the whole run: every test starts from the defaults and leaves
 * them, so the shell's tests after these see the app as it ships.
 */
async function story(): Promise<App> {
  const app = await openStory("interface");
  open = app;
  await app.waitFor("id:reset", { timeout: 10_000 });
  await app.waitUntil(() => line(app, "revision=") !== "revision=none", { timeout: 8000 });
  await backToDefaults(app);
  return app;
}

/** Resets the profile (a reset of nothing makes no revision, so the screen is what is waited on). */
async function backToDefaults(app: App): Promise<void> {
  await app.press("id:reset");
  await app.waitUntil(
    () =>
      line(app, "behaviour=") === "behaviour={}" &&
      line(app, "brand=") === `brand=${hex(APP.light.brand!)}` &&
      line(app, "words=") === `words=${t.composer.send}` &&
      line(app, "paused=") === "paused=none",
    { timeout: 8000 },
  );
}

afterEach(async () => {
  const app = open;
  open = null;
  if (!app) return;
  await app.setColorScheme("light");
  await backToDefaults(app);
});

/** The text of the line starting with `prefix`. */
function line(app: App, prefix: string): string {
  return app.texts().find((text) => text.startsWith(prefix)) ?? "";
}

/** Presses a button that changes the profile and waits for the daemon's next revision to arrive. */
async function press(app: App, selector: string): Promise<void> {
  const before = line(app, "revision=");
  await app.press(selector);
  await app.waitUntil(() => line(app, "revision=") !== before, { timeout: 8000 });
}

test("an empty profile gives the app's theme back exactly", async () => {
  const app = await story();
  expect(line(app, "roundtrip=")).toBe("roundtrip=true");
  expect(Number(line(app, "marked=").slice("marked=".length))).toBeGreaterThan(1);
});

test("tokens apply in each look, NSH's own follow the accent, and so does your bubble", async () => {
  const app = await story();
  await press(app, "id:apply-sample");
  await app.waitUntil(() => line(app, "brand=") === "brand=#7040c0ff");
  expect(app.spanStyle("text:brand-ink").color).toBe("#7040c0ff");
  expect(line(app, "primary=")).toBe("primary=#7040c0ff");
  expect(line(app, "you=")).toBe("you=#7040c0ff");
  expect(line(app, "pane=")).toBe("pane=#fbf7ffff");
  const outcome = JSON.parse(line(app, "outcome=").slice("outcome=".length)) as { applied: string[]; notHere: string[]; unread: string[] };
  expect(outcome.applied).toContain("light:--accent");
  expect(outcome.notHere).toEqual(["light:--dur-fast"]);
  expect(outcome.unread).toEqual([]);

  await app.setColorScheme("dark");
  await app.waitUntil(() => line(app, "brand=") === "brand=#c0a0ffff");
  expect(app.spanStyle("text:brand-ink").color).toBe("#c0a0ffff");
  // The pane was changed for the light look only; dark keeps its own.
  expect(line(app, "pane=")).toBe(`pane=${hex(APP.dark.pane!)}`);
  // Dark's bubble is the accent mixed 70% with black in oklab, not the app's own.
  expect(line(app, "you=")).not.toBe(`you=${hex(APP.dark.you!)}`);
  expect(line(app, "you=")).not.toBe("you=#c0a0ffff");
});

test("behaviour applies: 12-hour times, ⌘↩ to send, motion held still", async () => {
  const app = await story();
  expect(line(app, "time=")).toContain("15:04");
  expect(line(app, "motion=")).toBe("motion=false");
  await press(app, "id:apply-sample");
  await app.waitUntil(() => line(app, "motion=") === "motion=true");
  expect(line(app, "time=")).not.toContain("15:04");
  expect(line(app, "time=")).toContain("3:04");
  expect(line(app, "behaviour=")).toContain('"send_key":"mod_enter"');
});

test("your words take the app's place", async () => {
  const app = await story();
  expect(line(app, "words=")).toBe(`words=${t.composer.send}`);
  await press(app, "id:apply-sample");
  await app.waitUntil(() => line(app, "words=") === "words=发出去");
});

test("⌥⇧⌘U shows the app's own look in this window, words and behaviour kept, and brings yours back", async () => {
  const app = await story();
  await press(app, "id:apply-sample");
  await app.waitUntil(() => line(app, "brand=") === "brand=#7040c0ff");
  await app.keyboard.press("mod+alt+shift+u");
  await app.waitUntil(() => line(app, "paused=") === "paused=key");
  expect(line(app, "brand=")).toBe(`brand=${hex(APP.light.brand!)}`);
  expect(app.spanStyle("text:brand-ink").color).toBe(hex(APP.light.brand!));
  expect(line(app, "words=")).toBe("words=发出去");
  expect(line(app, "motion=")).toBe("motion=true");
  await app.waitFor("text:" + t.ui.toast.paused.replace("{key}", "⌥⇧⌘U"));
  await app.keyboard.press("mod+alt+shift+u");
  await app.waitUntil(() => line(app, "paused=") === "paused=none");
  expect(line(app, "brand=")).toBe("brand=#7040c0ff");
});

test("a value NSH cannot read is left out, not filled from the other look", async () => {
  const app = await story();
  await press(app, "id:apply-unreadable");
  await app.waitUntil(() => line(app, "brand=") === "brand=#7040c0ff");
  const outcome = JSON.parse(line(app, "outcome=").slice("outcome=".length)) as { applied: string[]; unread: string[] };
  expect(outcome.unread).toEqual(["light:--pane"]);
  expect(line(app, "pane=")).toBe(`pane=${hex(APP.light.pane!)}`);
});

test("a profile that leaves Stop unreadable is dropped in this window; words stay; the next profile gets its chance", async () => {
  const app = await story();
  await press(app, "id:apply-floor-break");
  await app.waitUntil(() => line(app, "paused=") === "paused=floor", { timeout: 6000 });
  expect(line(app, "floors=")).toBe("floors=stop");
  expect(line(app, "why=")).toContain("ink on btn-secondary-bg");
  expect(line(app, "ink=")).toBe(`ink=${hex(APP.light.ink!)}`);
  expect(line(app, "words=")).toBe("words=发出去");
  await app.waitFor("text:" + t.ui.toast.floorFailed.replace("{floor}", t.ui.floors.stop));
  await press(app, "id:apply-sample");
  await app.waitUntil(() => line(app, "paused=") === "paused=none" && line(app, "brand=") === "brand=#7040c0ff");
  // The approval button is a floor too: the sample keeps it readable, so nothing drops.
  await app.wait(800);
  expect(line(app, "paused=")).toBe("paused=none");
});

test("an approval button whose words take its fill's colour is a floor the profile hid", async () => {
  const app = await story();
  await press(app, "id:apply-hide-approve");
  await app.waitUntil(() => line(app, "paused=") === "paused=floor", { timeout: 6000 });
  expect(line(app, "floors=")).toBe("floors=approval");
  expect(line(app, "why=")).toContain("on-accent on brand");
  await app.waitFor("text:" + t.ui.toast.floorFailed.replace("{floor}", t.ui.floors.approval));
});

test("a profile that hides Stop only in the dark look is caught when the window turns dark", async () => {
  const app = await story();
  await press(app, "id:apply-dark-break");
  await app.wait(800);
  expect(line(app, "paused=")).toBe("paused=none");
  await app.setColorScheme("dark");
  await app.waitUntil(() => line(app, "paused=") === "paused=floor", { timeout: 6000 });
  expect(line(app, "floors=")).toBe("floors=stop");
  expect(line(app, "secondary=")).toBe(`secondary=${hex(APP.dark["btn-secondary-bg"]!)}`);
});

test("switched off, the window shows the app's look and words; the behaviour holds", async () => {
  const app = await story();
  await press(app, "id:apply-sample");
  await app.waitUntil(() => line(app, "words=") === "words=发出去");
  await press(app, "id:apply-off");
  await app.waitUntil(() => line(app, "brand=") === `brand=${hex(APP.light.brand!)}`);
  expect(line(app, "words=")).toBe(`words=${t.composer.send}`);
  expect(line(app, "motion=")).toBe("motion=true");
  await backToDefaults(app);
});
