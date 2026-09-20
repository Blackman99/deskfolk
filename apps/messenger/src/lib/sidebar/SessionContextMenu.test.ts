import { expect, test } from "bun:test";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup } from "../test-fixtures.ts";
import { buttonByText, click, render } from "../test-render.ts";
import SessionContextMenu from "./SessionContextMenu.svelte";

const t = copyFor("zh");

function open(
  session: SessionSummary,
  bots: Bot[],
  handlers: Partial<{
    onDelete: () => void;
    onClearHistory: () => void;
    onClose: () => void;
  }> = {},
) {
  const calls = { delete: 0, clear: 0, close: 0 };
  const view = render(SessionContextMenu, {
    session,
    botsById: new Map(bots.map((b) => [b.id, b] as const)),
    isPinned: false,
    x: 20,
    y: 20,
    t,
    onClose: () => {
      calls.close += 1;
      handlers.onClose?.();
    },
    onTogglePin: () => {},
    onViewInfo: () => {},
    onClearHistory: () => {
      calls.clear += 1;
      handlers.onClearHistory?.();
    },
    onToggleArchive: () => {},
    onDelete: () => {
      calls.delete += 1;
      handlers.onDelete?.();
    },
  });
  return { ...view, calls };
}

test("delete on a group fires the handler and closes, without needing the row selected", () => {
  const { host, calls, close } = open(aGroup(), [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })]);
  click(buttonByText(host, t.sidebar.delete));
  expect(calls.delete).toBe(1);
  expect(calls.close).toBe(1);
  close();
});

test("clear history on a group fires the handler and closes", () => {
  const { host, calls, close } = open(aGroup(), [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })]);
  click(buttonByText(host, t.sidebar.clearHistory));
  expect(calls.clear).toBe(1);
  expect(calls.close).toBe(1);
  expect(calls.delete).toBe(0);
  close();
});

test("delete on a you-bot direct fires the handler", () => {
  const { host, calls, close } = open(aDirect(), [aBot()]);
  click(buttonByText(host, t.sidebar.delete));
  expect(calls.delete).toBe(1);
  close();
});

test("delete on a bot-bot direct stays disabled", () => {
  const session = aDirect({
    id: "bb-1",
    participants: [
      { member: "bot-1", joined_at: "t1", left_at: null },
      { member: "bot-2", joined_at: "t1", left_at: null },
    ],
  });
  const { host, calls, close } = open(session, [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })]);
  const del = buttonByText(host, t.sidebar.delete);
  expect(del.disabled).toBe(true);
  click(del);
  expect(calls.delete).toBe(0);
  close();
});
