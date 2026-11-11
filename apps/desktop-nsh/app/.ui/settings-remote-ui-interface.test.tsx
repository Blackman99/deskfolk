import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { INTERFACE_CODE_THEMES } from "@real-bot/protocol";
import { CODE_THEME_LABELS } from "../src/m/interface/code-theme.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");

type Profile = {
  css: string;
  enabled: boolean;
  behaviour: Record<string, unknown>;
  tokens: { light: Record<string, string>; dark: Record<string, string> };
  copy: { zh: Record<string, string> };
  revisions: string[];
};
type App = Awaited<ReturnType<typeof openStory>>;

/**
 * The daemon keeps one interface profile for the whole run, so every test starts from the
 * defaults (`seed-reset`) and the last one leaves them again.
 */
async function page(options: Parameters<typeof openStory>[1] = {}, seed: string[] = []) {
  const app = await openStory("settings-remote-ui", options);
  await app.waitFor("id:page-interface", { timeout: 10_000 });
  await app.press("id:seed-reset");
  for (const chip of seed) await app.press(chip);
  await read(app);
  await app.press("id:page-interface");
  await app.waitFor("id:interface-tab");
  return app;
}

/** The profile as the daemon has it now, read through the runtime by the story. */
async function read(app: App): Promise<Profile> {
  await app.wait(50);
  await app.press("id:read-profile");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("profile={")), { timeout: 8000 });
  const text = app.texts().find((entry) => entry.startsWith("profile={"))!;
  return JSON.parse(text.slice("profile=".length)) as Profile;
}

async function until(app: App, check: (p: Profile) => boolean): Promise<Profile> {
  const deadline = Date.now() + 6000;
  let last = await read(app);
  while (!check(last) && Date.now() < deadline) last = await read(app);
  expect(check(last)).toBe(true);
  return last;
}

async function pick(app: App, section: string) {
  await app.press(`id:interface-tab-${section}`);
}

test("the page opens on the behaviour with the switch over it, and one tab shows one part", async () => {
  const app = await page();
  await app.waitFor("id:interface-enabled-toggle");
  for (const section of ["behaviour", "tokens", "css", "copy", "history"]) expect(app.shows(`id:interface-tab-${section}`)).toBe(true);
  expect(app.texts()).toContain(t.ui.enabled);
  expect(app.shows("id:interface-behaviour")).toBe(true);
  expect(app.shows("id:interface-tokens")).toBe(false);
  await pick(app, "tokens");
  await app.waitFor("id:interface-tokens");
  expect(app.shows("id:interface-behaviour")).toBe(false);
  await pick(app, "css");
  await app.waitFor("id:css-text");
  await pick(app, "copy");
  await app.waitFor("id:interface-copy");
  await pick(app, "history");
  await app.waitFor("id:interface-history");
  expect(app.shows("id:interface-reports")).toBe(true);
  expect(app.shows("id:interface-enabled-toggle")).toBe(true);
});

test("the enabled switch and the behaviour choices change the profile the daemon keeps", async () => {
  const app = await page();
  await app.waitFor("id:behaviour-send_key-mod_enter");
  await app.press("id:behaviour-send_key-mod_enter");
  await until(app, (p) => p.behaviour.send_key === "mod_enter");
  await app.press("id:behaviour-time_format-12h");
  await until(app, (p) => p.behaviour.time_format === "12h");
  await app.press("id:behaviour-send_key-default");
  await until(app, (p) => (p.behaviour.send_key ?? null) === null);
  await app.press("id:interface-enabled-toggle");
  await until(app, (p) => p.enabled === false);
  await app.press("id:interface-enabled-toggle");
  await until(app, (p) => p.enabled === true);
  expect(app.shows("id:behaviour-content_glass")).toBe(true);
  expect(app.texts()).toContain(t.ui.behaviour.desktopOnly);
});

test("the code colours are picked per look from a list that starts with the app's own", async () => {
  const app = await page();
  await app.waitFor("id:behaviour-code_theme-dark");
  const theme = INTERFACE_CODE_THEMES.dark[0]!;
  const label = CODE_THEME_LABELS[theme as keyof typeof CODE_THEME_LABELS] ?? theme;
  await app.press("id:behaviour-code_theme-dark");
  await app.waitFor("text:" + label);
  await app.press("text:" + label);
  await until(app, (p) => (p.behaviour.code_theme as { dark?: string } | undefined)?.dark === theme);
});

test("a token is added for a look from the form and put back from its row", async () => {
  const app = await page();
  await pick(app, "tokens");
  await app.waitFor("id:token-add");
  expect(app.enabled("id:token-add")).toBe(false);
  await app.type("id:token-name", "--accent");
  await app.type("id:token-value", "#7040c0");
  await app.press("id:token-look-dark");
  await app.waitUntil(() => app.enabled("id:token-add"));
  await app.press("id:token-add");
  await app.waitFor("id:token-dark---accent");
  const added = await read(app);
  expect(added.tokens.dark["--accent"]).toBe("#7040c0");
  expect(added.tokens.light["--accent"]).toBeUndefined();
  expect(app.value("id:token-name")).toBe("");
  expect(app.shows("id:token-swatch-dark---accent")).toBe(true);
  await app.press("id:token-remove-dark---accent");
  await app.waitFor("id:token-dark---accent", { state: "gone" });
  await until(app, (p) => p.tokens.dark["--accent"] === undefined);
});

test("a token the daemon refuses says why under the form", async () => {
  const app = await page();
  await pick(app, "tokens");
  await app.waitFor("id:token-name");
  await app.type("id:token-name", "not-a-token");
  await app.type("id:token-value", "red");
  await app.press("id:token-add");
  await app.waitFor("id:token-problem");
  expect(app.shows("id:token-not-a-token")).toBe(false);
});

test("the stylesheet saves a second after typing stops, and shows its length", async () => {
  const app = await page();
  await pick(app, "css");
  await app.waitFor("id:css-text");
  await app.type("id:css-text", ".a { color: red }");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("17 字")));
  await app.waitUntil(() => app.texts().includes(t.sidebar.autoSaved), { timeout: 6000 });
  expect((await read(app)).css).toBe(".a { color: red }");
  await app.press("id:css-hooks-toggle");
  await app.waitFor("id:css-hooks");
  expect(app.texts().some((text) => text.startsWith('[data-ui="'))).toBe(true);
});

test("a stylesheet changed elsewhere meanwhile is shown, and yours stays to copy", async () => {
  const app = await page();
  await pick(app, "css");
  await app.waitFor("id:css-text");
  await app.type("id:css-text", ".mine {}");
  // Another editor (a Bot) changes it before this page's save, which then carries a stale revision.
  await app.press("id:seed-css-other");
  await app.waitFor("id:css-stale", { timeout: 6000 });
  await app.waitUntil(() => app.value("id:css-text") === ".bot { color: blue }");
  await app.press("id:css-copy-mine");
  await app.waitUntil(() => (app.clipboard() ?? "").includes(".mine {}"));
  expect((await read(app)).css).toBe(".bot { color: blue }");
});

test("the words you changed are listed in the language shown and put back one at a time", async () => {
  const app = await page({}, ["id:seed-copy"]);
  await pick(app, "copy");
  await app.waitFor("id:copy-row-composer.send");
  expect(app.texts()).toContain("发出去");
  await app.press("id:copy-remove-composer.send");
  await app.waitFor("id:copy-row-composer.send", { state: "gone" });
  expect(app.shows("id:copy-empty")).toBe(true);
  await until(app, (p) => p.copy.zh["composer.send"] === undefined);
});

test("history names who changed what; undo and restore call the revision endpoints", async () => {
  const app = await page({}, ["id:seed-motion"]);
  const before = await read(app);
  const latest = before.revisions[0]!;
  await pick(app, "history");
  await app.waitFor(`id:revision-${latest}`);
  expect(app.texts()).toContain(t.ui.history.you);
  await app.press(`id:revision-undo-${latest}`);
  await until(app, (p) => (p.behaviour.motion ?? null) === null);
  await app.waitFor("text:" + t.ui.history.undone);
  await app.press(`id:revision-restore-${latest}`);
  await until(app, (p) => p.behaviour.motion === "reduce");
});

test("putting everything back asks first, then resets the four parts", async () => {
  const app = await page({}, ["id:seed-motion"]);
  await pick(app, "history");
  await app.waitFor("id:interface-reset");
  await app.press("id:interface-reset");
  await app.waitFor("id:interface-reset-confirm");
  expect(app.texts()).toContain(t.ui.resetAllConfirm);
  await app.press("id:interface-reset-cancel");
  await app.waitFor("id:interface-reset-confirm", { state: "gone" });
  expect((await read(app)).behaviour.motion).toBe("reduce");
  await app.press("id:interface-reset");
  await app.press("id:interface-reset-confirm");
  await until(app, (p) => (p.behaviour.motion ?? null) === null && p.tokens.light["--accent"] === undefined);
});

test("the reports card says what each kind of window found, or that none has", async () => {
  const app = await page();
  await pick(app, "history");
  await app.waitFor("id:interface-reports");
  await app.waitUntil(() => app.shows("id:report-none") || app.shows("id:report-desktop"));
  if (app.shows("id:report-none")) expect(app.texts()).toContain(t.ui.report.none);
});

test("on a phone the parts are a list, each opened as a page of its own and closed by Back", async () => {
  const app = await page({ width: 600, height: 900 });
  await app.waitFor("id:section-tokens");
  expect(app.shows("id:interface-tab-tokens")).toBe(false);
  expect(app.shows("id:interface-enabled-toggle")).toBe(true);
  expect(app.shows("id:section-behaviour")).toBe(true);
  expect(app.texts()).toContain("title:");
  await app.press("id:section-tokens");
  await app.waitFor("id:interface-tokens");
  expect(app.shows("id:section-tokens")).toBe(false);
  await app.waitUntil(() => app.texts().includes(`title:${t.ui.sections.tokens}`));
  await app.press("id:probe-back");
  await app.waitFor("id:section-tokens");
  expect(app.texts()).toContain("log:back:true");
  await app.press("id:probe-back");
  await app.waitUntil(() => app.texts().includes("log:back:false"));
});

test("the shared profile is left at its defaults", async () => {
  const app = await page();
  const left = await read(app);
  expect(left.css).toBe("");
  expect(left.enabled).toBe(true);
});
