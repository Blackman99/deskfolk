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

test("a save the server refuses says so beside the title, and the next edit tries again", async () => {
  const bot = aBot();
  let asked = 0;
  const runtime = fakeRuntime({ bots: [bot], skills: [] }, { patchBot: async () => ((asked += 1), { status: 500, message: "boom" }) });
  runtime.profileBotId = bot.id;
  const { host, close } = render(ProfilePane, {
    runtime, bot, t, modelOptions: [], selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
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

test("on the workbench, where the drawer's profileBotId stays unset, picking a model still saves it", async () => {
  const bot = aBot();
  const runtime = fakeRuntime({ bots: [bot] });
  const { host, close } = render(ProfilePane, {
    runtime,
    bot,
    t,
    modelOptions: [{ value: "gpt-6-astra", label: "gpt-6-astra" }],
    selectedKind: "you-bot",
    profileFailed: false,
    initialTab: "basics",
    openDangerConfirm: () => {},
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  });
  click(host.querySelector("#profile-model"));
  click([...host.querySelectorAll("#profile-model-listbox [role=option]")].find((li) => li.textContent?.includes("gpt-6-astra")) ?? null);
  await sleep(200);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
  expect(saves[0]!.args[0]).toBe(bot.id);
  expect((saves[0]!.args[1] as { model: string | null }).model).toBe("gpt-6-astra");
  close();
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
  const runtime = fakeRuntime({ bots: [bot] });
  runtime.profileBotId = bot.id;
  const { host, close } = render(ProfilePane, {
    runtime, bot, t, modelOptions: [{ value: "p-cpa::gemini-3.8-flash-high", label: "gemini-3.8-flash-high" }],
    selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
    openDangerConfirm: () => {}, clearDanger: () => {}, onDeleteBot: () => {}, onClearHistory: () => {},
  });
  expect(host.textContent).toContain(t.sidebar.botModelUnlistedHint);
  fill(host.querySelector("#profile-duties"), "按分镜生成镜头");
  await sleep(750);
  const saves = runtime.calls.filter((c) => c.name === "patchBot");
  expect(saves).toHaveLength(1);
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
    runtime, bot, t, modelOptions: [], selectedKind: "you-bot", profileFailed: false, initialTab: "basics",
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

test("away from the computer the panel says Claude Code's status lives there", async () => {
  const phone = openOnClaude(aBot({ runner: "claude_code" }), null);
  await sleep(30);
  expect(phone.host.textContent).toContain("Claude Code 的状态只能在电脑上查看");
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
