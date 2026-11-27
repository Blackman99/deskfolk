import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const WIDTH_KEY = "real-bot-git-changes-tree-width";

test("git diff renders files as a compacted tree, toggles folders, selects files, and auto-expands during filter", async () => {
  const app = await openStory("git-changes", { width: 1000, height: 720 });
  await app.waitFor("id:git-changes-list", { timeout: 15_000 });

  // Compacted folder rows and nested files appear in the tree.
  await app.waitFor("id:git-dir-apps/desktop-nsh/app/src");
  expect(app.shows("id:git-dir-apps/desktop-nsh/app/src/m/git")).toBe(true);
  expect(app.shows("id:git-dir-apps/desktop-nsh/app/src/ui/git")).toBe(true);
  expect(app.shows("id:git-dir-packages/protocol/src")).toBe(true);
  expect(app.shows("id:git-file-README.md")).toBe(true);
  expect(app.shows("id:git-file-apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx")).toBe(true);

  // First file in visual tree order is selected automatically.
  await app.waitUntil(
    () => app.texts().includes("apps/desktop-nsh/app/src/m/git/change-tree.ts"),
    { timeout: 10_000 },
  );

  // Clicking a folder collapses its children; clicking again expands them.
  await app.press("id:git-dir-apps/desktop-nsh/app/src/ui/git");
  await app.waitUntil(() => !app.shows("id:git-file-apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx"));
  expect(app.shows("id:git-file-apps/desktop-nsh/app/src/ui/git/GitChangesTree.tsx")).toBe(false);

  // Filtering auto-expands previously collapsed folders containing matching files.
  await app.type("id:git-changes-filter", "GitChangesView");
  await app.waitFor("id:git-file-apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx");
  expect(app.shows("id:git-file-README.md")).toBe(false);

  // Clicking the filtered file opens its diff.
  await app.press("id:git-file-apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx");
  await app.waitUntil(() => app.texts().includes("apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx"));

  // Clearing the filter restores the other files and auto-keeps the selected file's folder visible.
  await app.clear("id:git-changes-filter");
  await app.waitFor("id:git-file-README.md");

  // Re-expand ui/git if it was still collapsed before selection, then verify clicking README switches diff.
  await app.press("id:git-file-README.md");
  await app.waitUntil(() => app.texts().includes("README.md"));
});

test("dragging the git diff file tree divider resizes, clamps, and persists width", async () => {
  const app = await openStory("git-changes", { width: 1000, height: 720 });
  await app.waitFor("id:git-changes-split", { timeout: 15_000 });

  // Drag right by +100px from default 250px -> ~350px.
  await app.drag("id:git-changes-split", { x: 100 });
  const widened = Number(app.storage()[WIDTH_KEY]);
  expect(widened).toBeGreaterThanOrEqual(330);
  expect(widened).toBeLessThanOrEqual(370);

  // Drag far left -> clamps to GIT_CHANGES_TREE_MIN (180).
  await app.drag("id:git-changes-split", { x: -400 });
  expect(Number(app.storage()[WIDTH_KEY])).toBe(180);

  // Drag far right -> clamps to GIT_CHANGES_TREE_MAX (520) on 1000px view (55% = 550 > 520).
  await app.drag("id:git-changes-split", { x: 700 });
  expect(Number(app.storage()[WIDTH_KEY])).toBe(520);

  // Restores persisted width in a newly opened view.
  const reopened = await openStory("git-changes", {
    width: 1000,
    height: 720,
    storage: { [WIDTH_KEY]: "340" },
  });
  await reopened.waitFor("id:git-changes-split", { timeout: 15_000 });
  await reopened.drag("id:git-changes-split", { x: 20 });
  const shifted = Number(reopened.storage()[WIDTH_KEY]);
  expect(shifted).toBeGreaterThanOrEqual(350);
  expect(shifted).toBeLessThanOrEqual(370);
});

test("narrow mode hides the drag divider and navigates files in visual tree order", async () => {
  const app = await openStory("git-changes", { width: 420, height: 720 }, { narrow: true });
  await app.waitFor("id:git-changes-list", { timeout: 15_000 });
  expect(app.shows("id:git-changes-split")).toBe(false);

  // Tap first file in tree -> drills into diff pager at 1 / 5.
  await app.press("id:git-file-apps/desktop-nsh/app/src/m/git/change-tree.ts");
  await app.waitFor("id:git-diff-pager-bar");
  expect(app.texts()).toContain("1 / 5");

  // Next advances in visual tree order to GitChangesTree.tsx (2 / 5).
  await app.press("id:git-diff-next");
  await app.waitUntil(() => app.texts().includes("2 / 5"));
  await app.waitUntil(() => app.texts().includes("GitChangesTree.tsx"));
});

const GRAPH_LIST_KEY = "real-bot-git-graph-list-width";
const COMMIT_FILES_W_KEY = "real-bot-git-commit-files-width";
const COMMIT_FILES_H_KEY = "real-bot-git-commit-files-height";

test("git history renders commit files as a tree side-by-side on wide panes with draggable dividers", async () => {
  const app = await openStory("git-changes", { width: 1100, height: 720 }, { view: "graph" });
  await app.waitFor("id:git-commit-files-tree", { timeout: 15_000 });

  // Compacted folder rows and nested files appear in commit file tree.
  await app.waitFor("id:git-commit-dir-apps/desktop-nsh/app/src");
  expect(app.shows("id:git-commit-dir-apps/desktop-nsh/app/src/m/git")).toBe(true);
  expect(app.shows("id:git-commit-dir-apps/desktop-nsh/app/src/ui/git")).toBe(true);
  expect(app.shows("id:git-commit-file-README.md")).toBe(true);

  // Wide inspector (>= 540px) uses left-right layout with vertical split handle.
  expect(app.shows("id:git-graph-split")).toBe(true);
  expect(app.shows("id:git-commit-files-split")).toBe(true);
  expect(app.shows("id:git-commit-files-split-v")).toBe(false);

  // Clicking a folder collapses its children; clicking again expands them.
  await app.press("id:git-commit-dir-apps/desktop-nsh/app/src/ui/git");
  await app.waitUntil(() => !app.shows("id:git-commit-file-apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx"));
  await app.press("id:git-commit-dir-apps/desktop-nsh/app/src/ui/git");
  await app.waitFor("id:git-commit-file-apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx");

  // Dragging commit list divider and commit file tree divider persists widths.
  await app.drag("id:git-graph-split", { x: -60 });
  const graphW = Number(app.storage()[GRAPH_LIST_KEY]);
  expect(graphW).toBeGreaterThanOrEqual(240);
  expect(graphW).toBeLessThanOrEqual(280);

  await app.drag("id:git-commit-files-split", { x: 80 });
  const filesW = Number(app.storage()[COMMIT_FILES_W_KEY]);
  expect(filesW).toBeGreaterThanOrEqual(280);
  expect(filesW).toBeLessThanOrEqual(320);
});

test("git history falls back to top-bottom commit layout below threshold and switches back when widened", async () => {
  const app = await openStory("git-changes", { width: 760, height: 720 }, { view: "graph" });
  await app.waitFor("id:git-commit-files-tree", { timeout: 15_000 });

  // 760 - 320 = 440 < 540 -> stacked top-bottom layout with horizontal split handle.
  await app.waitFor("id:git-commit-files-split-v");
  expect(app.shows("id:git-commit-files-split")).toBe(false);

  // Dragging the horizontal divider resizes and persists file tree height.
  await app.drag("id:git-commit-files-split-v", { y: 60 });
  const filesH = Number(app.storage()[COMMIT_FILES_H_KEY]);
  expect(filesH).toBeGreaterThanOrEqual(220);
  expect(filesH).toBeLessThanOrEqual(260);

  // Widening the viewport switches commit inspector back to side-by-side layout.
  await app.setViewport(1100, 720);
  await app.waitFor("id:git-commit-files-split");
  expect(app.shows("id:git-commit-files-split-v")).toBe(false);
});

test("git history narrow mode drills into file tree and navigates commit diff in tree order", async () => {
  const app = await openStory("git-changes", { width: 420, height: 720 }, { view: "graph", narrow: true });
  await app.waitFor("id:git-commit-1234567", { timeout: 15_000 });
  expect(app.shows("id:git-graph-split")).toBe(false);

  await app.press("id:git-commit-1234567");
  await app.waitFor("id:git-commit-files-tree", { timeout: 10_000 });
  expect(app.shows("id:git-commit-files-split")).toBe(false);
  expect(app.shows("id:git-commit-files-split-v")).toBe(false);

  await app.press("id:git-commit-file-apps/desktop-nsh/app/src/m/git/change-tree.ts");
  await app.waitFor("id:git-diff-pager-bar");
  expect(app.texts()).toContain("1 / 5");

  await app.press("id:git-diff-next");
  await app.waitUntil(() => app.texts().includes("2 / 5"));
  await app.waitUntil(() => app.texts().includes("GitChangesTree.tsx"));
});
