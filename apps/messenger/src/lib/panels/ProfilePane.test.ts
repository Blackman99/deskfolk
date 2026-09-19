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
