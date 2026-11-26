/** The phone's + in both composers (`ComposerPlus`, ADR 0116 addendum 2026-11-23): what it holds, the sheets it opens, Back, and the chips. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");
const PHONE = { width: 390, height: 844 };

async function project(params: Record<string, unknown> = {}) {
  const app = await openStory("chat-stage", PHONE, params);
  await app.waitFor("id:show-project", { timeout: 15_000 });
  await app.press("id:show-project");
  await app.waitFor("id:project-chat", { timeout: 15_000 });
  await app.waitFor("id:project-plus", { timeout: 10_000 });
  return app;
}

test("on a phone a project session's row is the +, the microphone and Send: the clip, plan mode, the consultants and the model are in the +", async () => {
  const app = await project();
  for (const id of ["project-attach", "project-tune", "project-plan", "project-consult"]) expect(app.shows(`id:${id}`)).toBe(false);
  await app.press("id:project-plus");
  await app.waitFor("id:project-plus-sheet", { timeout: 5_000 });
  for (const id of ["project-plus-attach", "project-plus-plan", "project-plus-consult", "project-plus-tune"]) expect(app.shows(`id:${id}`)).toBe(true);
  expect(app.texts()).toContain(t.project.planMode);
  expect(app.texts()).toContain(t.project.consultNone);
  expect(app.texts()).toContain(t.composer.model);
  // Another agent's + holds the same: every agent has plan mode and the consultants.
  await app.back();
  await app.waitFor("id:project-plus-sheet", { state: "gone", timeout: 5_000 });
  await app.press("id:story-agent-codex");
  await app.press("id:project-plus");
  await app.waitFor("id:project-plus-sheet", { timeout: 5_000 });
  expect(app.shows("id:project-plus-plan")).toBe(true);
  expect(app.shows("id:project-plus-consult")).toBe(true);
  expect(app.texts()).toContain(t.project.planModeDetail("Codex"));
});

test("plan mode flips in the +, which stays; on, it is a chip on the row that turns it off in one press", async () => {
  const app = await project();
  expect(app.texts()).toContain("plan-mode:off");
  await app.press("id:project-plus");
  await app.waitFor("id:project-plus-plan", { timeout: 5_000 });
  await app.press("id:project-plus-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:on"), { timeout: 10_000 });
  expect(said(app)).toBe('tune:{"mode":"plan"}');
  expect(app.shows("id:project-plus-sheet")).toBe(true);
  await app.back();
  await app.waitFor("id:project-plus-sheet", { state: "gone", timeout: 5_000 });
  await app.waitFor("id:project-plan", { timeout: 5_000 });
  await app.press("id:project-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:off"), { timeout: 10_000 });
  await app.waitFor("id:project-plan", { state: "gone", timeout: 5_000 });
});

test("the model's row says what runs and opens the picker's sheet over the +; Back comes back to the +, then closes it", async () => {
  const app = await project();
  await app.press("id:project-plus");
  await app.waitFor("id:project-plus-tune", { timeout: 5_000 });
  await app.press("id:project-plus-tune");
  await app.waitFor("id:tune-sheet", { timeout: 5_000 });
  expect(app.shows("id:project-plus-sheet")).toBe(true);
  await app.back();
  await app.waitFor("id:tune-sheet", { state: "gone", timeout: 5_000 });
  expect(app.shows("id:project-plus-sheet")).toBe(true);
  await app.back();
  await app.waitFor("id:project-plus-sheet", { state: "gone", timeout: 5_000 });
});

test("the consultants' row opens their sheet over the +; the first added turns it on, and the chip on the row opens the same sheet, which turning off leaves up", async () => {
  const app = await project({ fixedAgents: true });
  await app.press("id:project-plus");
  await app.waitFor("id:project-plus-consult", { timeout: 5_000 });
  await app.press("id:project-plus-consult");
  await app.waitFor("id:consult-sheet", { timeout: 5_000 });
  // The add picker's sheet goes over the consultants' one.
  await app.press("id:consult-add");
  await app.waitFor("id:tune-row-agent-codex", { timeout: 5_000 });
  await app.press("id:tune-row-agent-codex");
  await app.waitFor("id:tune-row-model-default", { timeout: 5_000 });
  await app.press("id:tune-row-model-default");
  await app.waitFor("id:tune-row-effort-high", { timeout: 5_000 });
  await app.press("id:tune-row-effort-high");
  await app.waitUntil(() => app.texts().includes("consult:on:codex/-/high"), { timeout: 10_000 });
  await app.waitFor("id:consult-member-0", { timeout: 5_000 });
  expect(app.shows("id:consult-sheet")).toBe(true);
  // Back: the consultants' sheet, then the +, which now names who.
  await app.back();
  await app.waitFor("id:consult-sheet", { state: "gone", timeout: 5_000 });
  expect(app.shows("id:project-plus-sheet")).toBe(true);
  expect(app.texts()).toContain("Codex");
  await app.back();
  await app.waitFor("id:project-plus-sheet", { state: "gone", timeout: 5_000 });
  // On, the chip is on the row; it opens the same sheet.
  await app.waitFor("id:project-consult >> id:agent-logo-codex", { timeout: 5_000 });
  await app.press("id:project-consult");
  await app.waitFor("id:consult-sheet", { timeout: 5_000 });
  await app.press("id:consult-switch");
  await app.waitUntil(() => app.texts().includes("consult:off:codex/-/high"), { timeout: 10_000 });
  // The chip goes; the sheet it opened stays.
  await app.waitFor("id:project-consult", { state: "gone", timeout: 5_000 });
  expect(app.shows("id:consult-sheet")).toBe(true);
  expect(app.shows("id:consult-member-0")).toBe(true);
});

test("the clip's row in the + puts the sheet away and asks for files", async () => {
  const app = await project();
  app.onPick(() => null);
  await app.press("id:project-plus");
  await app.waitFor("id:project-plus-attach", { timeout: 5_000 });
  await app.press("id:project-plus-attach");
  await app.waitFor("id:project-plus-sheet", { state: "gone", timeout: 5_000 });
  // `nsh.json` may leave the picker out (see chat-composer-2-files): then the press asks nothing.
  if (app.picks().length > 0) expect(app.picks()[0]?.kind).toBe("files");
});

test("on a phone a Bot's direct has the + too: the clip and the Bot's model, whose sheet goes over it", async () => {
  const app = await openStory("chat-composer-2", PHONE);
  await app.waitFor("id:composer-input", { timeout: 15_000 });
  await app.waitFor("id:composer-plus", { timeout: 10_000 });
  expect(app.shows("id:bot-tune")).toBe(false);
  expect(app.shows("id:attach-button")).toBe(false);
  await app.press("id:composer-plus");
  await app.waitFor("id:composer-plus-sheet", { timeout: 5_000 });
  expect(app.shows("id:composer-plus-attach")).toBe(true);
  await app.press("id:composer-plus-tune");
  await app.waitFor("id:tune-sheet", { timeout: 5_000 });
  await app.back();
  await app.waitFor("id:tune-sheet", { state: "gone", timeout: 5_000 });
  expect(app.shows("id:composer-plus-sheet")).toBe(true);
  await app.back();
  await app.waitFor("id:composer-plus-sheet", { state: "gone", timeout: 5_000 });
  // A group has no model on its row: the clip stays itself, no +.
  await app.press("id:story-group");
  await app.waitUntil(() => app.texts().includes("session:group"));
  await app.waitFor("id:attach-button", { timeout: 5_000 });
  expect(app.shows("id:composer-plus")).toBe(false);
});

test("on a phone a project session has ✨ in place of empty Send; picking a suggestion fills the draft and brings Send back", async () => {
  const app = await project();
  await app.waitFor("id:suggest-button", { timeout: 5_000 });
  expect(app.shows("id:send-button")).toBe(false);
  await app.press("id:suggest-button");
  await app.waitFor("id:composer-suggestions", { timeout: 5_000 });
  await app.waitFor("text:跑全套测试", { timeout: 5_000 });
  await app.press("text:跑全套测试");
  await app.waitUntil(() => app.texts().includes("跑一遍测试并汇报结果"), { timeout: 5_000 });
  await app.waitFor("id:send-button", { timeout: 5_000 });
  expect(app.shows("id:suggest-button")).toBe(false);
});

const said = (app: { texts(): string[] }): string => app.texts().find((x) => /^(sent:|tune:|answer:|stop)/.test(x)) ?? "";
