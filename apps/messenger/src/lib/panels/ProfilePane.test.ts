import { expect, test } from "bun:test";
import { AGENT_KINDS, BOT_RUNNERS, type BotRunner } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aProvider, aSkill, fakeRuntime } from "../test-fixtures.ts";
import { settle } from "../test-async.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import ProfilePane from "./ProfilePane.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(over: {
  bot?: ReturnType<typeof aBot>;
  skills?: ReturnType<typeof aSkill>[];
  initialTab?: "basics" | "skills" | "memory" | "actions";
  /** The workbench opens a conversation's settings beside it and leaves the drawer's `profileBotId` unset. */
  onWorkbench?: boolean;
} = {}) {
  const bot = over.bot ?? aBot();
  const runtime = fakeRuntime({ bots: [bot], skills: over.skills ?? [] });
  if (!over.onWorkbench) runtime.profileBotId = bot.id;
  const view = render(ProfilePane, {
    runtime,
    bot,
    t,
    selectedKind: "you-bot",
    profileFailed: false,
    initialTab: over.initialTab ?? "basics",
    openDangerConfirm: () => {},
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  });
  return { ...view, runtime, bot };
}

test("fills the draft from the Bot it is given", () => {
  const { host, close } = open();
  expect((host.querySelector("#profile-name") as HTMLInputElement).value).toBe("Researcher");
  expect((host.querySelector("#profile-duties") as HTMLTextAreaElement).value).toBe("收集资料");
  close();
});

test("typing saves itself a moment later, once", async () => {
  const { host, runtime, close } = open();
  fill(host.querySelector("#profile-name"), "Researcher 2");
  expect(runtime.calls.filter((c) => c.name === "patchBot")).toHaveLength(0);
  await sleep(750);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { name: string }).name).toBe("Researcher 2");
  close();
});

/**
 * The shell used to flush a pending autosave when the drawer closed. That job is now this pane's
 * unmount teardown, and this is the test that says so.
 */
test("closing the pane before the debounce still sends the edit", async () => {
  const { host, runtime, close } = open();
  fill(host.querySelector("#profile-name"), "只打了一半");
  close();
  await sleep(50);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { name: string }).name).toBe("只打了一半");
});

test("a save the server refuses says so beside the title, and the next edit tries again", async () => {
  const bot = aBot();
  let asked = 0;
  const runtime = fakeRuntime({ bots: [bot], skills: [] }, { patchBot: async () => ((asked += 1), { status: 500, message: "boom" }) });
  runtime.profileBotId = bot.id;
  const { host, close } = render(ProfilePane, {
    runtime, bot, t, selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
    openDangerConfirm: () => {}, clearDanger: () => {}, onDeleteBot: () => {}, onClearHistory: () => {},
  });
  fill(host.querySelector("#profile-name"), "Researcher 2");
  await sleep(750);
  const label = host.querySelector(".profile-save-state");
  expect(label?.textContent?.trim()).toBe(t.sidebar.saveFailed);
  expect(label?.classList.contains("is-error")).toBe(true);
  fill(host.querySelector("#profile-name"), "Researcher 3");
  expect(host.querySelector(".profile-save-state")?.classList.contains("is-error")).toBe(false);
  await sleep(750);
  expect(asked).toBe(2);
  close();
});

/** Two endpoints: gpt-6-astra offers none/low/high, grok-4.7 only high and up; the second endpoint lists one more. */
const endpoints = () => [
  aProvider({
    id: "p-cpa", name: "My CPA", models: ["gpt-6-astra", "grok-4.7"],
    model_catalog: [
      { name: "gpt-6-astra", price: 1, thinking_levels: ["none", "low", "high"], strengths: [] },
      { name: "grok-4.7", price: 1, thinking_levels: ["high", "xhigh"], strengths: [] },
    ],
  }),
  aProvider({ id: "p-two", name: "Second", base_url: "https://two.example.com/v1", models: ["qwen-4"], model_catalog: [] }),
];

function openOnEndpoints(bot: ReturnType<typeof aBot>) {
  const runtime = fakeRuntime({ bots: [bot], providers: endpoints() });
  const view = render(ProfilePane, {
    runtime, bot, t, selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
    openDangerConfirm: () => {}, clearDanger: () => {}, onDeleteBot: () => {}, onClearHistory: () => {},
  });
  return { ...view, runtime };
}

const rowByValue = (host: HTMLElement, value: string) => host.querySelector<HTMLElement>(`.mp-row[data-value="${value}"]`);
const rowLabels = (host: HTMLElement) => [...host.querySelectorAll(".mp-row .mp-row-label")].map(words);
const chips = (host: HTMLElement) => [...host.querySelectorAll('[role=radiogroup][aria-labelledby="profile-thinking-label"] button')].map((el) => el.textContent?.trim());

test("on the workbench, where the drawer's profileBotId stays unset, picking a model still saves it", async () => {
  const bot = aBot();
  const { host, runtime, close } = openOnEndpoints(bot);
  click(host.querySelector("#profile-model"));
  await settle();
  click(rowByValue(host, "p-cpa::gpt-6-astra"));
  await sleep(200);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect(saves[0]!.args[0]).toBe(bot.id);
  // The model and its thinking level are pinned together: the first level the app prefers that it offers.
  expect(saves[0]!.args[1]).toMatchObject({ model: "gpt-6-astra", provider_id: "p-cpa", thinking_level: "low" });
  close();
});

test("the model picker has automatic on top and a source for every endpoint; picking a model of the second one saves its endpoint", async () => {
  const { host, runtime, close } = openOnEndpoints(aBot());
  expect(words(host.querySelector("#profile-model"))).toBe(t.sidebar.botModelDefault);
  click(host.querySelector("#profile-model"));
  await settle();
  expect([...host.querySelectorAll(".mp-source .mp-source-label")].map(words)).toEqual(["My CPA", "Second"]);
  expect(rowLabels(host)).toEqual([t.sidebar.botModelDefault, "gpt-6-astra", "grok-4.7"]);
  host.querySelector(".mp-source[data-source-key='endpoint:p-two']")?.dispatchEvent(new MouseEvent("mouseenter"));
  await settle();
  expect(rowLabels(host)).toEqual([t.sidebar.botModelDefault, "qwen-4"]);
  click(rowByValue(host, "p-two::qwen-4"));
  await sleep(200);
  expect(lastSave(runtime)).toMatchObject({ model: "qwen-4", provider_id: "p-two" });
  close();
});

test("changing the model keeps the thinking level it offers and moves to its default otherwise; automatic clears both", async () => {
  const pinned = { ...aBot(), model: "gpt-6-astra", provider_id: "p-cpa", thinking_level: "high" as const };
  const same = openOnEndpoints(pinned);
  expect(chips(same.host)).toEqual(["不思考", "低", "高"]);
  click(same.host.querySelector("#profile-model"));
  await settle();
  click(rowByValue(same.host, "p-cpa::grok-4.7"));
  // The chips already follow the new model, before the save goes out.
  expect(chips(same.host)).toEqual(["高", "极高"]);
  await sleep(200);
  expect(lastSave(same.runtime)).toMatchObject({ model: "grok-4.7", provider_id: "p-cpa", thinking_level: "high" });
  same.close();

  const low = openOnEndpoints({ ...pinned, thinking_level: "low" as const });
  click(low.host.querySelector("#profile-model"));
  await settle();
  click(rowByValue(low.host, "p-cpa::grok-4.7"));
  await sleep(200);
  expect(lastSave(low.runtime)).toMatchObject({ model: "grok-4.7", thinking_level: "high" });
  low.close();

  const auto = openOnEndpoints(pinned);
  click(auto.host.querySelector("#profile-model"));
  await settle();
  click(rowByValue(auto.host, ""));
  expect(auto.host.querySelector("#profile-thinking-label")).toBeNull();
  await sleep(200);
  expect(lastSave(auto.runtime)).toMatchObject({ model: null, provider_id: null, thinking_level: null });
  auto.close();
});

test("on the workbench, adding a skill and archiving act on the Bot the pane shows", async () => {
  const skills = open({ initialTab: "skills", onWorkbench: true });
  click(skills.host.querySelector(".skill-head-add-btn"));
  fill(skills.host.querySelector("#skill-name"), "查证");
  fill(skills.host.querySelector("#skill-description"), "核对出处");
  fill(skills.host.querySelector("#skill-body"), "先找原文");
  click(buttonByText(skills.host, t.sidebar.skillSave));
  await sleep(10);
  const created = skills.runtime.calls.filter((c) => c.name === "createSkill");
  expect(created).toHaveLength(1);
  expect((created[0]!.args[0] as { bot_id: string }).bot_id).toBe(skills.bot.id);
  skills.close();

  const actions = open({ initialTab: "actions", onWorkbench: true });
  click(buttonByText(actions.host, t.sidebar.archive));
  await sleep(10);
  expect(actions.runtime.calls.filter((c) => c.name === "archiveBot").map((c) => c.args[0])).toEqual([actions.bot.id]);
  actions.close();
});

test("an unchanged draft sends nothing", async () => {
  const { host, runtime, close } = open();
  fill(host.querySelector("#profile-name"), "Researcher");
  await sleep(750);
  expect(runtime.calls.filter((c) => c.name === "patchBot")).toHaveLength(0);
  close();
});

test("avatar and persona sit in one basics card", () => {
  const { host, close } = open();
  expect(host.textContent).toContain(t.detail.botBasics);
  expect(host.querySelectorAll(".panel-card-title")[0]?.textContent).toBe(t.detail.botBasics);
  expect(host.querySelector("#profile-name")).not.toBeNull();
  expect(host.querySelector(".avatar-editor")).not.toBeNull();
  close();
});

test("archive is a session action; clear history and delete sit in the danger zone", () => {
  const { host, close } = open({ initialTab: "actions" });
  const titles = [...host.querySelectorAll(".panel-card-title")].map((el) => el.textContent);
  expect(titles).toContain(t.detail.sessionActions);
  expect(titles).toContain(t.detail.dangerZone);
  expect(host.querySelector(".danger-zone-card")?.textContent).toContain(t.detail.clearHistory);
  expect(host.querySelector(".danger-zone-card")?.textContent).toContain(t.sidebar.delete);
  expect(host.querySelector(".danger-zone-card")?.textContent).not.toContain(t.sidebar.archive);
  close();
});

test("opening a Bot from a group keeps archive and delete, not clear history", () => {
  const bot = aBot();
  const runtime = fakeRuntime({ bots: [bot] });
  runtime.profileBotId = bot.id;
  const { host, close } = render(ProfilePane, {
    runtime,
    bot,
    t,
    selectedKind: "group",
    profileFailed: false,
    initialTab: "actions",
    openDangerConfirm: () => {},
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  });
  expect(host.querySelector(".danger-zone-card")?.textContent).not.toContain(t.detail.clearHistory);
  expect(host.querySelector(".danger-zone-card")?.textContent).toContain(t.sidebar.delete);
  expect(host.textContent).toContain(t.sidebar.archive);
  close();
});

test("archiving and restoring go through the runtime", async () => {
  const archived = aBot({ archived_at: "2026-09-19T00:00:00.000Z" });
  const live = open({ initialTab: "actions" });
  click(buttonByText(live.host, t.sidebar.archive));
  expect(live.runtime.calls.some((c) => c.name === "archiveBot")).toBe(true);
  live.close();

  const gone = open({ bot: archived, initialTab: "actions" });
  click(buttonByText(gone.host, t.sidebar.restore));
  expect(gone.runtime.calls.some((c) => c.name === "restoreBot")).toBe(true);
  gone.close();
});

test("deleting a skill asks the shell for a confirm that knows which skill", async () => {
  const skill = aSkill({ id: "skill-9", name: "查证" });
  const bot = aBot();
  const runtime = fakeRuntime({ bots: [bot], skills: [skill] });
  runtime.profileBotId = bot.id;
  let asked: { kind: string; run: (isCurrent: () => boolean) => Promise<void> } | null = null;
  const { host, close } = render(ProfilePane, {
    runtime,
    bot,
    t,
    selectedKind: "you-bot",
    profileFailed: false,
    initialTab: "skills",
    openDangerConfirm: (kind: "skill", run: (isCurrent: () => boolean) => Promise<void>) => (asked = { kind, run }),
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  });
  click(host.querySelector(".skill-open"));
  click(buttonByText(host, t.sidebar.skillDelete));
  expect(asked).not.toBeNull();
  expect(asked!.kind).toBe("skill");
  await asked!.run(() => true);
  expect(runtime.calls.find((c) => c.name === "deleteSkill")?.args).toEqual(["skill-9"]);
  close();
});

test('a superseded skill delete cannot clear a newer confirmation or editor', async () => {
  const bot = aBot(); const skill = aSkill();
  let release!: (value: null) => void;
  const runtime = fakeRuntime({ bots: [bot], skills: [skill] }, { deleteSkill: () => new Promise<null>((resolve) => { release = resolve; }) });
  runtime.profileBotId = bot.id;
  let run!: (isCurrent: () => boolean) => Promise<void>;
  let cleared = 0;
  const { host, close } = render(ProfilePane, { runtime, bot, t, selectedKind: 'you-bot', profileFailed: false,
    initialTab: 'skills',
    openDangerConfirm: (_kind, action) => { run = action; }, clearDanger: () => { cleared++; }, onDeleteBot: () => {}, onClearHistory: () => {} });
  click(host.querySelector('.skill-open')); click(buttonByText(host, t.sidebar.skillDelete));
  let current = true;
  const pending = run(() => current);
  current = false;
  release(null); await pending;
  expect(cleared).toBe(0);
  expect(host.querySelector('.skill-modal')).not.toBeNull(); close();
});

test("head add button opens the skill modal, cancel button closes it", () => {
  const { host, close } = open({ initialTab: "skills" });
  expect(host.querySelector(".skill-modal")).toBeNull();
  click(host.querySelector(".skill-head-add-btn"));
  expect(host.querySelector(".skill-modal")).not.toBeNull();
  expect(host.querySelector("#skill-modal-title")?.textContent?.trim()).toBe(t.sidebar.skillAdd);

  click(buttonByText(host, t.sidebar.skillCancel));
  expect(host.querySelector(".skill-modal")).toBeNull();
  close();
});

test("row edit button opens the modal with skill data; row delete button invokes danger confirm", async () => {
  const skill = aSkill({ id: "skill-1", name: "代码审查", description: "审查PR变更" });
  const bot = aBot();
  const runtime = fakeRuntime({ bots: [bot], skills: [skill] });
  runtime.profileBotId = bot.id;
  let asked: { kind: string; run: (isCurrent: () => boolean) => Promise<void> } | null = null;
  const { host, close } = render(ProfilePane, {
    runtime,
    bot,
    t,
    selectedKind: "you-bot",
    profileFailed: false,
    initialTab: "skills",
    openDangerConfirm: (kind: "skill", run: (isCurrent: () => boolean) => Promise<void>) => (asked = { kind, run }),
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  });

  // Check row action buttons exist and are visible
  const editBtn = host.querySelector(".skill-action-btn.edit");
  const deleteBtn = host.querySelector(".skill-action-btn.delete");
  expect(editBtn).not.toBeNull();
  expect(deleteBtn).not.toBeNull();

  // Click edit button -> opens modal with prefilled data
  click(editBtn);
  expect(host.querySelector(".skill-modal")).not.toBeNull();
  expect((host.querySelector("#skill-name") as HTMLInputElement).value).toBe("代码审查");
  expect((host.querySelector("#skill-description") as HTMLTextAreaElement).value).toBe("审查PR变更");

  // Close modal
  click(buttonByText(host, t.sidebar.skillCancel));
  expect(host.querySelector(".skill-modal")).toBeNull();

  // Click row delete button directly -> opens danger confirm
  click(deleteBtn);
  expect(asked).not.toBeNull();
  expect(asked!.kind).toBe("skill");
  await asked!.run(() => true);
  expect(runtime.calls.find((c) => c.name === "deleteSkill")?.args).toEqual(["skill-1"]);
  close();
});

test("empty state shows guidance and add button when bot has no skills", () => {
  const { host, close } = open({ skills: [], initialTab: "skills" });
  expect(host.querySelector(".skill-empty-card")).not.toBeNull();
  expect(host.querySelector(".skill-empty-text")?.textContent?.trim()).toBe(t.sidebar.skillsEmpty);

  click(host.querySelector(".skill-empty-add-btn"));
  expect(host.querySelector(".skill-modal")).not.toBeNull();
  close();
});

test("renders tabs navigation with all 5 categories and defaults to basics", () => {
  const { host, close } = open();
  const tabs = [...host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")];
  expect(tabs).toHaveLength(5);
  const tabNames = tabs.map((t) => t.querySelector(".tab-name")?.textContent?.trim());
  expect(tabNames).toEqual([
    t.detail.botTabBasics,
    t.detail.botTabSkills,
    t.detail.botTabRoutines,
    t.detail.botTabMemory,
    t.detail.botTabActions,
  ]);
  expect(tabs[0]!.classList.contains("is-active")).toBe(true);
  expect(tabs[1]!.classList.contains("is-active")).toBe(false);
  expect(host.querySelector("#profile-name")).not.toBeNull();
  expect(host.querySelector(".skill-card-body")).toBeNull();
  close();
});

test("clicking tabs switches the active tab and rendered cards", () => {
  const { host, close } = open();
  const tabs = [...host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")];

  // Switch to Skills
  click(tabs[1]);
  expect(tabs[1]!.classList.contains("is-active")).toBe(true);
  expect(tabs[0]!.classList.contains("is-active")).toBe(false);
  expect(host.querySelector("#profile-name")).toBeNull();
  expect(host.querySelector(".skill-card-body")).not.toBeNull();

  // Switch to Routines
  click(tabs[2]);
  expect(tabs[2]!.classList.contains("is-active")).toBe(true);
  expect(host.textContent).toContain(t.detail.botTabRoutines);

  // Switch to Memory
  click(tabs[3]);
  expect(tabs[3]!.classList.contains("is-active")).toBe(true);
  expect(host.textContent).toContain(t.sidebar.memories);

  // Switch to Actions
  click(tabs[4]);
  expect(tabs[4]!.classList.contains("is-active")).toBe(true);
  expect(host.querySelector(".danger-zone-card")).not.toBeNull();

  // Switch back to Basics
  click(tabs[0]);
  expect(tabs[0]!.classList.contains("is-active")).toBe(true);
  expect(host.querySelector("#profile-name")).not.toBeNull();
  close();
});

test("switching tabs flushes pending autosave immediately", () => {
  const { host, runtime, close } = open();
  fill(host.querySelector("#profile-name"), "Instant Save On Switch");
  expect(runtime.calls.filter((c) => c.name === "patchBot")).toHaveLength(0);

  const tabs = [...host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")];
  click(tabs[1]); // switch to skills

  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { name: string }).name).toBe("Instant Save On Switch");
  close();
});

test("validation errors trigger error badge on basics tab", async () => {
  const { host, close } = open();
  const tabs = [...host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")];
  expect(tabs[0]!.querySelector(".tab-badge-error")).toBeNull();

  // Clear name to produce empty-name error
  fill(host.querySelector("#profile-name"), "");
  await sleep(750);

  expect(tabs[0]!.querySelector(".tab-badge-error")).not.toBeNull();
  expect(tabs[0]!.querySelector(".tab-badge-error")?.textContent?.trim()).toBe("!");
  close();
});

test("skills tab shows count badge matching skills count", () => {
  const skills = [
    aSkill({ id: "s1", name: "Skill 1" }),
    aSkill({ id: "s2", name: "Skill 2" }),
  ];
  const { host, close } = open({ skills });
  const tabs = [...host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")];
  const countBadge = tabs[1]!.querySelector(".tab-count");
  expect(countBadge).not.toBeNull();
  expect(countBadge?.textContent?.trim()).toBe("2");
  close();
});

test("mobile toggle switches skill enabled without opening editor", () => {
  const skill = aSkill({ id: "s1", name: "Skill 1", enabled: true });
  const { host, runtime, close } = open({ skills: [skill], initialTab: "skills" });
  const box = host.querySelector(".skill-mobile-toggle input") as HTMLInputElement;
  expect(box).not.toBeNull();
  expect(box.checked).toBe(true);

  box.checked = false;
  box.dispatchEvent(new Event("change", { bubbles: true }));

  const patch = runtime.calls.find((c) => c.name === "patchSkill");
  expect(patch?.args).toEqual(["s1", { enabled: false }]);
  expect(host.querySelector(".skill-modal")).toBeNull();
  close();
});

test("mobile skill delete button inside editor invokes danger confirm", async () => {
  const skill = aSkill({ id: "s1", name: "Skill 1" });
  const bot = aBot();
  const runtime = fakeRuntime({ bots: [bot], skills: [skill] });
  runtime.profileBotId = bot.id;
  let asked: { kind: string; run: (isCurrent: () => boolean) => Promise<void> } | null = null;
  const { host, close } = render(ProfilePane, {
    runtime,
    bot,
    t,
    selectedKind: "you-bot",
    profileFailed: false,
    initialTab: "skills",
    openDangerConfirm: (kind: "skill", run: (isCurrent: () => boolean) => Promise<void>) => (asked = { kind, run }),
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  });

  click(host.querySelector(".skill-open"));
  expect(host.querySelector(".skill-modal")).not.toBeNull();
  const deleteBtn = host.querySelector<HTMLButtonElement>(".skill-page-delete");
  expect(deleteBtn).not.toBeNull();
  click(deleteBtn);
  expect(asked).not.toBeNull();
  expect(asked!.kind).toBe("skill");
  await asked!.run(() => true);
  expect(runtime.calls.find((c) => c.name === "deleteSkill")?.args).toEqual(["s1"]);
  close();
});

test("a pin no endpoint lists any more stays offered, marked, and the rest of the profile still saves", async () => {
  // From engine level 7 a pin outlives its model leaving an endpoint's list (ADR 0048); before, the
  // pane's check refused every edit of a Bot whose pinned model the list no longer named.
  const bot = { ...aBot(), model: "claude-opus-4-6-thinking", provider_id: "p-cpa", thinking_level: "low" as const };
  const runtime = fakeRuntime({ bots: [bot], providers: [aProvider({ id: "p-cpa", name: "My CPA", models: ["gemini-3.8-flash-high"], model_catalog: [] })] });
  runtime.profileBotId = bot.id;
  const { host, close } = render(ProfilePane, {
    runtime, bot, t, selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
    openDangerConfirm: () => {}, clearDanger: () => {}, onDeleteBot: () => {}, onClearHistory: () => {},
  });
  expect(host.textContent).toContain(t.sidebar.botModelUnlistedHint);
  expect(words(host.querySelector("#profile-model"))).toBe(`claude-opus-4-6-thinking ${t.sidebar.botModelUnlisted}`);
  // It is a row of its own above the endpoint's models, so picking another model does not lose it.
  click(host.querySelector("#profile-model"));
  await settle();
  expect(rowLabels(host)).toEqual([t.sidebar.botModelDefault, `claude-opus-4-6-thinking${t.sidebar.botModelUnlisted}`, "gemini-3.8-flash-high"]);
  expect(rowByValue(host, "p-cpa::claude-opus-4-6-thinking")?.classList.contains("is-selected")).toBe(true);
  press(host.querySelector(".mp-search input"), "Escape");
  fill(host.querySelector("#profile-duties"), "按分镜生成镜头");
  await sleep(750);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect(saves[0]!.args[1]).toMatchObject({ model: "claude-opus-4-6-thinking", provider_id: "p-cpa", thinking_level: "low" });
  expect(host.textContent).not.toContain(t.sidebar.botModelInvalid);
  close();
});

/** Claude Code as the daemon reports it (ADR 0061); the panel only reads it. */
function claudeStatus(over: Record<string, unknown> = {}) {
  return {
    path: "/Users/you/.local/bin/claude", source: "known", version: "2.1.289", sdk_version: "2.1.289", outdated: false,
    logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: null, base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-05T00:00:00.000Z", error: null, ...over,
  };
}

function openOnClaude(bot: ReturnType<typeof aBot>, status: ReturnType<typeof claudeStatus> | null) {
  const runtime = fakeRuntime({ bots: [bot] });
  runtime.profileBotId = bot.id;
  (runtime as unknown as { client: unknown }).client = {
    claudeCode: async () => {
      if (!status) throw Object.assign(new Error("not here"), { status: 404 });
      return status;
    },
  };
  const view = render(ProfilePane, {
    runtime, bot, t, selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
    openDangerConfirm: () => {}, clearDanger: () => {}, onDeleteBot: () => {}, onClearHistory: () => {},
  });
  return { ...view, runtime };
}

test("switching a Bot to Claude Agent saves it, and shows whose Claude account its turns run on", async () => {
  const { host, runtime, close } = openOnClaude(aBot(), claudeStatus());
  expect(host.querySelector("#profile-agent-model")).toBeNull();
  click(host.querySelector("#profile-runner"));
  click([...host.querySelectorAll("#profile-runner-listbox [role=option]")].find((li) => li.textContent?.includes("Claude Agent")) ?? null);
  await sleep(200);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { runner: string | null }).runner).toBe("claude_code");
  close();
  // Once it runs on Claude Code (the daemon's echo), the endpoint pin gives way to Claude's own model and effort.
  const onClaude = openOnClaude(aBot({ runner: "claude_code" }), claudeStatus());
  await sleep(30);
  expect(onClaude.host.querySelector("#profile-model")).toBeNull();
  expect(onClaude.host.querySelector("#profile-agent-model")).not.toBeNull();
  expect(onClaude.host.querySelector("[data-runner-account]")?.textContent).toContain("Claude Pro 订阅");
  onClaude.close();
});

test("a Claude Agent Bot picks its model among Claude's aliases, or Claude Code's default; a name it already holds stays a row", async () => {
  const open = async (agentModel: string | null) => {
    const view = openOnClaude(aBot({ runner: "claude_code", agent_model: agentModel }), claudeStatus());
    await sleep(30);
    click(view.host.querySelector("#profile-agent-model"));
    await settle();
    return view;
  };
  const fresh = await open(null);
  expect(fresh.host.querySelector("#profile-agent-model")?.tagName).toBe("BUTTON");
  expect(rowLabels(fresh.host)).toEqual([t.sidebar.botAgentModelDefault, "sonnet", "opus", "haiku", "fable"]);
  expect(rowByValue(fresh.host, "")?.classList.contains("is-selected")).toBe(true);
  click(rowByValue(fresh.host, "opus"));
  expect(words(fresh.host.querySelector("#profile-agent-model"))).toContain("opus");
  await sleep(200);
  expect(lastSave(fresh.runtime)).toMatchObject({ runner: "claude_code", agent_model: "opus" });
  fresh.close();

  // Back to Claude Code's own default saves null.
  const held = await open("sonnet");
  click(rowByValue(held.host, ""));
  await sleep(200);
  expect(lastSave(held.runtime)).toMatchObject({ agent_model: null });
  held.close();

  // A full name that is no alias is a row of its own, chosen, so the Bot still reads right.
  const full = await open("claude-opus-4-6");
  expect(rowLabels(full.host)).toEqual([t.sidebar.botAgentModelDefault, "claude-opus-4-6", "sonnet", "opus", "haiku", "fable"]);
  expect(rowByValue(full.host, "claude-opus-4-6")?.classList.contains("is-selected")).toBe(true);
  full.close();
});

test("an effort picked for a Claude Agent Bot is saved as Claude Code's effort", async () => {
  const { host, runtime, close } = openOnClaude(aBot({ runner: "claude_code" }), claudeStatus());
  click(buttonByText(host, "高"));
  await sleep(200);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { agent_effort: string | null }).agent_effort).toBe("high");
  close();
});

test("a Claude Agent Bot whose Claude Code is missing or signed out says what to do in a terminal", async () => {
  const missing = openOnClaude(aBot({ runner: "claude_code" }), claudeStatus({ path: null }));
  await sleep(30);
  expect(missing.host.querySelector("[data-runner-missing]")?.textContent).toContain("没找到 Claude Code");
  missing.close();
  const signedOut = openOnClaude(aBot({ runner: "claude_code" }), claudeStatus({ logged_in: false, auth_method: "none" }));
  await sleep(30);
  expect(signedOut.host.querySelector("[data-runner-signed-out]")?.textContent).toContain("运行 claude 登录");
  signedOut.close();
});

test("when Claude Code's status cannot be read, the panel says so and what an older Mac needs", async () => {
  const phone = openOnClaude(aBot({ runner: "claude_code" }), null);
  await sleep(30);
  expect(phone.host.textContent).toContain("没查到 Claude Code 的状态");
  phone.close();
});

function twoAccounts(over: { teamSignedIn?: boolean } = {}) {
  const own = { config_dir: null, config_directory: "/Users/you/.claude", logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "pro@a.c", error: null, login_command: "claude auth login" };
  const team = { config_dir: "/Users/you/.claude-b", config_directory: "/Users/you/.claude-b", logged_in: over.teamSignedIn ?? true, auth_method: over.teamSignedIn === false ? "none" : "claude.ai",
    subscription_type: over.teamSignedIn === false ? null : "team", email: over.teamSignedIn === false ? null : "team@a.c", error: null,
    login_command: "CLAUDE_CONFIG_DIR=/Users/you/.claude-b claude auth login" };
  return claudeStatus({ email: "pro@a.c", accounts: [own, team] });
}

test("a Claude Agent Bot is put on one of your listed Claude accounts, and the panel says whose plan it spends", async () => {
  const { host, runtime, close } = openOnClaude(aBot({ runner: "claude_code", agent_config_dir: null }), twoAccounts());
  await sleep(30);
  expect(host.querySelector("[data-runner-account]")?.textContent).toContain("pro@a.c");
  click(host.querySelector("#profile-agent-account"));
  const options = [...host.querySelectorAll("#profile-agent-account-listbox [role=option]")].map((li) => li.textContent?.trim());
  expect(options).toEqual(["这台电脑的默认账号 · Claude Pro 订阅 · pro@a.c", "Claude Team 订阅 · team@a.c · /Users/you/.claude-b"]);
  click([...host.querySelectorAll("#profile-agent-account-listbox [role=option]")].find((li) => li.textContent?.includes("team@a.c")) ?? null);
  await sleep(0);
  expect(host.querySelector("[data-runner-account]")?.textContent).toContain("team@a.c");
  await sleep(200);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { agent_config_dir: string | null }).agent_config_dir).toBe("/Users/you/.claude-b");
  close();
});

test("a Bot on a listed account that is signed out says how to sign that account in", async () => {
  const view = openOnClaude(aBot({ runner: "claude_code", agent_config_dir: "/Users/you/.claude-b" }), twoAccounts({ teamSignedIn: false }));
  await sleep(30);
  expect(view.host.querySelector("[data-runner-signed-out]")?.textContent).toContain("CLAUDE_CONFIG_DIR=/Users/you/.claude-b claude auth login");
  view.close();
});

test("away from the computer the account a Bot runs on is still shown and can be set back to the default", async () => {
  const phone = openOnClaude(aBot({ runner: "claude_code", agent_config_dir: "/Users/you/.claude-b" }), null);
  await sleep(30);
  click(phone.host.querySelector("#profile-agent-account"));
  const options = [...phone.host.querySelectorAll("#profile-agent-account-listbox [role=option]")].map((li) => li.textContent?.trim());
  expect(options).toEqual(["这台电脑的默认账号", "/Users/you/.claude-b"]);
  phone.close();
  // A daemon older than accounts: no picker, and nothing about accounts in the save.
  const old = openOnClaude(aBot({ runner: "claude_code" }), claudeStatus());
  await sleep(30);
  expect(old.host.querySelector("[data-agent-account]")).toBeNull();
  click(buttonByText(old.host, "高"));
  await sleep(200);
  const saved = old.runtime.calls.filter((c) => c.name === "patchBot")[0]!.args[1] as Record<string, unknown>;
  expect("agent_config_dir" in saved).toBe(false);
  old.close();
});

/** One of your other local agents as the daemon reports it (ADR 0079); the panel only reads it. */
function agentStatus(runner: BotRunner, over: Record<string, unknown> = {}) {
  return {
    runner, custom_id: null, label: AGENT_KINDS[runner].label, path: `/usr/local/bin/${runner}`, source: "path", version: "1.0.0",
    logged_in: true, auth: null, login_command: null, models: [], default_model: null, proxy: null, proxy_source: null,
    checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
  };
}

/** Every agent but Claude, found and signed in; `over` changes some of them. */
function agentItems(over: Partial<Record<BotRunner, Record<string, unknown>>> = {}) {
  return BOT_RUNNERS.filter((runner) => runner !== "claude_code" && runner !== "custom").map((runner) => agentStatus(runner, over[runner]));
}

const acp = { id: "acp-1", name: "我的 ACP", command: "my-acp", args: ["--stdio"] };
const withAcp = (items: ReturnType<typeof agentItems>) => ({
  items: [...items, agentStatus("custom", { custom_id: acp.id, label: acp.name, path: "/usr/local/bin/my-acp", source: "custom" })],
  custom_agents: [acp],
});

/** The panel with `agents` as the daemon answers (null: it cannot be asked, as on the phone). */
function openOnAgent(bot: ReturnType<typeof aBot>, agents: { items: unknown[]; custom_agents: unknown[] } | null) {
  const runtime = fakeRuntime({ bots: [bot] });
  runtime.profileBotId = bot.id;
  (runtime as unknown as { client: unknown }).client = {
    claudeCode: async () => claudeStatus(),
    agents: async () => {
      if (!agents) throw Object.assign(new Error("not here"), { status: 404 });
      return agents;
    },
  };
  const view = render(ProfilePane, {
    runtime, bot, t, selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
    openDangerConfirm: () => {}, clearDanger: () => {}, onDeleteBot: () => {}, onClearHistory: () => {},
  });
  return { ...view, runtime };
}

const words = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
const runnerRows = (host: HTMLElement) => [...host.querySelectorAll("#profile-runner-listbox [role=option]")];
const efforts = (host: HTMLElement) => [...host.querySelectorAll('[role=radiogroup][aria-labelledby="profile-agent-effort-label"] button')].map((el) => el.textContent?.trim());
const lastSave = (runtime: ReturnType<typeof fakeRuntime>) => runtime.calls.filter((c) => c.name === "patchBot").at(-1)?.args[1] as Record<string, unknown>;

test("the runner picker lists the app, Claude Agent, every other local agent by name, then your own ACP agents; one not installed or signed out cannot be picked", async () => {
  const { host, runtime, close } = openOnAgent(aBot(), withAcp(agentItems({ grok: { path: null }, antigravity: { logged_in: false } })));
  await sleep(30);
  click(host.querySelector("#profile-runner"));
  const rows = runnerRows(host);
  expect(rows.map(words)).toEqual([t.sidebar.botRunnerApp, t.sidebar.botRunnerClaude, "Codex", "Grok 没装", "OpenCode", "Antigravity 没登录", "ZCode", "我的 ACP"]);
  expect(rows.filter((row) => row.getAttribute("aria-disabled") === "true").map(words)).toEqual(["Grok 没装", "Antigravity 没登录"]);
  // A missing agent is not a choice.
  click(rows[3]!);
  await sleep(200);
  expect(runtime.calls.filter((c) => c.name === "patchBot")).toHaveLength(0);
  close();
  // The phone, or a daemon older than local agents, cannot say what is found: only the app and Claude are offered.
  const phone = openOnAgent(aBot(), null);
  await sleep(30);
  click(phone.host.querySelector("#profile-runner"));
  expect(runnerRows(phone.host).map(words)).toEqual([t.sidebar.botRunnerApp, t.sidebar.botRunnerClaude]);
  phone.close();
});

test("choosing Codex saves runner codex; its effort is then one Codex takes, and saves as it is", async () => {
  const { host, runtime, close } = openOnAgent(aBot(), withAcp(agentItems()));
  await sleep(30);
  click(host.querySelector("#profile-runner"));
  click(runnerRows(host).find((row) => words(row) === "Codex") ?? null);
  await sleep(200);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect(saves[0]!.args[1]).toMatchObject({ runner: "codex", agent_model: null, agent_effort: null });
  expect("agent_custom_id" in (saves[0]!.args[1] as object)).toBe(false);
  close();

  const onCodex = openOnAgent(aBot({ runner: "codex", agent_config_dir: undefined }), withAcp(agentItems()));
  await sleep(30);
  expect(onCodex.host.querySelector("#profile-model")).toBeNull();
  expect(efforts(onCodex.host)).toEqual(["默认", "低", "中", "高", "极高", "最大"]);
  click(buttonByText(onCodex.host, "极高"));
  await sleep(200);
  expect(lastSave(onCodex.runtime)).toMatchObject({ runner: "codex", agent_effort: "xhigh" });
  onCodex.close();
});

test("the effort radios follow the agent: Grok stops at extra high, Antigravity goes up to max, OpenCode and your own ACP agents have none", async () => {
  const levels = async (runner: BotRunner, extra: Partial<Parameters<typeof aBot>[0]> = {}, agents = withAcp(agentItems())) => {
    const view = openOnAgent(aBot({ runner, ...extra }), agents);
    await sleep(30);
    const out = { radios: efforts(view.host), none: view.host.querySelector("[data-agent-no-effort]")?.textContent };
    view.close();
    return out;
  };
  expect((await levels("grok")).radios).toEqual(["默认", "低", "中", "高", "极高"]);
  expect((await levels("antigravity")).radios).toEqual(["默认", "低", "中", "高", "极高", "最大"]);
  const opencode = await levels("opencode");
  expect(opencode.radios).toEqual([]);
  expect(opencode.none).toBe(t.sidebar.botAgentNoEffort("OpenCode"));
  expect((await levels("custom", { agent_custom_id: acp.id })).radios).toEqual([]);
  // Claude's own radios are unchanged.
  const claude = openOnAgent(aBot({ runner: "claude_code" }), withAcp(agentItems()));
  await sleep(30);
  expect(efforts(claude.host)).toEqual(["默认", "低", "中", "高", "极高", "最大"]);
  claude.close();
});

test("moving a Bot to another agent clears its model and account, and keeps its effort only where that agent takes it", async () => {
  const bot = aBot({ runner: "codex", agent_model: "gpt-5.5", agent_effort: "max", agent_config_dir: "/Users/you/.codex-b" });
  const toGrok = openOnAgent(bot, withAcp(agentItems()));
  await sleep(30);
  click(toGrok.host.querySelector("#profile-runner"));
  click(runnerRows(toGrok.host).find((row) => words(row) === "Grok") ?? null);
  await sleep(200);
  // Grok takes no "max", and the daemon would refuse it with the rest.
  expect(lastSave(toGrok.runtime)).toMatchObject({ runner: "grok", agent_model: null, agent_effort: null, agent_config_dir: null });
  toGrok.close();

  const toAgy = openOnAgent(bot, withAcp(agentItems()));
  await sleep(30);
  click(toAgy.host.querySelector("#profile-runner"));
  click(runnerRows(toAgy.host).find((row) => words(row) === "Antigravity") ?? null);
  await sleep(200);
  expect(lastSave(toAgy.runtime)).toMatchObject({ runner: "antigravity", agent_model: null, agent_effort: "max", agent_config_dir: null });
  toAgy.close();

  const toApp = openOnAgent(bot, withAcp(agentItems()));
  await sleep(30);
  click(toApp.host.querySelector("#profile-runner"));
  click(runnerRows(toApp.host).find((row) => words(row) === t.sidebar.botRunnerApp) ?? null);
  await sleep(0);
  // The endpoint's model takes the place of the agent's fields at once, before the daemon has echoed the save.
  expect(toApp.host.querySelector("#profile-model")).not.toBeNull();
  expect(toApp.host.querySelector("#profile-agent-model")).toBeNull();
  await sleep(200);
  expect(lastSave(toApp.runtime)).toMatchObject({ runner: null, agent_model: null, agent_effort: null });
  toApp.close();
});

test("one of your own ACP agents is picked by its name and saved as runner custom with its id", async () => {
  const { host, runtime, close } = openOnAgent(aBot(), withAcp(agentItems()));
  await sleep(30);
  click(host.querySelector("#profile-runner"));
  click(runnerRows(host).find((row) => words(row) === "我的 ACP") ?? null);
  await sleep(200);
  expect(lastSave(runtime)).toMatchObject({ runner: "custom", agent_custom_id: "acp-1", agent_effort: null });
  close();
  // Reopened on it: the picker reads its name, not "custom".
  const on = openOnAgent(aBot({ runner: "custom", agent_custom_id: "acp-1" }), withAcp(agentItems()));
  await sleep(30);
  expect(words(on.host.querySelector("#profile-runner"))).toBe("我的 ACP");
  expect(on.host.querySelector("[data-runner-account]")?.textContent).toContain("我的 ACP");
  on.close();
  // Its entry removed from Settings: still readable, marked, and the save names no agent it could run.
  const gone = openOnAgent(aBot({ runner: "custom", agent_custom_id: "acp-gone" }), withAcp(agentItems()));
  await sleep(30);
  click(gone.host.querySelector("#profile-runner"));
  expect(runnerRows(gone.host).at(-1) && words(runnerRows(gone.host).at(-1))).toBe(`${AGENT_KINDS.custom.label} ${t.sidebar.botRunnerAgentGone}`);
  gone.close();
});

test("a Bot on another agent picks its model among the ones the agent lists, or its default, or types one it knows", async () => {
  const items = agentItems({ codex: { models: [{ id: "gpt-5.5", name: "GPT-5.5", efforts: ["low", "high"] }, { id: "gpt-5.5-mini", name: "gpt-5.5-mini", efforts: [] }], default_model: "gpt-5.5" } });
  const open = async (bot = aBot({ runner: "codex" }), agents: Parameters<typeof openOnAgent>[1] = withAcp(items)) => {
    const view = openOnAgent(bot, agents);
    await sleep(30);
    return view;
  };
  const list = async (host: HTMLElement) => {
    click(host.querySelector("#profile-agent-model"));
    await settle();
  };
  const { host, runtime, close } = await open();
  // A picker, not a text field: the agent's default reads as such, and only Codex's models are offered.
  expect(host.querySelector("#profile-agent-model")?.tagName).toBe("BUTTON");
  expect(words(host.querySelector("#profile-agent-model"))).toBe(t.sidebar.botAgentModelDefaultOf("Codex"));
  expect(host.querySelector("[data-agent-model]")?.textContent).toContain(t.sidebar.botAgentModelEmptyHint("Codex", "gpt-5.5"));
  await list(host);
  expect(host.querySelector(".mp-source")).toBeNull();
  expect(rowLabels(host)).toEqual([t.sidebar.botAgentModelDefaultOf("Codex"), "GPT-5.5", "gpt-5.5-mini"]);
  expect(words(host.querySelector(".mp-row-detail"))).toBe("gpt-5.5");
  click(rowByValue(host, "gpt-5.5"));
  // Picked, it wears Codex's logo.
  expect(host.querySelector("#profile-agent-model [data-agent-logo='codex']")).not.toBeNull();
  expect(words(host.querySelector("#profile-agent-model"))).toContain("GPT-5.5");
  await sleep(200);
  expect(lastSave(runtime)).toMatchObject({ runner: "codex", agent_model: "gpt-5.5" });
  close();

  // Its default is the empty name: saved as null.
  const held = await open(aBot({ runner: "codex", agent_model: "gpt-5.5-mini" }));
  await list(held.host);
  expect(rowByValue(held.host, "gpt-5.5-mini")?.classList.contains("is-selected")).toBe(true);
  click(rowByValue(held.host, ""));
  await sleep(200);
  expect(lastSave(held.runtime)).toMatchObject({ runner: "codex", agent_model: null });
  held.close();

  // One the agent never listed is typed into the search, as it spells it, and saved as typed.
  const typed = await open();
  await list(typed.host);
  const search = typed.host.querySelector<HTMLInputElement>(".mp-search input")!;
  fill(search, "openai/gpt-5.5-turbo");
  expect(rowLabels(typed.host)).toEqual([t.modelPicker.useTyped("openai/gpt-5.5-turbo")]);
  press(search, "Enter");
  await sleep(200);
  expect(lastSave(typed.runtime)).toMatchObject({ runner: "codex", agent_model: "openai/gpt-5.5-turbo" });
  typed.close();

  // A name with a space is not one any agent takes: it is not offered, so nothing wrong is sent.
  const spaced = await open();
  await list(spaced.host);
  fill(spaced.host.querySelector(".mp-search input"), "nosuch model");
  expect(spaced.host.querySelector(".mp-row")).toBeNull();
  expect(spaced.host.querySelector(".mp-empty")?.textContent).toBe(t.modelPicker.noMatch);
  spaced.close();
});

test("a model the agent does not list stays a row of its own; an agent that lists none, or cannot be asked, still takes a typed name", async () => {
  const listed = await (async () => {
    const view = openOnAgent(aBot({ runner: "codex", agent_model: "o9-private" }), withAcp(agentItems({ codex: { models: [{ id: "gpt-5.5", name: "gpt-5.5", efforts: [] }] } })));
    await sleep(30);
    return view;
  })();
  expect(words(listed.host.querySelector("#profile-agent-model"))).toBe("o9-private");
  click(listed.host.querySelector("#profile-agent-model"));
  await settle();
  expect(rowLabels(listed.host)).toEqual([t.sidebar.botAgentModelDefaultOf("Codex"), "o9-private", "gpt-5.5"]);
  expect(rowByValue(listed.host, "o9-private")?.classList.contains("is-selected")).toBe(true);
  listed.close();

  // ZCode lists no models: the picker says to type one.
  const zcode = openOnAgent(aBot({ runner: "zcode" }), withAcp(agentItems()));
  await sleep(30);
  click(zcode.host.querySelector("#profile-agent-model"));
  await settle();
  expect(zcode.host.querySelector(".mp-empty")?.textContent).toContain(t.modelPicker.noModels);
  fill(zcode.host.querySelector(".mp-search input"), "glm-5.3");
  press(zcode.host.querySelector(".mp-search input"), "Enter");
  await sleep(200);
  expect(lastSave(zcode.runtime)).toMatchObject({ runner: "zcode", agent_model: "glm-5.3" });
  zcode.close();

  // The phone cannot ask the daemon what agents it finds, and still sets a model by name.
  const phone = openOnAgent(aBot({ runner: "codex" }), null);
  await sleep(30);
  click(phone.host.querySelector("#profile-agent-model"));
  await settle();
  fill(phone.host.querySelector(".mp-search input"), "gpt-5.5");
  press(phone.host.querySelector(".mp-search input"), "Enter");
  await sleep(200);
  expect(lastSave(phone.runtime)).toMatchObject({ runner: "codex", agent_model: "gpt-5.5" });
  phone.close();
});

test("an agent that is not found, signed out, or cannot be asked says what to do, and Antigravity says it cannot use Deskfolk's tools", async () => {
  const missing = openOnAgent(aBot({ runner: "codex" }), withAcp(agentItems({ codex: { path: null } })));
  await sleep(30);
  expect(missing.host.querySelector("[data-runner-missing]")?.textContent).toContain("没找到 Codex（codex）");
  missing.close();
  const signedOut = openOnAgent(aBot({ runner: "codex" }), withAcp(agentItems({ codex: { logged_in: false, login_command: "codex login" } })));
  await sleep(30);
  expect(signedOut.host.querySelector("[data-runner-signed-out]")?.textContent).toContain("运行 codex login");
  signedOut.close();
  const signedIn = openOnAgent(aBot({ runner: "codex" }), withAcp(agentItems({ codex: { auth: "ChatGPT Plus" } })));
  await sleep(30);
  expect(signedIn.host.querySelector("[data-runner-account]")?.textContent).toContain("ChatGPT Plus");
  expect(signedIn.host.querySelector("[data-runner-note]")).toBeNull();
  signedIn.close();
  const unreachable = openOnAgent(aBot({ runner: "codex" }), null);
  await sleep(30);
  expect(unreachable.host.textContent).toContain(t.sidebar.botRunnerAgentUnavailable("Codex"));
  unreachable.close();
  const agy = openOnAgent(aBot({ runner: "antigravity" }), withAcp(agentItems()));
  await sleep(30);
  expect(agy.host.querySelector("[data-runner-note]")?.textContent).toBe(t.sidebar.botRunnerNoAppTools("Antigravity"));
  agy.close();
});

test("an agent with several accounts lets a Bot pick which one its turns spend; an agent without config directories has no such field", async () => {
  const accounts = [
    { config_dir: null, logged_in: true, auth: "ChatGPT Plus", error: null, login_command: "codex login" },
    { config_dir: "/Users/you/.codex-b", logged_in: true, auth: "ChatGPT Pro", error: null, login_command: "CODEX_HOME=/Users/you/.codex-b codex login" },
  ];
  const { host, runtime, close } = openOnAgent(aBot({ runner: "codex", agent_config_dir: null }), withAcp(agentItems({ codex: { accounts } })));
  await sleep(30);
  expect(host.querySelector("label[for=profile-agent-account]")?.textContent).toBe(t.sidebar.botAgentAccountOf("Codex"));
  click(host.querySelector("#profile-agent-account"));
  expect([...host.querySelectorAll("#profile-agent-account-listbox [role=option]")].map(words)).toEqual([
    `${t.sidebar.botAgentAccountDefault} · ChatGPT Plus`,
    "ChatGPT Pro · /Users/you/.codex-b",
  ]);
  click([...host.querySelectorAll("#profile-agent-account-listbox [role=option]")].at(-1) ?? null);
  await sleep(200);
  expect(lastSave(runtime)).toMatchObject({ runner: "codex", agent_config_dir: "/Users/you/.codex-b" });
  close();
  // That account signed out: its own sign-in command.
  const out = openOnAgent(aBot({ runner: "codex", agent_config_dir: "/Users/you/.codex-b" }), withAcp(agentItems({ codex: { accounts: [accounts[0], { ...accounts[1], logged_in: false }] } })));
  await sleep(30);
  expect(out.host.querySelector("[data-runner-signed-out]")?.textContent).toContain("CODEX_HOME=/Users/you/.codex-b codex login");
  out.close();
  const grok = openOnAgent(aBot({ runner: "grok", agent_config_dir: null }), withAcp(agentItems()));
  await sleep(30);
  expect(grok.host.querySelector("[data-agent-account]")).toBeNull();
  grok.close();
});
