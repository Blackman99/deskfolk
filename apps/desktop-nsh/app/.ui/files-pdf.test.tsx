import { afterAll, expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";
const state = (app: App) => app.texts().find((text) => text.startsWith("state:")) ?? "";
const has = (app: App, text: string) => app.texts().includes(text);
/** Every pending anchor the story logged, in order. */
function pendings(app: App): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const pattern = /pending:(\{[^}]*\})/g;
  const text = log(app);
  let hit = pattern.exec(text);
  while (hit) {
    out.push(JSON.parse(hit[1]!));
    hit = pattern.exec(text);
  }
  return out;
}

/** The story with its PDF uploaded and open in the viewer. */
async function opened(): Promise<App> {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-make");
  await app.waitFor("id:pdf-page-total", { timeout: 20_000 });
  return app;
}

test("pages get placeholders, the toolbar says how many and where we are", async () => {
  const app = await opened();
  expect(has(app, "/ 3 页")).toBe(true);
  expect(app.value("id:pdf-page-input")).toBe("1");
  expect(app.shows("id:pdf-page-1")).toBe(true);
  // Fit width, the widest page (the landscape one) filling the area: 100% here, named in the menu.
  expect(app.texts().some((text) => text.startsWith("适合宽度 · "))).toBe(true);
});

test("the zoom buttons step the zoom and the menu keeps it", async () => {
  const app = await opened();
  await app.press("id:pdf-zoom-in");
  expect(has(app, "110%")).toBe(true);
  await app.press("id:pdf-zoom-in");
  expect(has(app, "125%")).toBe(true);
  await app.press("id:pdf-zoom-out");
  await app.press("id:pdf-zoom-out");
  await app.press("id:pdf-zoom-out");
  expect(has(app, "90%")).toBe(true);
  await app.press("id:pdf-zoom");
  await app.waitFor("text:适合页面");
  await app.press("text:适合页面");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("适合页面 · ")));
});

test("⌘+ ⌘− ⌘0 zoom the pages", async () => {
  const app = await opened();
  await app.keyboard.press("mod+plus");
  expect(has(app, "110%")).toBe(true);
  await app.keyboard.press("mod+minus");
  await app.keyboard.press("mod+minus");
  expect(has(app, "90%")).toBe(true);
  await app.keyboard.press("mod+0");
  expect(app.texts().some((text) => text.startsWith("适合宽度 · "))).toBe(true);
});

test("typing a page number jumps to it; nonsense puts the current one back", async () => {
  const app = await opened();
  await app.clear("id:pdf-page-input");
  await app.type("id:pdf-page-input", "3");
  await app.submit("id:pdf-page-input");
  expect(app.value("id:pdf-page-input")).toBe("3");
  await app.clear("id:pdf-page-input");
  await app.type("id:pdf-page-input", "abc");
  await app.submit("id:pdf-page-input");
  expect(app.value("id:pdf-page-input")).toBe("3");
  await app.clear("id:pdf-page-input");
  await app.type("id:pdf-page-input", "99");
  await app.submit("id:pdf-page-input");
  expect(app.value("id:pdf-page-input")).toBe("3");
});

test("a file that is not a PDF and one that cannot be fetched each say so", async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-broken");
  await app.waitFor("id:pdf-error", { timeout: 20_000 });
  expect(has(app, "这个 PDF 已损坏，打不开。")).toBe(true);
  expect(app.shows("id:pdf-toolbar")).toBe(false);
  await app.press("id:story-missing");
  await app.waitUntil(() => has(app, "没能打开这个 PDF。"), { timeout: 20_000 });
});

test("existing rows are numbered boxes; the page that is gone is not drawn; a press on a number picks it", async () => {
  const app = await opened();
  await app.press("id:story-marks");
  for (const id of ["m1", "m2", "m3", "m4"]) expect(app.shows(`id:pdf-mark-${id}`)).toBe(true);
  expect(app.shows("id:pdf-mark-m5")).toBe(false);
  // Numbers count every row, drawn or not, as the list does.
  expect(app.count("id:pdf-mark-number-m4")).toBe(1);
  await app.press("id:pdf-mark-number-m3");
  expect(log(app)).toContain("pick:m3");
});

test("focusing a row flashes its box", async () => {
  const app = await opened();
  await app.press("id:story-marks");
  expect(app.value("id:pdf-page-input")).toBe("1");
  await app.press("id:story-focus");
  // m3 is on page 2: the viewer scrolled there.
  await app.waitUntil(() => app.value("id:pdf-page-input") === "2");
  expect(app.shows("id:pdf-mark-m3")).toBe(true);
});

test("a drag on a page in annotate mode hands over an anchor; outside it, nothing", async () => {
  const app = await opened();
  await app.drag("id:pdf-marks-1", { x: 80, y: 60 });
  expect(log(app)).not.toContain("draft:");
  await app.press("id:story-annotate");
  await app.drag("id:pdf-marks-1", { x: 80, y: 60 });
  expect(log(app)).toContain("draft:");
  const anchor = JSON.parse(/draft:(\{[^}]*\})/.exec(log(app))![1]!);
  expect(anchor.page).toBe(1);
  expect(anchor.w).toBeGreaterThan(0);
  expect(anchor.h).toBeGreaterThan(0);
  // The pending box now has its corners.
  expect(app.shows("id:pdf-pending")).toBe(true);
  for (const h of ["nw", "ne", "sw", "se"]) expect(app.shows(`id:pdf-handle-${h}`)).toBe(true);
});

test("a press in annotate mode makes a small box; picks turned off make nothing", async () => {
  const app = await opened();
  await app.press("id:story-annotate");
  await app.drag("id:pdf-marks-2", { x: 1, y: 1 });
  expect(log(app)).toContain("draft:");
  await app.press("id:story-escape");
  await app.press("id:story-disable");
  await app.press("id:story-annotate");
  const before = log(app);
  await app.drag("id:pdf-marks-1", { x: 80, y: 60 });
  expect(log(app)).toBe(before);
});

test("the pending box moves and resizes, and reports the new anchor", async () => {
  const app = await opened();
  await app.press("id:story-pending");
  expect(app.shows("id:pdf-pending")).toBe(true);
  await app.drag("id:pdf-pending", { x: 40, y: 30 });
  expect(log(app)).toContain("pending:");
  const moved = pendings(app)[0]!;
  expect(moved.x).toBeGreaterThan(0.2);
  expect(moved.y).toBeGreaterThan(0.2);
  expect(Math.abs((moved.w) - 0.3) < 1e-5).toBe(true);
  await app.drag("id:pdf-handle-se", { x: 30, y: 20 });
  const all = pendings(app);
  const resized = all[all.length - 1]!;
  expect(resized.w).toBeGreaterThan(moved.w);
  expect(Math.abs(resized.x - moved.x) < 1e-5).toBe(true);
});

test("a press on the pending box that does not move leaves it where it was", async () => {
  const app = await opened();
  await app.press("id:story-pending");
  await app.drag("id:pdf-pending", { x: 0, y: 0 });
  await app.drag("id:pdf-handle-se", { x: 1, y: 1 });
  expect(log(app)).not.toContain("pending:");
});

test("Escape with a box pending, or while choosing, cancels it", async () => {
  const app = await opened();
  await app.press("id:story-pending");
  await app.keyboard.press("escape");
  expect(log(app)).toContain("cancel");
  expect(app.shows("id:pdf-pending")).toBe(false);
  await app.press("id:story-annotate");
  await app.keyboard.press("escape");
  expect(log(app).split("cancel").length - 1).toBe(2);
  // Nothing engaged: the viewer does not use it.
  await app.press("id:story-escape");
  expect(log(app)).toContain("escape:false");
});

test("the arrow keys nudge the pending box", async () => {
  const app = await opened();
  await app.press("id:story-pending");
  await app.keyboard.press("right");
  const anchor = pendings(app)[0]!;
  expect(Math.abs((anchor.x) - 0.21) < 1e-5).toBe(true);
  await app.keyboard.press("shift+down");
  const all = pendings(app);
  expect(Math.abs((all[all.length - 1]!.h) - 0.11) < 1e-5).toBe(true);
});

test("the shell's preview column shows the preview with its width handle, and hands over what the Svelte passes", async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-show-shell");
  expect(app.shows("id:story-artifact-preview")).toBe(false);
  await app.press("id:story-open-preview");
  await app.waitFor("id:story-artifact-preview");
  expect(has(app, "preview:notes/story.md:column")).toBe(true);
  expect(app.shows("id:preview-split")).toBe(true);
  const width = () => Number(/width:(\d+)/.exec(app.texts().find((text) => text.startsWith("width:")) ?? "")?.[1]);
  const before = width();
  await app.drag("id:preview-split", { x: -60, y: 0 });
  // Dragging the handle left widens the column by the distance, as far as the clamp allows.
  expect(width()).toBe(before + 60);
  await app.drag("id:preview-split", { x: 40, y: 0 });
  expect(width()).toBe(before + 20);
});

test("the workspace view asks for a workspace when none is set, and hosts the preview when there is one", async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-show-workspace");
  await app.waitFor("id:story-workspace-preview");
  expect(has(app, "workspace:notes/a.md")).toBe(true);
  await app.press("id:story-pick");
  expect(log(app)).toContain("select:notes/b.md");
});

test("with no workspace chosen the view says so, and offers the settings and the way out", async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-unset");
  await app.press("id:story-show-workspace");
  await app.waitFor("id:workspace-unset");
  expect(app.shows("id:story-workspace-preview")).toBe(false);
  await app.press("id:workspace-open-settings");
  await app.press("id:workspace-close");
  expect(log(app)).toContain("open-settings | workspace-close");
});

test("on a phone the explorer is the whole width and still closes from its backdrop-less page", async () => {
  const app = await openStory("files-pdf", { width: 600, height: 800 });
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-show-explorer");
  await app.waitFor("id:workspace-overlay");
  expect(has(app, "explorer:notes/a.md")).toBe(true);
  await app.press("id:story-explorer-pane-close");
  expect(log(app)).toContain("explorer-close");
});

test("the explorer is a page over the window: a press outside the pane closes it", async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-show-explorer");
  await app.waitFor("id:workspace-overlay");
  expect(has(app, "explorer:notes/a.md")).toBe(true);
  await app.press("id:workspace-backdrop");
  expect(log(app)).toContain("explorer-close");
  expect(app.shows("id:workspace-overlay")).toBe(false);
});

afterAll(async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-clean");
  await app.waitUntil(() => state(app).startsWith("state:clean:"), { timeout: 20_000 });
  expect(state(app)).toBe("state:clean:0");
});
