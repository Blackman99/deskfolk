import { expect, test } from "bun:test";
import type { SessionSummary } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aMessage, aTurn } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import BotDmEntry from "./BotDmEntry.svelte";

const t = copyFor("zh");

const statusLabels = {
  running: t.sidebar.statusRunning,
  replying: t.sidebar.statusReplying,
  waitingApproval: t.sidebar.statusWaitingApproval,
  waitingAsk: t.sidebar.statusWaitingAsk,
  idle: t.sidebar.statusIdle,
};

function open(sessions: SessionSummary[], turns = [] as ReturnType<typeof aTurn>[]) {
  const opened: string[] = [];
  const view = render(BotDmEntry, {
    sessions,
    botsById: new Map([
      ["bot-1", aBot({ id: "bot-1", name: "Writer" })],
      ["bot-2", aBot({ id: "bot-2", name: "Researcher" })],
    ]),
    turns,
    statusLabels,
    rosterLabels: { deleted: t.top.deleted, archived: t.top.archived },
    openedText: t.chat.botDmOpened,
    onOpen: (id: string) => opened.push(id),
  });
  return { ...view, opened };
}

test("one direct reads as a single line naming both bots", () => {
  const { host, close } = open([aBotDirect({ last_message: aMessage() })]);
  expect(host.querySelector(".bot-dm-card.is-single")).toBeTruthy();
  expect(host.querySelector(".bot-dm-name")?.textContent).toBe("Writer ↔ Researcher");
  close();
});

test("a running direct shows it is still going", () => {
  const { host, close } = open(
    [aBotDirect({ last_message: aMessage() })],
    [aTurn({ session_id: "botbot-1", status: "running" })],
  );
  expect(host.querySelector(".bot-dm-live")).toBeTruthy();
  close();
});

test("several directs from one message become a card with a count", () => {
  const { host, close } = open([
    aBotDirect({ id: "d-1" }),
    aBotDirect({ id: "d-2" }),
    aBotDirect({ id: "d-3" }),
  ]);
  expect(host.querySelector(".bot-dm-card.is-multiple")).toBeTruthy();
  expect(host.querySelector(".bot-dm-count")?.textContent).toBe("3");
  expect(host.querySelectorAll(".bot-dm-chip")).toHaveLength(3);
  close();
});

/** Each chip must open its own direct, not the first one. */
test("clicking the second chip opens the second direct", () => {
  const { host, opened, close } = open([
    aBotDirect({ id: "d-1" }),
    aBotDirect({ id: "d-2" }),
    aBotDirect({ id: "d-3" }),
  ]);
  click(host.querySelectorAll(".bot-dm-chip")[1]);
  expect(opened).toEqual(["d-2"]);
  close();
});

/** A chatty bot should not turn the transcript into a wall of chips. */
test("past the inline limit the rest collapse into one more chip", () => {
  const { host, opened, close } = open([
    aBotDirect({ id: "d-1" }),
    aBotDirect({ id: "d-2" }),
    aBotDirect({ id: "d-3" }),
    aBotDirect({ id: "d-4" }),
    aBotDirect({ id: "d-5" }),
  ]);
  const overflow = host.querySelector(".bot-dm-chip.is-overflow");
  expect(overflow?.textContent?.trim()).toBe("+2");
  click(overflow);
  expect(opened).toEqual(["d-5"]);
  close();
});

test("a deleted bot is named rather than left blank", () => {
  const { host, close } = open([aBotDirect({ last_message: aMessage() })]);
  const view = render(BotDmEntry, {
    sessions: [aBotDirect({ last_message: aMessage() })],
    botsById: new Map([["bot-1", aBot({ id: "bot-1", name: "Writer" })]]),
    turns: [],
    statusLabels,
    rosterLabels: { deleted: t.top.deleted, archived: t.top.archived },
    openedText: t.chat.botDmOpened,
    onOpen: () => {},
  });
  expect(view.host.querySelector(".bot-dm-name")?.textContent).toContain(t.top.deleted);
  view.close();
  close();
});

test("nothing renders when there is nothing to show", () => {
  const { host, close } = open([]);
  expect(host.querySelector(".bot-dm-card")).toBeNull();
  close();
});
