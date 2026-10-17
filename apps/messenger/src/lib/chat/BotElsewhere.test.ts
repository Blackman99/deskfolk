import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import BotElsewhere from "./BotElsewhere.svelte";
import Sidebar from "../sidebar/Sidebar.svelte";

const t = copyFor("zh");
const bots = [aBot({ id: "bot-1", name: "视频导演" }), aBot({ id: "bot-2", name: "审核员" })];
const direct = aDirect({ id: "direct-1" });
const sessions = [direct, aGroup({ id: "sess-1", name: "视频组" }), aBotDirect({ id: "botbot-1" })];

function selected(runtime: ReturnType<typeof fakeRuntime>): unknown[] {
  return runtime.calls.filter((call) => call.name === "selectSession").map((call) => call.args[0]);
}

test("one place elsewhere: the header says where, and one press opens it", () => {
  const runtime = fakeRuntime({ bots, sessions, turns: [aTurn({ session_id: "botbot-1", partial_text: "…" })] });
  const { host, close } = render(BotElsewhere, { runtime, t, botId: "bot-1", here: direct });
  try {
    const trigger = host.querySelector<HTMLButtonElement>(".elsewhere-trigger")!;
    expect(trigger.textContent?.trim()).toBe("在和「审核员」私聊 · 回复中");
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();
    click(trigger);
    expect(selected(runtime)).toEqual(["botbot-1"]);
  } finally {
    close();
  }
});

test("more places: a list, the one waiting on you first, each opening its conversation", () => {
  const runtime = fakeRuntime({
    bots,
    sessions,
    turns: [
      aTurn({ id: "t1", session_id: "botbot-1", created_at: "2026-09-19T01:00:00.000Z" }),
      aTurn({ id: "t2", session_id: "sess-1", status: "waiting_approval", created_at: "2026-09-19T02:00:00.000Z" }),
      aTurn({ id: "t3", session_id: "direct-1" }),
    ],
  });
  const { host, close } = render(BotElsewhere, { runtime, t, botId: "bot-1", here: direct });
  try {
    const trigger = host.querySelector<HTMLButtonElement>(".elsewhere-trigger")!;
    expect(trigger.textContent?.trim()).toBe("另在 2 处工作");
    expect(trigger.classList.contains("is-waiting_approval")).toBe(true);
    click(trigger);
    flushSync();
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ""))).toEqual(["群视频组待审批", "Bot↔Bot视频导演↔审核员思考中"]);
    click(rows[1]);
    expect(selected(runtime)).toEqual(["botbot-1"]);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  } finally {
    close();
  }
});

test("at work nowhere else: nothing shows", () => {
  const runtime = fakeRuntime({ bots, sessions, turns: [aTurn({ session_id: "direct-1" })] });
  const { host, close } = render(BotElsewhere, { runtime, t, botId: "bot-1", here: direct });
  expect(host.querySelector(".elsewhere")).toBeNull();
  close();
});

test("the list's row for your direct says where its Bot is at work, in place of the last line", () => {
  const runtime = fakeRuntime({ bots, sessions, turns: [aTurn({ session_id: "sess-1" })] });
  const { host, close } = render(Sidebar, {
    runtime, t, selected: null, pinnedSessionIds: [], workspaceOpen: false, contextMenuSessionId: null,
    onOpenContextMenu: () => {}, onToggleWorkspace: () => {}, onCreateBot: () => {}, onCreateGroup: () => {},
  });
  try {
    const rows = [...host.querySelectorAll(".row")];
    const directRow = rows.find((row) => row.querySelector(".t")?.textContent === "视频导演")!;
    expect(directRow.querySelector(".s.is-elsewhere")?.textContent).toBe("在群「视频组」 · 思考中");
    expect(directRow.querySelector(".avatar-status-dot")?.getAttribute("title")).toBe("视频导演: 在群「视频组」 · 思考中");
    const groupRow = rows.find((row) => row.querySelector(".t")?.textContent === "视频组")!;
    expect(groupRow.querySelector(".s.is-elsewhere")).toBeNull();
  } finally {
    close();
  }
});
