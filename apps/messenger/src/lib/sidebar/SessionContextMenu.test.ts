import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, type Bot, type SessionSummary } from "@real-bot/protocol";
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
  const calls = { delete: 0, clear: 0, close: 0, jobViews: [] as string[] };
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
    onShowJobView: () => calls.jobViews.push("trace"),
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

test("a Bot's and a group's row open the latest job's one flow tab (ADR 0086)", () => {
  for (const session of [aDirect(), aGroup()]) {
    const { host, calls, close } = open(session, [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })]);
    expect([...host.querySelectorAll("[data-job-view]")].map((row) => row.textContent?.trim())).toEqual([t.plan.segmentTrace]);
    click(host.querySelector('[data-job-view="trace"]'));
    expect(calls.jobViews).toEqual(["trace"]);
    expect(calls.close).toBe(1);
    close();
  }
});

test("the file drop has no job to open", () => {
  const { host, close } = open(aDirect({ id: FILE_DROP_SESSION_ID }), [aBot({ id: "bot-1" })]);
  expect(host.querySelector("[data-job-view]")).toBeNull();
  close();
});

test("Rename shows for a project session only where it is given, and closes the menu", async () => {
  const { aProjectSession } = await import("../test-fixtures.ts");
  let renamed = 0;
  let closed = 0;
  const view = render(SessionContextMenu, {
    session: aProjectSession(), botsById: new Map(), isPinned: false, x: 20, y: 20, t,
    onClose: () => (closed += 1), onTogglePin: () => {}, onViewInfo: () => {}, onClearHistory: () => {},
    onToggleArchive: () => {}, onDelete: () => {}, onRename: () => (renamed += 1),
  });
  click(view.host.querySelector("[data-session-rename]"));
  expect([renamed, closed]).toEqual([1, 1]);
  view.close();
  // The sidebar folded to its rail has no row to type in: no Rename there.
  const { host, close } = open(aProjectSession(), []);
  expect(host.querySelector("[data-session-rename]")).toBeNull();
  close();
});

test("a project session's menu opens its directory where it is given, and closes", async () => {
  const { aProjectSession } = await import("../test-fixtures.ts");
  let opened = 0;
  let closed = 0;
  const view = render(SessionContextMenu, {
    session: aProjectSession(), botsById: new Map(), isPinned: false, x: 20, y: 20, t,
    onClose: () => (closed += 1), onTogglePin: () => {}, onViewInfo: () => {}, onClearHistory: () => {},
    onToggleArchive: () => {}, onDelete: () => {}, onOpenProjectDir: () => (opened += 1),
  });
  const item = view.host.querySelector("[data-session-project-dir]");
  expect(item?.textContent?.trim()).toBe(t.project.openDir);
  // Without a task map item above it, it starts a group of its own.
  expect(item?.previousElementSibling?.getAttribute("role")).toBe("separator");
  click(item);
  expect([opened, closed]).toEqual([1, 1]);
  view.close();
  // A Bot's conversation has no directory to open.
  const { host, close } = open(aDirect(), [aBot()]);
  expect(host.querySelector("[data-session-project-dir]")).toBeNull();
  close();
});
