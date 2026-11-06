import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
type Item = { id: string; name: string | null; builtin: boolean; revision: number; diff: Record<string, any>; own: { name: string; on: boolean; at: string; then: string; kind: string }[] };
type Probe = { default: string; items: Item[] };

async function openBoard(width = 1100) {
  const app = await openStory("settings-playbooks", { width, height: 900 });
  await app.waitFor("id:settings-playbooks", { timeout: 15_000 });
  await app.waitFor("id:playbook-node-pacing", { timeout: 15_000 });
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

const general = (probe: Probe) => probe.items.find((item) => item.id === "general")!;
const selected = (app: App) => (app.texts().find((t) => t.startsWith("selected:")) ?? "").slice("selected:".length);
const has = (app: App, text: string) => app.texts().includes(text);

async function restore(app: App) {
  await app.press("id:story-cleanup");
  await app.waitFor("text:log:cleaned", { timeout: 15_000 });
}

test("the map has a card per step with what it runs on; the Bot's turn is picked like a step, and each round can add a step of your own", async () => {
  const app = await openBoard();
  for (const round of ["line", "group", "turn", "handed_in", "accepted", "overturned", "compose"]) expect(app.shows(`id:playbook-round-${round}`)).toBe(true);
  expect(app.shows("id:playbook-node-turn")).toBe(true);
  expect(app.texts()).toContain("Bot 自己的模型");
  // The reader runs on a model of its own; a step with numbers says its first.
  expect(app.texts()).toContain("fixture-model");
  expect(app.texts()).toContain("40 跳");
  // A step that always runs has a lock; nothing is changed from its built-in yet.
  expect(app.shows("id:playbook-locked-intake")).toBe(true);
  expect(app.shows("id:playbook-changed-pacing")).toBe(false);
  // Four rounds take a step of your own; the others have no add card.
  for (const hook of ["turn", "handed_in", "accepted", "overturned"]) expect(app.shows(`id:playbook-add-${hook}`)).toBe(true);
  expect(app.shows("id:playbook-add-line")).toBe(false);
  // Picking a card shows its panel.
  expect(selected(app)).toBe("reader");
  await app.press("id:playbook-node-pacing");
  await app.waitFor("id:playbook-step-pacing");
  expect(selected(app)).toBe("pacing");
  await app.press("id:playbook-node-turn");
  await app.waitFor("id:story-turn");
  expect(app.shows("id:playbook-step-pacing")).toBe(false);
  await app.press("id:playbook-node-reader");
  await app.waitFor("id:playbook-step-reader");
  expect(app.texts()).toContain("call:reader");
});

test("a step's switch and numbers save at once as the engine's difference from its built-in; reset puts it back", async () => {
  const app = await openBoard();
  try {
    await app.press("id:playbook-node-pacing");
    await app.waitFor("id:playbook-step-pacing");
    expect(app.shows("id:playbook-reset")).toBe(false);
    // The number commits when the field is left, clamped to its range.
    await app.clear("id:playbook-param-check_in_hops");
    await app.type("id:playbook-param-check_in_hops", "500");
    await app.submit("id:playbook-param-check_in_hops");
    const high = await until(app, (probe) => general(probe).diff.steps?.pacing?.params?.check_in_hops === 200, "the number is clamped and saved");
    expect(general(high).revision).toBeGreaterThan(0);
    await app.waitFor("id:playbook-changed-pacing");
    expect(app.texts()).toContain("200 跳");
    expect(app.shows("id:playbook-reset")).toBe(true);
    // The built-in's value is said beside it.
    expect(app.texts().some((t) => t.includes("40"))).toBe(true);
    // Not a number: the field goes back to what it was.
    await app.clear("id:playbook-param-check_in_hops");
    await app.type("id:playbook-param-check_in_hops", "abc");
    await app.submit("id:playbook-param-check_in_hops");
    await app.waitUntil(() => app.value("id:playbook-param-check_in_hops") === "200");

    await app.press("id:playbook-switch");
    await until(app, (probe) => general(probe).diff.steps?.pacing?.on === false, "pacing is off");
    await app.waitFor("id:playbook-step-pacing");
    expect(has(app, "关")).toBe(true);
    expect(has(app, "已关")).toBe(true);

    await app.press("id:playbook-reset");
    const back = await until(app, (probe) => general(probe).diff.steps?.pacing === undefined, "pacing is back to its built-in");
    expect(general(back).diff.steps?.pacing).toBeUndefined();
    await app.waitFor("id:playbook-reset", { state: "gone", timeout: 15_000 });
    expect(app.shows("id:playbook-changed-pacing")).toBe(false);
  } finally {
    await restore(app);
  }
});

test("a step that stands on another says so when that one is off, and a step another cannot do without has no switch", async () => {
  const app = await openBoard();
  try {
    // The reader cannot be off while jobs run.
    await app.press("id:playbook-node-reader");
    await app.waitFor("id:playbook-held-on");
    expect(app.shows("id:playbook-switch")).toBe(false);
    // Jobs says what stops with it.
    await app.press("id:playbook-node-jobs");
    await app.waitFor("id:playbook-also-stops");
    await app.press("id:playbook-switch");
    await until(app, (probe) => general(probe).diff.steps?.jobs?.on === false, "jobs are off");
    await app.press("id:playbook-node-settle");
    await app.waitFor("id:playbook-stopped-by");
    expect(app.shows("id:playbook-switch")).toBe(false);
    // The map shows it dim and off.
    expect(app.texts().filter((t) => t === "已关").length).toBeGreaterThan(1);
    // Switching jobs on again brings them back.
    await app.press("id:playbook-node-jobs");
    await app.press("id:playbook-switch");
    await until(app, (probe) => general(probe).diff.steps?.jobs?.on !== false, "jobs are on");
    await app.press("id:playbook-node-settle");
    await app.waitFor("id:playbook-switch");
  } finally {
    await restore(app);
  }
});

test("the Bot's turn takes a System section of its own, restored to the built-in, and offers its tools by group", async () => {
  const app = await openBoard();
  try {
    await app.press("id:playbook-node-turn");
    await app.waitFor("id:engine-system-write");
    expect(app.shows("id:engine-system-restore")).toBe(false);
    await app.press("id:engine-system-write");
    await app.waitFor("id:engine-system", { timeout: 8000 });
    // The built-in text is the start; Save needs some text.
    await app.waitUntil(() => (app.value("id:engine-system") ?? "").length > 20, { timeout: 8000 });
    await app.type("id:engine-system", "\n只在这个引擎里加的一行。");
    await app.press("id:engine-system-save");
    const saved = await until(app, (probe) => typeof general(probe).diff.system?.zh === "string", "the System section is saved");
    expect(general(saved).diff.system.zh).toContain("只在这个引擎里加的一行。");
    await app.waitFor("id:engine-system-restore");
    // Edit, then give it up.
    await app.press("id:engine-system-write");
    await app.waitFor("id:engine-system-cancel");
    await app.press("id:engine-system-cancel");
    await app.waitFor("id:engine-system-write");
    await app.press("id:engine-system-restore");
    await until(app, (probe) => general(probe).diff.system === undefined, "the System section is restored");
    await app.waitFor("id:engine-system-restore", { state: "gone", timeout: 15_000 });

    // A tool group switched off is saved as the engine's own.
    await app.press("id:engine-tool-roster");
    await until(app, (probe) => (general(probe).diff.tools_off ?? []).includes("roster"), "roster is off");
    await app.press("id:engine-tool-roster");
    await until(app, (probe) => general(probe).diff.tools_off === undefined, "roster is on again");
  } finally {
    await restore(app);
  }
});

test("a step of your own starts from a template or a blank, is checked before it is sent, saved, switched, tried and deleted", async () => {
  const app = await openBoard();
  try {
    // The add card's menu offers the round's templates and a blank step.
    await app.press("id:playbook-add-turn");
    await app.waitFor("id:playbook-add-menu");
    expect(app.shows("id:playbook-template-tests")).toBe(true);
    expect(app.shows("id:playbook-template-env")).toBe(true);
    expect(app.shows("id:playbook-template-video")).toBe(false);
    await app.press("id:playbook-template-blank");
    await app.waitFor("id:playbook-add-menu", { state: "gone", timeout: 15_000 });
    const draft = selected(app);
    expect(draft.startsWith("u_")).toBe(true);
    await app.waitFor(`id:custom-step-${draft}`);
    expect(app.texts().some((t) => t.includes("还没存"))).toBe(true);
    expect(app.shows("id:custom-delete")).toBe(false);
    expect(app.shows("id:custom-cancel")).toBe(true);
    // A draft is not saved, and a blank command is turned back before it is sent.
    await app.press("id:custom-save");
    await app.waitFor("id:custom-error");
    expect(app.texts()).toContain("命令还没写。");
    await app.type("id:custom-command", "echo hi");
    await app.clear("id:custom-name");
    await app.type("id:custom-name", "打个招呼");
    await app.press("id:custom-save");
    const saved = await until(app, (probe) => general(probe).own.length === 1, "the step is saved");
    expect(general(saved).own[0]).toMatchObject({ name: "打个招呼", on: false, kind: "command", at: "before_effect" });
    await app.waitFor(`id:playbook-node-${draft}`);
    expect(app.texts()).toContain("你的");
    // It starts switched off, and says so on its card; the switch saves at once.
    expect(app.texts()).toContain("已关，不跑");
    await app.waitFor("id:custom-delete");
    await app.press("id:custom-switch");
    await until(app, (probe) => general(probe).own[0]?.on === true, "the step is on");
    expect(app.texts().some((t) => t.includes("调用之前 · 不过就拒掉"))).toBe(true);
    expect(app.shows("id:custom-before-note")).toBe(true);

    // Another moment takes the call's tools and the note away, and the answer a "no" cannot have; back again.
    await app.press("id:custom-moment");
    await app.press("text:一轮收尾时");
    await app.waitFor("id:custom-before-note", { state: "gone", timeout: 15_000 });
    expect(app.shows("id:custom-tool-shell")).toBe(false);
    expect(app.shows("id:custom-sample-reply")).toBe(true);
    await app.press("id:custom-moment");
    await app.press("text:调用之前");
    await app.waitFor("id:custom-before-note");

    // Judging by a rule, with the sample's path.
    await app.press("id:custom-kind-rule");
    await app.waitFor("id:custom-tool-shell");
    await app.press("id:custom-tool-write_file");
    await app.type("id:custom-paths", "**/.env");
    await app.press("id:custom-then");
    await app.press("text:附给 Bot");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("放行，把输出附在")));
    await app.press("id:custom-then");
    await app.press("text:拒掉这次调用");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("这次调用不执行")));
    await app.press("id:custom-try");
    await app.waitUntil(() => app.texts().some((t) => /^(过了|没过|没判断成|命令在工作区外)/.test(t)), { timeout: 10_000 });
    await app.press("id:custom-save");
    const rule = await until(app, (probe) => general(probe).own[0]?.kind === "rule", "the step is a rule");
    expect(general(rule).own[0]).toMatchObject({ at: "before_effect", then: "refuse", name: "打个招呼" });
    await app.waitFor("id:custom-delete");

    // Delete asks first, then takes out that one step and picks another node.
    await app.press("id:custom-delete");
    await app.waitFor("id:danger-confirm");
    await app.press("id:danger-cancel");
    await app.waitFor("id:danger-confirm", { state: "gone", timeout: 15_000 });
    await app.press("id:custom-delete");
    await app.waitFor("id:danger-confirm");
    await app.press("id:danger-confirm");
    await until(app, (probe) => general(probe).own.length === 0, "the step is deleted");
    await app.waitFor(`id:playbook-node-${draft}`, { state: "gone", timeout: 15_000 });
    expect(selected(app)).toBe("turn");
  } finally {
    await restore(app);
  }
});

test("a draft can be given up, and the add menu on a phone is a sheet", async () => {
  const app = await openBoard();
  try {
    await app.press("id:playbook-add-handed_in");
    await app.waitFor("id:playbook-template-video");
    await app.press("id:playbook-template-video");
    const draft = selected(app);
    await app.waitFor(`id:custom-step-${draft}`);
    await app.press("id:custom-cancel");
    await app.waitFor(`id:custom-step-${draft}`, { state: "gone", timeout: 15_000 });
    expect(app.shows(`id:playbook-node-${draft}`)).toBe(false);
    expect(selected(app)).toBe("checks");
    await app.setViewport(420, 900);
    await app.wait(300);
    await app.press("id:story-show-narrow");
    await app.waitFor("id:playbook-add-accepted");
    await app.press("id:playbook-add-accepted");
    await app.waitFor("id:playbook-add-menu");
    expect(app.shows("id:playbook-template-blank")).toBe(true);
    await app.press("id:playbook-template-blank");
    await app.waitFor("id:playbook-add-menu", { state: "gone", timeout: 15_000 });
    expect(selected(app).startsWith("u_")).toBe(true);
  } finally {
    await restore(app);
  }
});
