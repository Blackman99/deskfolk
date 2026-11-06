import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
type Probe = { providers: string[]; builtin: Record<string, unknown> | null; defaultPlaybook: string | null; playbooks: { id: string; name: string | null; rev: number }[] };

async function openPart(part: string, width = 1100, height = 900) {
  const app = await openStory("settings-routing", { width, height });
  await app.waitFor("id:settings-routing", { timeout: 15_000 });
  await app.press(`id:story-show-${part}`);
  return app;
}

/** What the daemon holds, through the story's read button: pressed again until `check` holds. */
async function until(app: App, check: (probe: Probe) => boolean, what: string): Promise<Probe> {
  for (let i = 0; i < 40; i++) {
    await app.press("id:story-read");
    await app.wait(150);
    const text = app.texts().find((t) => t.startsWith("probe:{"));
    if (text) {
      const probe = JSON.parse(text.slice("probe:".length)) as Probe;
      if (check(probe)) return probe;
    }
  }
  throw new Error(`never became true: ${what}`);
}

const restore = async (app: App) => {
  await app.press("id:story-cleanup");
  await app.waitFor("text:log:cleaned", { timeout: 15_000 });
};
const has = (app: App, text: string) => app.texts().some((t) => t.includes(text));

test("Roles on a wide window: the engines down the left, the map, and the picked call's model and prompts beside it", async () => {
  const app = await openPart("roles");
  await app.waitFor("id:playbook-node-reader", { timeout: 15_000 });
  expect(app.shows("id:routing-tab")).toBe(true);
  expect(app.shows("id:playbook-list")).toBe(true);
  expect(app.shows("id:playbook-row-general")).toBe(true);
  // The built-in engine says what it is for over the map, then the page's intro.
  expect(app.shows("id:routing-hint")).toBe(true);
  expect(app.shows("id:routing-intro")).toBe(true);
  // Reading is picked first: its model, and its two prompts.
  expect(app.shows("id:routing-detail-reader")).toBe(true);
  expect(app.shows("id:routing-part-model")).toBe(true);
  expect(app.shows("id:side-model-reader")).toBe(true);
  expect(app.shows("id:routing-part-prompts")).toBe(true);
  expect(app.shows("id:prompt-call.read_user_line")).toBe(true);
  expect(app.shows("id:prompt-call.read_bot_line")).toBe(true);
  // Another step: its own panel with its call.
  await app.press("id:playbook-node-settle");
  await app.waitFor("id:playbook-step-settle");
  expect(app.shows("id:routing-detail-organizer")).toBe(true);
  expect(app.shows("id:routing-detail-reader")).toBe(false);
});

test("the Bot's turn has its prompts on Prompts (the link opens settings), the model ladder, and its engine's System section", async () => {
  const app = await openPart("roles");
  try {
    await app.waitFor("id:playbook-node-turn", { timeout: 15_000 });
    await app.press("id:playbook-node-turn");
    await app.waitFor("id:routing-detail-turn");
    expect(app.shows("id:routing-part-ladder")).toBe(true);
    expect(app.shows("id:routing-link-prompts")).toBe(true);
    expect(app.shows("id:engine-system-write")).toBe(true);
    expect(has(app, "settings:closed")).toBe(true);
    await app.press("id:routing-link-prompts");
    await app.waitUntil(() => has(app, "settings:open"));
  } finally {
    await restore(app);
  }
});

test("a call's model is picked from what an endpoint lists and saved; the one that follows the default is picked back", async () => {
  const app = await openPart("node");
  try {
    await app.press("id:story-add-provider");
    await app.waitFor("text:log:provider:added", { timeout: 15_000 });
    await app.waitFor("id:side-model-picker");
    await app.press("id:side-model-picker");
    await app.waitFor("id:model-picker-panel");
    await app.press("text:T-routing");
    await app.press("text:t-two");
    await until(app, (probe) => JSON.stringify(probe.builtin?.reader ?? null).includes("t-two"), "the reader runs on t-two");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("reader:{") && t.includes("t-two")));
    await app.press("id:side-model-picker");
    await app.waitFor("id:model-picker-panel");
    await app.press("text:跟随默认模型（fixture）");
    await until(app, (probe) => probe.builtin?.reader === null, "the reader follows the default again");
  } finally {
    await restore(app);
  }
});

test("a call with no prompt to show says so; its prompts open from the row", async () => {
  const app = await openPart("node");
  expect(app.shows("id:routing-detail-reader")).toBe(true);
  expect(app.texts()).toContain("提示词");
  expect(app.shows("id:routing-part-prompts")).toBe(true);
});

test("the call editor opens a prompt in the prompt editor, over the window, and closing it saves and comes back", async () => {
  const app = await openPart("call");
  await app.waitFor("id:call-editor-reader", { timeout: 15_000 });
  await app.waitFor("id:prompt-call.read_user_line", { timeout: 15_000 });
  await app.press("id:prompt-call.read_user_line");
  await app.waitFor("id:prompt-editor-page", { timeout: 15_000 });
  await app.press("id:modal-close");
  await app.waitFor("id:prompt-editor-page", { state: "gone", timeout: 15_000 });
  expect(app.shows("id:call-editor-reader")).toBe(true);
});

test("on a phone Roles is a page: the map, a call opened a level deeper under its name, Back one level at a time", async () => {
  const app = await openPart("page", 400, 800);
  await app.waitFor("id:playbook-node-reader", { timeout: 15_000 });
  expect(app.shows("id:roles-page-back")).toBe(true);
  expect(app.shows("id:playbook-list")).toBe(false);
  expect(app.shows("id:playbook-chip-general")).toBe(true);
  expect(app.shows("id:routing-detail-reader")).toBe(false);
  await app.press("id:playbook-node-reader");
  await app.waitFor("id:routing-detail-reader");
  expect(app.shows("id:playbook-node-settle")).toBe(false);
  expect(app.texts()).toContain("读句");
  // Back goes to the map, not out of the page.
  await app.press("id:roles-page-back");
  await app.waitFor("id:playbook-node-settle");
  expect(app.texts().some((t) => t === "roles-back:0")).toBe(true);
  // Back from the map leaves the page.
  await app.press("id:roles-page-back");
  await app.waitUntil(() => app.texts().includes("roles-back:1"));
});

test("on a phone the prompt editor is closed by Back before the call's page it was opened from", async () => {
  const app = await openPart("page", 400, 800);
  await app.waitFor("id:playbook-node-reader", { timeout: 15_000 });
  await app.press("id:playbook-node-reader");
  await app.waitFor("id:prompt-call.read_user_line", { timeout: 15_000 });
  await app.press("id:prompt-call.read_user_line");
  await app.waitFor("id:prompt-editor-page", { timeout: 15_000 });
  await app.press("id:modal-back");
  await app.waitFor("id:prompt-editor-page", { state: "gone", timeout: 15_000 });
  // The call's page is still open under it.
  expect(app.shows("id:routing-detail-reader")).toBe(true);
  await app.press("id:roles-page-back");
  await app.waitFor("id:playbook-node-settle");
});

test("a step of your own is written, saved and deleted; deleting it lands on its round, whose step panel was already gone", async () => {
  const app = await openPart("roles");
  try {
    await app.waitFor("id:playbook-add-turn", { timeout: 15_000 });
    await app.press("id:playbook-add-turn");
    await app.waitFor("id:playbook-add-menu");
    await app.press("id:playbook-template-blank");
    await app.waitFor("id:playbook-add-menu", { state: "gone", timeout: 15_000 });
    await app.waitFor("id:custom-save");
    await app.type("id:custom-command", "echo hi");
    await app.clear("id:custom-name");
    await app.type("id:custom-name", "打个招呼");
    await app.press("id:custom-save");
    await until(app, (probe) => probe.playbooks.length > 0, "read");
    await app.waitFor("id:custom-delete", { timeout: 15_000 });
    await app.press("id:custom-delete");
    await app.waitFor("id:danger-confirm");
    await app.press("id:danger-confirm");
    // The step's panel gives way to its round's: the Bot's turn.
    await app.waitFor("id:routing-detail-turn", { timeout: 15_000 });
    expect(app.shows("id:custom-delete")).toBe(false);
  } finally {
    await restore(app);
  }
});

test("a new engine's history opens beside the map in the picked step's place, and picking a step goes back", async () => {
  const app = await openPart("roles");
  await app.waitFor("id:playbook-more-general", { timeout: 15_000 });
  await app.press("id:playbook-more-general");
  await app.waitFor("id:playbook-action-history");
  await app.press("id:playbook-action-history");
  await app.waitFor("id:playbook-history-close", { timeout: 15_000 });
  expect(app.shows("id:routing-detail-reader")).toBe(false);
  await app.press("id:playbook-node-settle");
  await app.waitFor("id:playbook-step-settle");
  expect(app.shows("id:playbook-history-close")).toBe(false);
});

test("the model ladder reads weaker to stronger, each rung coming off by its ×, saved in your order", async () => {
  const app = await openPart("ladder");
  await app.waitFor("id:model-ladder", { timeout: 15_000 });
  await app.waitFor("id:ladder-rung-light");
  expect(app.shows("id:ladder-scale")).toBe(true);
  expect(app.texts()).toContain("light");
  // Two endpoints: the rung says whose model it is.
  expect(app.shows("id:ladder-provider-light")).toBe(true);
  expect(app.shows("id:ladder-add")).toBe(true);
  await app.press("id:ladder-remove-mid");
  await app.waitUntil(() => app.texts().includes('ladder:["light","other"]'));
  expect(app.shows("id:ladder-rung-mid")).toBe(false);
});

test("a rung moves by its grip's arrow keys, and a rung let go where it started saves nothing", async () => {
  const app = await openPart("ladder");
  await app.waitFor("id:ladder-grip-light", { timeout: 15_000 });
  await app.press("id:ladder-grip-light");
  await app.keyboard.press("down");
  await app.waitUntil(() => app.texts().includes('ladder:["mid","light","other"]'));
  await app.keyboard.press("up");
  await app.waitUntil(() => app.texts().includes('ladder:["light","mid","other"]'));
  // Already the weakest: up does nothing.
  await app.keyboard.press("up");
  expect(app.texts().includes('ladder:["light","mid","other"]')).toBe(true);
});

test("a rung dragged by its grip lands where it is let go", async () => {
  const app = await openPart("ladder");
  await app.waitFor("id:ladder-grip-light", { timeout: 15_000 });
  await app.drag("id:ladder-grip-light", { y: 130 });
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("ladder:[") && t.includes("light") && t !== 'ladder:["light","mid","other"]' && t !== "ladder:[]"), { timeout: 10_000 });
  expect(app.texts().some((t) => t === 'ladder:["mid","other","light"]')).toBe(true);
});

test("a model is added at the strong end from what is listed and not on the ladder yet", async () => {
  const app = await openPart("ladder");
  await app.waitFor("id:ladder-add", { timeout: 15_000 });
  await app.press("id:ladder-add");
  await app.waitFor("id:model-picker-panel");
  await app.press("text:heavy");
  await app.waitUntil(() => app.texts().includes('ladder:["light","mid","other","heavy"]'));
  expect(app.shows("id:ladder-rung-heavy")).toBe(true);
});
