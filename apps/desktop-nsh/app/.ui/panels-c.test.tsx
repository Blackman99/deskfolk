import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const open = async (mode: string, options = {}) => {
  const app = await openStory("panels-c", options);
  await app.waitFor(`id:mode-${mode}`, { timeout: 15_000 });
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("log=")));
  // The snapshot has to hold the seeded Bots and the group before a mode can mount.
  await app.wait(600);
  await app.press(`id:mode-${mode}`);
  return app;
};

/** What the daemon holds, read by the story: `kind:` and its text. */
const ask = async (app: App, kind: "bot" | "group"): Promise<string> => {
  await app.press(`id:tool-probe-${kind}`);
  await app.waitUntil(() => app.texts().some((t) => t.startsWith(`${kind}:`)), { timeout: 10_000 });
  return app.texts().find((t) => t.startsWith(`${kind}:`))!.slice(kind.length + 1);
};
const logged = (app: App, part: string) => app.texts().some((t) => t.startsWith("log=") && t.includes(part));

// ---- a Bot's profile ------------------------------------------------------

test("beside a pane, a Bot's settings open on the basics with the five tabs", async () => {
  const app = await open("beside-writer");
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  for (const tab of ["basics", "skills", "routines", "memory", "actions"]) expect(app.shows(`id:bot-tab-${tab}`)).toBe(true);
  expect(app.value("id:profile-name")).toBe("Writer");
  expect(app.shows("id:settings-head")).toBe(true);
  // A wide window has no section header or list: the tab strip is the way.
  expect(app.shows("id:bot-detail-head")).toBe(false);
});

test("a tab shows its own card and the others go", async () => {
  const app = await open("beside-writer");
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  await app.press("id:bot-tab-actions");
  await app.waitFor("id:bot-actions-card");
  expect(app.shows("id:profile-basics")).toBe(false);
  await app.press("id:bot-tab-skills");
  await app.waitFor("id:shared-skills-card");
  expect(app.shows("id:bot-actions-card")).toBe(false);
  await app.press("id:bot-tab-routines");
  await app.waitFor("id:routine-section");
  expect(app.shows("id:shared-skills-card")).toBe(false);
  await app.press("id:bot-tab-memory");
  await app.waitUntil(() => !app.shows("id:routine-section"));
});

test("typing in the basics saves the Bot by itself", async () => {
  const app = await open("beside-writer");
  await app.waitUntil(() => app.value("id:profile-duties") === "写东西、改东西", { timeout: 15_000 });
  await app.type("id:profile-duties", "，也写周报");
  await app.waitFor("text:已自动保存", { timeout: 10_000 });
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西，也写周报|active");
  await app.clear("id:profile-duties");
  await app.type("id:profile-duties", "写东西、改东西");
  await app.waitUntil(() => app.value("id:profile-duties") === "写东西、改东西");
  await app.wait(1500);
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active");
});

test("an empty name is refused, marks the Basics tab and is not saved", async () => {
  const app = await open("beside-writer");
  await app.waitUntil(() => app.value("id:profile-name") === "Writer", { timeout: 15_000 });
  await app.clear("id:profile-name");
  await app.waitFor("id:bot-tab-error", { timeout: 5000 });
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active");
  await app.type("id:profile-name", "Writer");
  await app.waitFor("id:bot-tab-error", { state: "gone", timeout: 5000 });
});

test("the actions tab archives and restores the Bot, and the buttons arm the confirms", async () => {
  const app = await open("beside-writer");
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  await app.press("id:bot-tab-actions");
  await app.press("id:bot-archive");
  await app.waitFor("id:bot-restore", { timeout: 10_000 });
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|archived");
  await app.press("id:bot-restore");
  await app.waitFor("id:bot-archive", { timeout: 10_000 });
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active");
  await app.press("id:bot-clear-history");
  await app.waitUntil(() => logged(app, "clear-history:direct"));
  await app.press("id:bot-delete");
  await app.waitUntil(() => logged(app, "delete-bot:writer"));
});

test("the skill sheet opens over the pane and Back closes it before anything else", async () => {
  const app = await open("beside-writer");
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  await app.press("id:bot-tab-skills");
  await app.waitFor("id:skills-card");
  await app.press("id:skill-add");
  await app.waitFor("id:skill-editor");
  await app.press("id:skill-cancel");
  await app.waitFor("id:skill-editor", { state: "gone" });
});

// ---- a group ----------------------------------------------------------------

test("beside a pane, a group's settings show its identity, members and actions", async () => {
  const app = await open("beside-group");
  await app.waitFor("id:group-identity", { timeout: 15_000 });
  expect(app.value("id:detail-group-name")).toBe("周报小组");
  await app.waitFor("id:group-members-card");
  expect(app.shows("id:member-you")).toBe(true);
  expect(app.texts()).toContain("创建者");
  expect(app.texts()).toContain("Writer");
  expect(app.texts()).toContain("Editor");
  // Wide: every card at once, and no section list.
  expect(app.shows("id:group-actions-card")).toBe(true);
  expect(app.shows("id:group-danger-zone")).toBe(true);
  expect(app.shows("id:group-sections")).toBe(false);
  expect(app.shows("id:session-mute")).toBe(true);
});

test("a member's name opens that Bot's profile", async () => {
  const app = await open("beside-group");
  await app.waitFor("id:group-members-card", { timeout: 15_000 });
  await app.waitUntil(() => app.shows("text:Writer"));
  const writer = app.texts().includes("Writer");
  expect(writer).toBe(true);
  await app.press("text:Writer");
  await app.waitUntil(() => logged(app, "open-profile:writer"));
});

test("the group's last two Bots cannot be removed", async () => {
  const app = await open("beside-group");
  await app.waitFor("id:group-members-card", { timeout: 15_000 });
  await app.waitFor("id:group-pane");
  const remove = app.count("text:移出");
  expect(remove).toBeGreaterThan(0);
  expect(app.enabled("text:移出 >> nth=0")).toBe(false);
});

test("the danger zone asks the shell to confirm clearing and deleting", async () => {
  const app = await open("beside-group");
  await app.waitFor("id:group-danger-zone", { timeout: 15_000 });
  await app.press("id:group-clear-history");
  await app.waitUntil(() => logged(app, "clear-history:group"));
  await app.press("id:group-delete");
  await app.waitUntil(() => logged(app, "delete-group:group"));
});

test("a group archives from its actions and restores", async () => {
  const app = await open("beside-group");
  await app.waitFor("id:group-archive", { timeout: 15_000 });
  await app.press("id:group-archive");
  await app.waitFor("id:group-restore", { timeout: 10_000 });
  expect(await ask(app, "group")).toMatch(/\|archived\|/);
  await app.press("id:group-restore");
  await app.waitFor("id:group-archive", { timeout: 10_000 });
  expect(await ask(app, "group")).toMatch(/\|active\|/);
});

test("a group is renamed from its head and the name is read back", async () => {
  const app = await open("beside-group");
  await app.waitFor("id:detail-group-name", { timeout: 15_000 });
  await app.waitUntil(() => app.value("id:detail-group-name") === "周报小组");
  await app.type("id:detail-group-name", "二");
  await app.submit("id:detail-group-name");
  await app.wait(800);
  expect((await ask(app, "group")).startsWith("周报小组二|")).toBe(true);
  await app.clear("id:detail-group-name");
  await app.type("id:detail-group-name", "周报小组");
  await app.submit("id:detail-group-name");
  await app.wait(800);
  expect((await ask(app, "group")).startsWith("周报小组|")).toBe(true);
});

// ---- the drawer ------------------------------------------------------------------

test("the drawer opens over the window, and its scrim and close button close it", async () => {
  const app = await open("drawer-writer");
  await app.waitFor("id:session-settings-drawer", { timeout: 15_000 });
  await app.waitFor("id:profile-basics");
  await app.press("id:profile-backdrop");
  await app.waitFor("id:session-settings-drawer", { state: "gone" });
  await app.press("id:mode-drawer-writer");
  await app.waitFor("id:sheet-close", { timeout: 10_000 });
  await app.press("id:sheet-close");
  await app.waitFor("id:session-settings-drawer", { state: "gone" });
});

test("the drawer's Escape closes an open skill sheet, then the drawer", async () => {
  const app = await open("drawer-writer");
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  await app.press("id:bot-tab-skills");
  await app.press("id:skill-add");
  await app.waitFor("id:skill-editor");
  await app.back();
  await app.waitFor("id:skill-editor", { state: "gone" });
  expect(app.shows("id:session-settings-drawer")).toBe(true);
  await app.back();
  await app.waitFor("id:session-settings-drawer", { state: "gone" });
});

test("a group's drawer shows its pane; a Bot opened from it steps back to the group", async () => {
  const app = await open("drawer-nested");
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  expect(app.shows("id:sheet-back")).toBe(true);
  expect(app.texts()).toContain("返回群组设置");
  await app.press("id:sheet-back");
  await app.waitFor("id:group-pane", { timeout: 10_000 });
});

test("a group's drawer opens a member's profile through the shell", async () => {
  const app = await open("drawer-group");
  await app.waitFor("id:group-members-card", { timeout: 15_000 });
  await app.waitUntil(() => app.texts().includes("Writer"));
  await app.press("text:Writer");
  await app.waitUntil(() => logged(app, "open-profile:writer"));
});

test("the drawer's close button on a Bot's page leaves settings", async () => {
  const app = await open("drawer-nested");
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  await app.press("id:sheet-close");
  await app.waitFor("id:profile-basics", { state: "gone" });
  expect(app.shows("id:session-settings-drawer")).toBe(true);
});

// ---- a phone ------------------------------------------------------------------------

test("on a phone a Bot's settings are a list of sections, then one section", async () => {
  const app = await open("drawer-writer", { width: 390, height: 800 });
  await app.waitFor("id:bot-tabs", { timeout: 15_000 });
  expect(app.shows("id:profile-basics")).toBe(false);
  expect(app.shows("id:profile-backdrop")).toBe(false);
  await app.press("id:bot-tab-actions");
  await app.waitFor("id:bot-actions-card");
  // One header per screen: the section's own, with the way back in it.
  expect(app.shows("id:bot-detail-head")).toBe(true);
  expect(app.shows("id:settings-head")).toBe(false);
  expect(app.shows("id:bot-tabs")).toBe(false);
  await app.press("id:bot-detail-back");
  await app.waitFor("id:bot-tabs");
  expect(app.shows("id:bot-actions-card")).toBe(false);
  expect(app.shows("id:settings-head")).toBe(true);
});

test("on a phone the drawer's close button steps out of a section before it leaves", async () => {
  const app = await open("drawer-writer", { width: 390, height: 800 });
  await app.waitFor("id:bot-tabs", { timeout: 15_000 });
  await app.press("id:bot-tab-basics");
  await app.waitFor("id:profile-basics");
  await app.press("id:bot-detail-back");
  await app.waitFor("id:bot-tabs");
  await app.press("id:sheet-close");
  await app.waitFor("id:session-settings-drawer", { state: "gone" });
});

test("on a phone a group's settings are a list, then a section", async () => {
  const app = await open("drawer-group", { width: 390, height: 800 });
  await app.waitFor("id:group-sections", { timeout: 15_000 });
  expect(app.shows("id:group-members-card")).toBe(false);
  expect(app.shows("id:group-section-actions")).toBe(true);
  await app.press("id:group-section-members");
  await app.waitFor("id:group-members-card");
  expect(app.shows("id:group-danger-zone")).toBe(false);
  expect(app.shows("id:group-detail-head")).toBe(true);
  await app.press("id:group-detail-back");
  await app.waitFor("id:group-sections");
  await app.press("id:group-section-danger");
  await app.waitFor("id:group-danger-zone");
  expect(app.shows("id:group-members-card")).toBe(false);
  await app.press("id:group-detail-back");
  await app.waitFor("id:group-sections");
});
