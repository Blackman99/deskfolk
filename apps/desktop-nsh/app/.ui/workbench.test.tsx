import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
const state = (app: App) => app.texts().find((t) => t.includes("float="))!;
const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("workbench", options);
  await app.waitFor("id:wb-state", { timeout: 15_000 });
  return app;
};

test("every pane of the layout is drawn with its tabs, and only the active tab's body is mounted", async () => {
  const app = await open();
  expect(app.count("id:wb-leaf")).toBe(3);
  for (const id of ["t1", "t2", "t3", "t4", "t5"]) expect(app.shows(`id:wb-tab-${id}`)).toBe(true);
  expect(app.texts()).toContain("日程");
  expect(app.texts()).toContain("用量");
  expect(app.texts()).toContain("账单");
  expect(app.texts()).toContain("zsh");
  expect(app.texts()).toContain("文件");
  // Three panes, three bodies: the other two tabs of the first pane are not mounted at all.
  expect(app.shows("id:body-t1")).toBe(true);
  expect(app.shows("id:body-t4")).toBe(true);
  expect(app.shows("id:body-t5")).toBe(true);
  expect(app.shows("id:body-t2")).toBe(false);
  expect(app.shows("id:body-t3")).toBe(false);
  // A divider between the first pane and the column, one between the two panes stacked in it.
  expect(app.shows("id:wb-sash-r-1")).toBe(true);
  expect(app.shows("id:wb-sash-c-1")).toBe(true);
  // Each tab's kind has its picture before its name.
  expect(app.shows("id:pane-tab-icon-routines")).toBe(true);
  expect(app.shows("id:pane-tab-icon-terminal")).toBe(true);
  expect(app.shows("id:pane-tab-icon-workspace")).toBe(true);
});

test("pressing a tab brings it to the front and makes its pane the current one", async () => {
  const app = await open();
  expect(state(app)).toContain("a[*t1,t2,t3]");
  await app.press("id:wb-tab-button-t3");
  expect(state(app)).toContain("a[t1,t2,*t3]");
  await app.waitFor("id:body-t3");
  expect(app.shows("id:body-t1")).toBe(false);
  // Pressing a tab in another pane moves the focus there.
  await app.press("id:wb-tab-button-t4");
  expect(state(app)).toContain("focus=b");
  await app.press("id:wb-tab-button-t1");
  expect(state(app)).toContain("focus=a");
  expect(state(app)).toContain("a[*t1,t2,t3]");
});

test("a press in a pane's body makes it the current pane", async () => {
  const app = await open();
  expect(state(app)).toContain("focus=a");
  await app.press("id:body-t4");
  expect(state(app)).toContain("focus=b");
  await app.press("id:body-t5");
  expect(state(app)).toContain("focus=d");
  await app.press("id:body-t1");
  expect(state(app)).toContain("focus=a");
});

test("a tab's × closes it; closing a pane's last tab closes the pane and its neighbour takes the room", async () => {
  const app = await open();
  await app.press("id:wb-tab-close-t3");
  expect(state(app)).toContain("a[*t1,t2]");
  expect(app.shows("id:wb-tab-t3")).toBe(false);
  await app.press("id:wb-tab-close-t5");
  expect(state(app)).not.toContain("d[");
  expect(app.count("id:wb-leaf")).toBe(2);
  // The column held one pane now, so it folded into the row: the divider is the row's.
  expect(state(app)).toMatch(/r:row\[[0-9./]+\]\(a\[\*t1,t2\] b\[\*t4\]\)/);
  expect(app.shows("id:wb-sash-c-1")).toBe(false);
});

test("a pane split off starts empty and says what to put in it; a conversation's Bot-less ways in are its list", async () => {
  const app = await open();
  await app.rightClick("id:wb-body-a");
  await app.press("id:wb-split-right");
  await app.waitFor("id:wb-empty");
  expect(app.texts()).toContain("这个窗格还没有内容");
  expect(app.texts()).toContain("从侧栏点一条会话放进来，或者从下面挑一个。");
  // The lead the shell gives (add a Bot, add a group) and the + menu's own list, set down in the pane.
  expect(app.shows("id:story-empty-lead")).toBe(true);
  expect(app.shows("id:wb-empty-card")).toBe(true);
  expect(app.shows("id:wb-new-pane-terminal")).toBe(true);
  expect(app.texts()).toContain("api server");
  // Its filter narrows the running terminals, and says so when none is left.
  await app.type("id:wb-empty-query", "vite");
  await app.waitFor("id:wb-menu-terminal-term-2");
  expect(app.shows("id:wb-menu-terminal-term-1")).toBe(false);
  await app.clear("id:wb-empty-query");
  await app.type("id:wb-empty-query", "nothing-like-this");
  await app.waitFor("text:没有命中。");
  expect(app.shows("id:wb-menu-terminal-term-2")).toBe(false);
  await app.clear("id:wb-empty-query");
  // Picking a terminal puts it in the pane as its first tab.
  await app.press("id:wb-menu-terminal-term-1");
  await app.waitFor("id:wb-tab-close-story-1", { timeout: 2000 }).catch(() => {});
  expect(app.shows("id:wb-empty")).toBe(false);
  expect(app.texts()).toContain("api server");
  expect(state(app)).toMatch(/\[\*story-1\]/);
});

test("a pane with nothing in it can be closed by its ×, the only tiled pane cannot", async () => {
  const app = await open();
  await app.rightClick("id:wb-body-b");
  await app.press("id:wb-split-down");
  await app.waitFor("id:wb-empty");
  expect(app.shows("id:wb-pane-close")).toBe(true);
  await app.press("id:wb-pane-close");
  await app.waitFor("id:wb-empty", { state: "gone" });
  expect(app.count("id:wb-leaf")).toBe(3);
  // Close down to one pane: its × is gone, closing it would only empty it again.
  await app.press("id:wb-tab-close-t5");
  await app.press("id:wb-tab-close-t4");
  await app.press("id:wb-tab-close-t3");
  await app.press("id:wb-tab-close-t2");
  await app.press("id:wb-tab-close-t1");
  await app.waitFor("id:wb-empty");
  expect(app.count("id:wb-leaf")).toBe(1);
  expect(app.shows("id:wb-pane-close")).toBe(false);
});

test("a window too narrow to divide shows the current pane alone, and widening brings the arrangement back", async () => {
  const app = await open();
  await app.press("id:wb-tab-button-t4");
  const before = state(app);
  await app.setViewport(520, 700);
  await app.waitFor("id:wb-sash-r-1", { state: "gone" });
  expect(app.count("id:wb-leaf")).toBe(1);
  expect(app.shows("id:body-t4")).toBe(true);
  expect(app.shows("id:wb-tab-t1")).toBe(false);
  await app.setViewport(1100, 760);
  await app.waitFor("id:wb-sash-r-1");
  expect(app.count("id:wb-leaf")).toBe(3);
  expect(state(app)).toBe(before);
});

test("more tabs than fit scroll sideways: arrows at the row's ends step along, and a tab brought to the front is scrolled into view", async () => {
  const app = await open();
  expect(app.shows("id:wb-tabs-forward")).toBe(false);
  expect(app.shows("id:wb-tabs-back")).toBe(false);
  // Ten more tabs, the last one in front: the row is scrolled to it, so there is more before, none after.
  await app.press("id:story-many");
  await app.waitFor("id:wb-tabs-back");
  expect(app.shows("id:wb-tabs-forward")).toBe(false);
  // The arrow steps along most of a row's width; now there is more after as well.
  await app.press("id:wb-tabs-back");
  await app.waitFor("id:wb-tabs-forward");
  // The + stays beside the row, which is only as wide as the pane allows.
  expect(app.shows("id:wb-new-tab >> nth=0")).toBe(true);
  // Switching to the first tab scrolls the row back to it: the forward arrow is there, the back one gone.
  await app.press("id:wb-tab-button-t1");
  await app.waitFor("id:wb-tabs-back", { state: "gone" });
  await app.waitFor("id:wb-tabs-forward");
});

test("a conversation pulled in from the list is made a tab in the pane where it is let go", async () => {
  const app = await open();
  await app.press("id:story-dragin");
  expect(state(app)).toMatch(/b\[t4,\*t9\]/);
  expect(app.texts()).toContain("外来");
  await app.waitFor("id:body-t9");
});

test("a commit that hands the same layout over as new objects keeps every pane's body; a tab brought forward builds only its own", async () => {
  const app = await open();
  const mounts = () => app.texts().find((t) => t.startsWith("mounts "))!;
  expect(mounts()).toBe("mounts t1=1,t4=1,t5=1");
  // The shell's layout is a fresh copy after every commit; the panes are the same panes.
  await app.press("id:story-copy");
  await app.press("id:story-copy");
  await app.press("id:body-t4");
  expect(state(app)).toContain("focus=b");
  expect(mounts()).toBe("mounts t1=1,t4=1,t5=1");
  await app.press("id:wb-tab-button-t2");
  await app.waitFor("id:body-t2");
  expect(mounts()).toBe("mounts t1=1,t4=1,t5=1,t2=1");
});
