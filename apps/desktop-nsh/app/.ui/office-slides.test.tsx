import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const OPEN_MS = 20_000;

test("a deck shows its first slide and turns pages with the buttons", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-deck", { timeout: 10_000 });
  await app.press("id:story-open-deck");
  await app.waitFor("id:office-pages", { timeout: OPEN_MS });
  expect(app.texts()).toContain("PowerPoint");
  expect(app.texts()).toContain("1 / 2");
  // Slide 1's title and subtitle are the layout's placeholders, filled in.
  await app.waitFor("text:季度回顾");
  expect(app.texts()).toContain("Deskfolk · 2026");
  expect(app.shows("id:office-slide-0")).toBe(true);
  expect(app.enabled("id:office-prev")).toBe(false);
  expect(app.enabled("id:office-next")).toBe(true);

  await app.press("id:office-next");
  await app.waitFor("text:要点");
  expect(app.texts()).toContain("2 / 2");
  for (const line of ["第一点", "第二点", "Third point"]) expect(app.texts()).toContain(line);
  expect(app.texts()).not.toContain("季度回顾");
  expect(app.enabled("id:office-next")).toBe(false);
  // The body's lines are bulleted by the master.
  expect(app.texts().filter((t) => t === "•")).toHaveLength(3);

  await app.press("id:office-prev");
  await app.waitFor("text:季度回顾");
  expect(app.texts()).toContain("1 / 2");
});

test("in full screen the keys turn the slides like a slide show, and Escape leaves", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-deck", { timeout: 10_000 });
  await app.press("id:story-open-deck");
  await app.waitFor("id:office-pages", { timeout: OPEN_MS });
  await app.press("id:office-full");
  await app.waitFor("id:office-filename");
  expect(app.texts()).toContain("sample.pptx");
  expect(app.count("id:office-type")).toBe(1);
  await app.keyboard.press("right");
  await app.waitFor("text:要点");
  await app.keyboard.press("right");
  expect(app.texts()).toContain("2 / 2");
  await app.keyboard.press("home");
  await app.waitFor("text:季度回顾");
  await app.keyboard.press("end");
  await app.waitFor("text:要点");
  await app.keyboard.press("left");
  await app.waitFor("text:季度回顾");
  // Leaving keeps the slide.
  await app.keyboard.press("right");
  await app.waitFor("text:要点");
  await app.keyboard.press("escape");
  await app.waitFor("id:office-filename", { state: "gone" });
  expect(app.texts()).toContain("2 / 2");
  expect(app.texts()).toContain("要点");
  expect(app.count("id:office-type")).toBe(1);
});

test("groups, pictures, lines, tables and theme colours are drawn, and each slide has its own ground", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-richdeck", { timeout: 10_000 });
  await app.press("id:story-open-richdeck");
  await app.waitFor("id:office-pages", { timeout: OPEN_MS });
  await app.waitFor("text:in a group");
  for (const line of ["First point", "Second point", "1.", "2.", "Header A", "Header B", "spanning cell"]) expect(app.texts()).toContain(line);
  await app.press("id:office-next");
  await app.waitFor("text:Second slide on a tinted ground");
  expect(app.texts()).not.toContain("in a group");
});
