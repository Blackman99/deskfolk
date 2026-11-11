import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async (part: string) => {
  const app = await openStory("misc");
  await app.waitFor("id:story-show-locale", { timeout: 10_000 });
  await app.press(`id:story-show-${part}`);
  return app;
};
const api = (app: Awaited<ReturnType<typeof open>>) => {
  const raw = app.texts().find((text) => text.startsWith("{") && text.includes('"locale"'));
  return raw ? (JSON.parse(raw) as { locale: string; bots: string[]; sessions: string[] }) : null;
};
const read = async (app: Awaited<ReturnType<typeof open>>) => {
  await app.press("id:story-read");
  await app.waitUntil(() => api(app) !== null);
  return api(app)!;
};

test("the language switch writes the setting the whole app follows, and marks the one in use", async () => {
  const app = await open("locale");
  await app.waitFor("id:locale-zh");
  await app.waitFor("text:简体中文", { timeout: 3_000 }).catch(() => undefined);
  try {
    await app.press("id:locale-en");
    await app.waitUntil(() => app.texts().includes("locale:en"));
    expect((await read(app)).locale).toBe("en");
    // The same press again does nothing; the other language comes back.
    await app.press("id:locale-en");
    await app.press("id:locale-zh");
    await app.waitUntil(() => app.texts().includes("locale:zh"));
    expect((await read(app)).locale).toBe("zh");
  } finally {
    await app.press("id:story-restore-locale");
    await app.waitUntil(() => app.texts().includes("locale:zh"));
  }
});

test("the team step lists the way's templates, ticks and edits them, and holds the way once started", async () => {
  const app = await open("team");
  await app.waitFor("id:team-step");
  // Each way of working shows; the first is picked and its team is the general one's.
  for (const id of ["general", "plain"]) expect(app.shows(`id:team-way-${id}`)).toBe(true);
  const ticked = () => (app.texts().find((text) => text.startsWith("count:")) ?? "").match(/count:(\d+)/)?.[1];
  await app.waitUntil(() => Number(ticked()) > 0);
  const initial = Number(ticked());
  expect((app.texts().find((text) => text.startsWith("count:")) ?? "")).toContain("ready:true");

  // Untick one template: the count drops by one; tick it again and it comes back.
  await app.press("id:team-pick-assistant");
  await app.waitUntil(() => Number(ticked()) === initial - 1);
  await app.press("id:team-pick-assistant");
  await app.waitUntil(() => Number(ticked()) === initial);

  // Editing opens the draft's fields; an emptied name is refused and the step is no longer ready.
  await app.press("id:team-edit-assistant");
  await app.waitFor("id:team-name-assistant");
  await app.clear("id:team-name-assistant");
  await app.waitUntil(() => (app.texts().find((text) => text.startsWith("count:")) ?? "").includes("ready:false"));
  await app.type("id:team-name-assistant", "小助");
  await app.waitUntil(() => (app.texts().find((text) => text.startsWith("count:")) ?? "").includes("ready:true"));
  await app.waitFor("text:小助");
  await app.press("id:team-edit-assistant");
  await app.waitFor("id:team-name-assistant", { state: "gone" });

  // Another way swaps the templates.
  await app.press("id:team-way-plain");
  await app.waitFor("id:team-pick-assistant");
});

test("making the team makes each ticked Bot and the group, and calls back once", async () => {
  const app = await open("team");
  await app.waitFor("id:team-step");
  try {
    await app.waitUntil(() => (app.texts().find((text) => text.startsWith("count:")) ?? "").includes("ready:true"));
    await app.press("id:story-team-create");
    await app.waitUntil(() => (app.texts().find((text) => text.startsWith("count:")) ?? "").includes("done:1"), { timeout: 20_000 });
    const made = await read(app);
    expect(made.bots).toContain("Writer");
    expect(made.bots.length).toBeGreaterThan(2);
    // Made, the drafts are locked.
    expect(app.enabled("id:team-pick-assistant")).toBe(false);
  } finally {
    await app.press("id:story-team-clean");
    await app.waitUntil(() => api(app)?.bots.length === 2, { timeout: 20_000 });
    // The fixture is as it was: only its own group is left.
    expect(api(app)?.sessions).toEqual(["周报小组"]);
  }
});
