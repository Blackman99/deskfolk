import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aSkill, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import ProfilePane from "./ProfilePane.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(over: { bot?: ReturnType<typeof aBot>; skills?: ReturnType<typeof aSkill>[] } = {}) {
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
  const { host, close } = open();
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
  const live = open();
  click(buttonByText(live.host, t.sidebar.archive));
  expect(live.runtime.calls.some((c) => c.name === "archiveBot")).toBe(true);
  live.close();

  const gone = open({ bot: archived });
  click(buttonByText(gone.host, t.sidebar.restore));
  expect(gone.runtime.calls.some((c) => c.name === "restoreBot")).toBe(true);
  gone.close();
});

test("deleting a skill asks the shell for a confirm that knows which skill", async () => {
  const skill = aSkill({ id: "skill-9", name: "查证" });
  const bot = aBot();
  const runtime = fakeRuntime({ bots: [bot], skills: [skill] });
  runtime.profileBotId = bot.id;
  let asked: { kind: string; run: () => Promise<void> } | null = null;
  const { host, close } = render(ProfilePane, {
    runtime,
    bot,
    t,
    modelOptions: [],
    selectedKind: "you-bot",
    profileFailed: false,
    openDangerConfirm: (kind: "skill", run: () => Promise<void>) => (asked = { kind, run }),
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  });
  click(host.querySelector(".skill-open"));
  click(buttonByText(host, t.sidebar.skillDelete));
  expect(asked).not.toBeNull();
  expect(asked!.kind).toBe("skill");
  await asked!.run();
  expect(runtime.calls.find((c) => c.name === "deleteSkill")?.args).toEqual(["skill-9"]);
  close();
});

test("head add button opens the skill modal, cancel button closes it", () => {
  const { host, close } = open();
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
  let asked: { kind: string; run: () => Promise<void> } | null = null;
  const { host, close } = render(ProfilePane, {
    runtime,
    bot,
    t,
    modelOptions: [],
    selectedKind: "you-bot",
    profileFailed: false,
    openDangerConfirm: (kind: "skill", run: () => Promise<void>) => (asked = { kind, run }),
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
  await asked!.run();
  expect(runtime.calls.find((c) => c.name === "deleteSkill")?.args).toEqual(["skill-1"]);
  close();
});

test("empty state shows guidance and add button when bot has no skills", () => {
  const { host, close } = open({ skills: [] });
  expect(host.querySelector(".skill-empty-card")).not.toBeNull();
  expect(host.querySelector(".skill-empty-text")?.textContent?.trim()).toBe(t.sidebar.skillsEmpty);

  click(host.querySelector(".skill-empty-add-btn"));
  expect(host.querySelector(".skill-modal")).not.toBeNull();
  close();
});
