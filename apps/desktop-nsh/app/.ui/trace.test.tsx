import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

/** A window tall enough for the whole board, so every card is on screen to press. */
async function board(options: { height?: number } = {}) {
  const app = await openStory("trace", { height: options.height ?? 1500 });
  await app.waitFor("id:trace-flow", { timeout: 15_000 });
  return app;
}

test("the board draws the newest rounds as cards and folds the older ones to a line", async () => {
  const app = await board();
  // The two newest rounds are open; the two before are one line each.
  await app.waitFor("id:trace-card-t3");
  await app.waitFor("id:trace-card-t2a");
  expect(app.shows("id:trace-card-t0")).toBe(false);
  expect(app.shows("id:trace-card-t1")).toBe(false);
  await app.waitFor("id:trace-round-user:r0");
  await app.waitFor("id:trace-round-user:r1");
  expect(app.texts()).toContain("再加一版配乐");
});

test("a round's line unfolds it, and folds it again", async () => {
  const app = await board();
  await app.press("id:trace-round-user:r1");
  await app.waitFor("id:trace-card-t1");
  await app.press("id:trace-round-user:r1");
  await app.waitFor("id:trace-card-t1", { state: "gone" });
});

test("pressing a card tells the host which message to jump to", async () => {
  const app = await board();
  await app.press("id:trace-card-open-t3");
  await app.waitUntil(() => app.texts().some((text) => text.includes("jump:group-1/a3")));
  // A card waiting on an approval jumps to the approval.
  await app.press("id:trace-card-open-t3a");
  await app.waitUntil(() => app.texts().some((text) => text.includes("jump:direct-1/m-approval")));
});

test("a card's files open in the host's preview, a bundle as a tree", async () => {
  const app = await board();
  await app.press("id:trace-card-files-t2a");
  await app.waitUntil(() => app.texts().some((text) => text.includes("artifact:work/先出分镜-7f3k/01-分镜草图/board.pdf|1|file")));
  await app.press("id:trace-card-files-t3a");
  await app.waitUntil(() => app.texts().some((text) => text.includes("|2|tree")));
});

test("a model choice unfolds under its card, marks the model, and closes", async () => {
  const app = await board();
  expect(app.shows("id:trace-route-t3")).toBe(false);
  await app.press("id:trace-route-toggle-t3");
  await app.waitFor("id:trace-route-t3");
  await app.waitFor("id:trace-route-review");
  // Pressing another card's toggle moves the one open panel.
  await app.press("id:trace-route-toggle-t3a");
  await app.waitFor("id:trace-route-t3a");
  await app.waitFor("id:trace-route-t3", { state: "gone" });
  await app.press("id:trace-route-toggle-t3");
  await app.waitFor("id:trace-route-mark");
  await app.press("id:trace-route-mark");
  await app.waitUntil(() => app.texts().some((text) => text.includes("marked:t3=true")));
  await app.press("id:trace-route-close");
  await app.waitFor("id:trace-route-t3", { state: "gone" });
});

test("a highlight lights its cards, and a round with one in it opens for it", async () => {
  const app = await board();
  await app.waitFor("id:trace-highlight-feedback");
  await app.waitFor("id:trace-highlight-blamed");
  expect(app.shows("id:trace-card-t0")).toBe(false);
  await app.press("id:trace-highlight-feedback");
  await app.waitFor("id:trace-card-t0");
  // Lighting the other kind lets the first round go back to a line.
  await app.press("id:trace-highlight-blamed");
  await app.waitFor("id:trace-card-t0", { state: "gone" });
  await app.press("id:trace-highlight-feedback");
  await app.waitFor("id:trace-card-t0");
  await app.press("id:trace-highlight-feedback");
  await app.waitFor("id:trace-card-t0", { state: "gone" });
});

test("a ticket seen on the board opens the rounds that worked in it", async () => {
  const app = await board();
  expect(app.shows("id:trace-card-t1")).toBe(false);
  await app.press("id:story-ticket");
  await app.waitFor("id:trace-card-t1");
});

test("asking for a card opens its round", async () => {
  const app = await board();
  expect(app.shows("id:trace-card-t1")).toBe(false);
  await app.press("id:story-focus");
  await app.waitFor("id:trace-card-t1");
});

test("the app's own calls hide until asked for, and the ones that went wrong can be lit", async () => {
  const app = await board();
  // Only the step that went wrong is drawn by default.
  await app.waitFor("id:trace-step-s2");
  expect(app.shows("id:trace-step-s1")).toBe(false);
  await app.press("id:trace-steps-toggle");
  await app.waitFor("id:trace-step-s1");
  await app.press("id:trace-steps-toggle");
  await app.waitFor("id:trace-step-s1", { state: "gone" });
  expect(app.shows("id:trace-steps-lit")).toBe(true);
});

test("zoom steps change the level, the level resets it, and the minimap toggles", async () => {
  const app = await board();
  await app.waitFor("id:trace-zoom-level");
  const level = () => app.texts().find((text) => /^\d+%$/.test(text));
  const before = Number.parseInt(level() ?? "0", 10);
  await app.press("id:trace-zoom-in");
  await app.waitUntil(() => Number.parseInt(level() ?? "0", 10) > before);
  await app.press("id:trace-zoom-out");
  await app.press("id:trace-zoom-out");
  await app.waitUntil(() => Number.parseInt(level() ?? "0", 10) < before);
  await app.press("id:trace-zoom-level");
  await app.waitUntil(() => level() === "100%");
  const shown = app.shows("id:trace-minimap");
  await app.press("id:trace-minimap-toggle");
  await app.waitUntil(() => app.shows("id:trace-minimap") !== shown);
  await app.press("id:trace-minimap-toggle");
  await app.waitUntil(() => app.shows("id:trace-minimap") === shown);
});

test("a trace that fails to load says so and tries again", async () => {
  const app = await board();
  await app.press("id:story-fail");
  await app.waitFor("id:trace-failed");
  await app.press("id:story-heal");
  await app.press("id:trace-retry");
  await app.waitFor("id:trace-flow");
  expect(app.shows("id:trace-failed")).toBe(false);
});

test("a job with nothing in it says there is nothing", async () => {
  const app = await board();
  await app.press("id:story-empty");
  await app.waitFor("id:trace-none");
  expect(app.shows("id:trace-flow")).toBe(false);
});

test("a board taller than the window opens on its newest round, and dragging it pans to the older ones", async () => {
  const app = await board({ height: 760 });
  await app.waitFor("id:trace-card-t3a");
  // The first round's line is above the window.
  expect(app.texts()).not.toContain("你：先把需求整理一下");
  await app.drag("id:trace-viewport", { x: 0, y: 700 });
  await app.waitUntil(() => app.texts().includes("你：先把需求整理一下"));
});

test("fit brings the whole board into the window", async () => {
  const app = await board({ height: 760 });
  await app.waitFor("id:trace-card-t3a");
  expect(app.texts()).not.toContain("你：先把需求整理一下");
  await app.press("id:trace-zoom-fit");
  await app.waitUntil(() => app.texts().includes("你：先把需求整理一下"));
  expect(app.texts().find((text) => /^\d+%$/.test(text))).not.toBe("100%");
});

test("dragging on the minimap carries the view along the board", async () => {
  const app = await board({ height: 760 });
  await app.waitFor("id:trace-minimap");
  expect(app.texts()).not.toContain("你：先把需求整理一下");
  // The map is the board small: pulling up on it carries the frame, and the view, toward the first round.
  await app.drag("id:trace-minimap", { x: 0, y: -120 });
  await app.waitUntil(() => app.texts().includes("你：先把需求整理一下"));
});

test("a step picked on the board opens its panel, which shows the answer and the call's settings", async () => {
  const app = await board();
  await app.press("id:trace-step-s2");
  await app.waitFor("id:trace-step-detail");
  // The model's answer, fetched whole, unfolds as a tree.
  await app.waitFor("id:trace-step-json");
  await app.press("id:trace-step-edit");
  await app.waitFor("id:story-call-editor");
  await app.press("id:trace-step-close");
  await app.waitFor("id:trace-step-detail", { state: "gone" });
  // Pressing the card again opens it, and again closes it.
  await app.press("id:trace-step-s2");
  await app.waitFor("id:trace-step-detail");
  await app.press("id:trace-step-s2");
  await app.waitFor("id:trace-step-detail", { state: "gone" });
});
