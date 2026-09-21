import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aSkill, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import ProfilePane from "./ProfilePane.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(over: {
  bot?: ReturnType<typeof aBot>;
  skills?: ReturnType<typeof aSkill>[];
  initialTab?: "basics" | "skills" | "memory" | "actions";
} = {}) {
  const bot = over.bot ?? aBot();
  const runtime = fakeRuntime({ bots: [bot], skills: over.skills ?? [] });
  runtime.profileBotId = bot.id;
  const view = render(ProfilePane, {
    runtime,
    bot,
    t,
    modelOptions: [],
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
    modelOptions: [],
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
    modelOptions: [],
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
  const { host, close } = render(ProfilePane, { runtime, bot, t, modelOptions: [], selectedKind: 'you-bot', profileFailed: false,
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
    modelOptions: [],
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
