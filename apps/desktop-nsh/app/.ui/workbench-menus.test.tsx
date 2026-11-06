import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
const state = (app: App) => app.texts().find((t) => t.includes("float="))!;
const note = (app: App) => app.texts().find((t) => t.startsWith("pinned") || t.startsWith("loose")) ?? "";
const open = async () => {
  const app = await openStory("workbench");
  await app.waitFor("id:wb-state", { timeout: 15_000 });
  return app;
};

test("a right click on a pane lists the four splits, the two with a key say which; Escape and a press outside close it", async () => {
  const app = await open();
  await app.rightClick("id:wb-body-d");
  await app.waitFor("id:wb-context-menu");
  for (const dir of ["up", "down", "left", "right"]) expect(app.enabled(`id:wb-split-${dir}`)).toBe(true);
  expect(app.texts()).toContain("向上分割");
  expect(app.texts()).toContain("向右分割");
  expect(app.texts()).toContain("⌘\\");
  expect(app.texts()).toContain("⇧⌘\\");
  // Off a tab it offers no closing of tabs; a pane can be closed.
  expect(app.shows("id:wb-close-tabs-others")).toBe(false);
  expect(app.shows("id:wb-close-pane")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:wb-context-menu", { state: "gone" });
  await app.rightClick("id:wb-body-d");
  await app.waitFor("id:wb-context-menu");
  await app.press("id:wb-tab-button-t1");
  await app.waitFor("id:wb-context-menu", { state: "gone" });
  expect(state(app)).not.toContain("wb-m");
});

test("each split puts the new pane on its side of the right-clicked one, and the menu closes", async () => {
  const app = await open();
  await app.rightClick("id:wb-body-d");
  await app.press("id:wb-split-up");
  expect(state(app)).toMatch(/c:col\[[0-9./]+\]\(b\[\*t4\] c?:?[^ ]*\(?wb-[a-z0-9-]+\[\]/);
  expect(app.shows("id:wb-context-menu")).toBe(false);
  await app.waitFor("id:wb-empty");
  await app.rightClick("id:wb-body-a");
  await app.press("id:wb-split-left");
  expect(state(app)).toMatch(/r:row\[[0-9./]+\]\(wb-[a-z0-9-]+\[\] a\[\*t1,t2,t3\]/);
});

test("a window too small for one more pane dims the split that would not fit", async () => {
  const app = await open();
  await app.setViewport(900, 330);
  await app.rightClick("id:wb-body-d");
  await app.waitFor("id:wb-context-menu");
  // The stacked pane is already as short as two 120-point floors allow: no more across the column.
  expect(app.enabled("id:wb-split-down")).toBe(false);
  expect(app.enabled("id:wb-split-up")).toBe(false);
  expect(app.enabled("id:wb-split-right")).toBe(true);
  await app.press("id:wb-split-down").catch(() => {});
  expect(state(app)).toContain("d[*t5]");
});

test("a right click on a tab leads with what the tab offers, then closing: it, the others, those to its right, all of them", async () => {
  const app = await open();
  await app.rightClick("id:wb-tab-t1");
  await app.waitFor("id:wb-action-pin");
  expect(app.texts()).toContain("固定");
  for (const scope of ["tab", "others", "right", "all"]) expect(app.shows(`id:wb-close-tabs-${scope}`)).toBe(true);
  // Acting runs it first, then closes the menu.
  await app.press("id:wb-action-pin");
  await app.waitFor("id:wb-context-menu", { state: "gone" });
  expect(note(app)).toContain("pinned");
  await app.rightClick("id:wb-tab-t1");
  expect(app.texts()).toContain("取消固定");
  await app.keyboard.press("escape");
  // To its right: t2 and t3 go with the menu pointed at t1.
  await app.rightClick("id:wb-tab-t1");
  await app.press("id:wb-close-tabs-right");
  expect(state(app)).toContain("a[*t1]");
  // Nothing is left to its right, nor others: those rows stay in the list, dimmed.
  await app.rightClick("id:wb-tab-t1");
  expect(app.enabled("id:wb-close-tabs-others")).toBe(false);
  expect(app.enabled("id:wb-close-tabs-right")).toBe(false);
  expect(app.enabled("id:wb-close-tabs-all")).toBe(true);
  await app.keyboard.press("escape");
});

test("close others keeps the tab the menu is for; close all empties the pane and closes it", async () => {
  const app = await open();
  await app.rightClick("id:wb-tab-t2");
  await app.press("id:wb-close-tabs-others");
  expect(state(app)).toContain("a[*t2]");
  await app.rightClick("id:wb-tab-t2");
  await app.press("id:wb-close-tabs-all");
  expect(state(app)).not.toContain("a[");
  expect(app.count("id:wb-leaf")).toBe(2);
});

test("a tab's ⋯ opens the same actions under it, and a second press on it closes them", async () => {
  const app = await open();
  // Only a tab with actions has the ⋯.
  expect(app.shows("id:wb-tab-more-t1")).toBe(true);
  expect(app.shows("id:wb-tab-more-t2")).toBe(false);
  await app.press("id:wb-tab-more-t1");
  await app.waitFor("id:wb-action-pin");
  expect(app.texts()).toContain("固定");
  expect(app.shows("id:wb-float-tab")).toBe(true);
  // The ⋯ lists no splits: it holds only the tab's own.
  expect(app.shows("id:wb-split-right")).toBe(false);
  await app.press("id:wb-tab-more-t1");
  await app.waitFor("id:wb-context-menu", { state: "gone" });
  await app.press("id:wb-tab-more-t1");
  await app.press("id:wb-action-pin");
  expect(note(app)).toContain("pinned");
});

test("Copy and Paste lead the splits where the shell says the thing keeps its own selection", async () => {
  const app = await open();
  // The terminal's tab is the one that does; its pane's menu offers them, other panes' do not.
  await app.rightClick("id:wb-body-b");
  await app.waitFor("id:wb-edit-copy");
  expect(app.enabled("id:wb-edit-copy")).toBe(true);
  expect(app.texts()).toContain("⌘C");
  expect(app.texts()).toContain("⌘V");
  await app.press("id:wb-edit-paste");
  expect(note(app)).toContain("pasted");
  await app.rightClick("id:wb-body-b");
  await app.press("id:wb-edit-copy");
  expect(note(app)).toContain("copied");
  // On the tab itself, not the terminal, there is nothing to copy.
  await app.rightClick("id:wb-tab-t4");
  await app.waitFor("id:wb-context-menu");
  expect(app.shows("id:wb-edit-copy")).toBe(false);
  await app.keyboard.press("escape");
  await app.rightClick("id:wb-body-a");
  await app.waitFor("id:wb-context-menu");
  expect(app.shows("id:wb-edit-copy")).toBe(false);
  await app.keyboard.press("escape");
});

test("the + opens the new-pane menu under it: a new terminal, the tools, then the terminals no tab shows", async () => {
  const app = await open();
  await app.press("id:wb-new-tab >> nth=0");
  await app.waitFor("id:wb-new-menu");
  for (const key of ["terminal", "workspace", "routines", "spend", "usage", "roles"]) expect(app.shows(`id:wb-new-pane-${key}`)).toBe(true);
  expect(app.texts()).toContain("新建终端");
  expect(app.texts()).toContain("可接回");
  expect(app.shows("id:wb-menu-terminal-term-1")).toBe(true);
  // Typing narrows the terminals by name or folder.
  await app.type("id:wb-new-query", "web");
  await app.waitFor("id:wb-menu-terminal-term-1", { state: "gone" });
  expect(app.shows("id:wb-menu-terminal-term-2")).toBe(true);
  // Picking a row opens it as a tab of the pane and puts the menu away.
  await app.press("id:wb-menu-terminal-term-2");
  await app.waitFor("id:wb-new-menu", { state: "gone" });
  expect(state(app)).toMatch(/a\[t1,t2,t3,\*story-\d+\]/);
  expect(app.texts()).toContain("vite");
  // A new one, and Escape closes it without doing anything.
  await app.press("id:wb-new-tab >> nth=0");
  await app.press("id:wb-new-pane-terminal");
  expect(state(app)).toMatch(/\*story-\d+\]/);
  await app.press("id:wb-new-tab >> nth=0");
  await app.waitFor("id:wb-new-menu");
  await app.keyboard.press("escape");
  await app.waitFor("id:wb-new-menu", { state: "gone" });
});

test("a press outside the + menu closes it, the + again closes it too", async () => {
  const app = await open();
  await app.press("id:wb-new-tab >> nth=0");
  await app.waitFor("id:wb-new-menu");
  await app.press("id:wb-tab-button-t4");
  await app.waitFor("id:wb-new-menu", { state: "gone" });
  await app.press("id:wb-new-tab >> nth=0");
  await app.waitFor("id:wb-new-menu");
  await app.press("id:wb-new-tab >> nth=0");
  await app.waitFor("id:wb-new-menu", { state: "gone" });
});
