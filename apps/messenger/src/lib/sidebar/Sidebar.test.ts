import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aGroup, aMessage, aRoutine, fakeRuntime } from "../test-fixtures.ts";
import { click, press, render } from "../test-render.ts";
import Sidebar from "./Sidebar.svelte";
import { BOT_DM_VISIBLE } from "./bot-dm-source.ts";

import { flushSync } from 'svelte';
import { reactive } from '../test-reactive.svelte.ts';

const t = copyFor("zh");

function botDms(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return aBotDirect({
      id: `d-${n}`,
      last_message: aMessage({ created_at: `2026-09-19T${n}:00:00.000Z` }),
    });
  });
}

function open(sessions: ReturnType<typeof aBotDirect>[], selectedId: string | null = null, live = false) {
  const stub = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
    sessions: [aGroup({ id: "sess-1", name: "视频组" }), ...sessions],
  });
  const runtime = live ? reactive(stub) : stub;
  runtime.selectedId = selectedId;
  const view = render(Sidebar, {
    runtime,
    t,
    selected: null,
    pinnedSessionIds: [],
    themeMenuOpen: false,
    workspaceOpen: false,
    contextMenuSessionId: null,
    onOpenContextMenu: () => {},
    onToggleWorkspace: () => {},
    onOpenSettings: () => {},
    onCreateBot: () => {},
    onCreateGroup: () => {},
    onOpenArtifact: () => {},
    onPatchTheme: async () => true,
  });
  return { ...view, runtime };
}

for (const selected of [null, 'sess-1']) for (const deletedAfterResult of [false, true]) test(`retained routine with unavailable owner is explained and inert (${selected}, ${deletedAfterResult})`, () => {
  const { host, runtime, close } = open([], selected, true);
  flushSync(() => {
    runtime.snapshot.routines = [aRoutine()];
    runtime.searchQuery = 'Morning';
    runtime.searchHits = [{ kind: 'routine', id: 'routine-1', snippet: 'Morning brief' }];
    if (!deletedAfterResult) runtime.snapshot.bots = [];
  });
  const input = host.querySelector('input.search') as HTMLInputElement;
  input.focus(); flushSync();
  if (deletedAfterResult) flushSync(() => { runtime.snapshot.bots = []; });
  const result = host.querySelector('[role=option]')!;
  expect(result.getAttribute('aria-disabled')).toBe('true');
  expect(result.textContent).toContain(t.sidebar.routineUnavailable);
  click(result); press(input, 'Enter');
  expect(runtime.calls.some((call) => ['openRoutine', 'closeSearch'].includes(call.name))).toBe(false);
  expect(runtime.snapshot.routines).toHaveLength(1);
  expect(host.querySelector('[role=listbox]')).not.toBeNull();
  close();
});

test("only the most recent directs are listed, with the rest behind a toggle", () => {
  const { host, close } = open(botDms(7));
  expect(host.querySelectorAll(".row-stack")).toHaveLength(BOT_DM_VISIBLE);
  const more = host.querySelector(".ghead-more") as HTMLButtonElement;
  expect(more.textContent?.trim()).toBe(t.sidebar.botBotMore(2));
  click(more);
  expect(host.querySelectorAll(".row-stack")).toHaveLength(7);
  close();
});

test("a handful of directs need no toggle", () => {
  const { host, close } = open(botDms(3));
  expect(host.querySelector(".ghead-more")).toBeNull();
  close();
});

/** The row and its source line are two separate targets; neither should fire the other. */
test("the source line jumps to the triggering message, the row opens the direct", () => {
  const { host, runtime, close } = open(botDms(1));
  click(host.querySelector(".row-source"));
  expect(runtime.calls.filter((c) => c.name === "selectSession")).toHaveLength(1);
  expect(runtime.calls[0].args).toEqual(["sess-1", { messageId: "msg-1" }]);

  click(host.querySelector(".row-stack .row"));
  const selects = runtime.calls.filter((c) => c.name === "selectSession");
  expect(selects).toHaveLength(2);
  expect(selects[1].args).toEqual(["d-01"]);
  close();
});

test("the source line names where the direct came from", () => {
  const { host, close } = open(botDms(1));
  expect(host.querySelector(".row-source-text")?.textContent).toBe(
    t.sidebar.botBotSource("视频组"),
  );
  close();
});

test("a direct opened before sources were recorded says so instead of offering a dead link", () => {
  const { host, close } = open([
    aBotDirect({ id: "d-legacy", origin_session_id: null, origin_message_id: null }),
  ]);
  const source = host.querySelector(".row-source") as HTMLElement;
  expect(source.tagName).toBe("SPAN");
  expect(source.textContent?.trim()).toBe(t.sidebar.botBotSourceUnknown);
  close();
});

test("a direct whose source session is gone says so", () => {
  const { host, close } = open([aBotDirect({ id: "d-orphan", origin_session_id: "deleted" })]);
  const source = host.querySelector(".row-source") as HTMLElement;
  expect(source.tagName).toBe("SPAN");
  expect(source.textContent?.trim()).toBe(t.sidebar.botBotSourceMissing);
  close();
});

/** Otherwise the one you are reading disappears from the sidebar while you read it. */
test("the open direct stays listed even when it falls past the cap", () => {
  const { host, close } = open(botDms(7), "d-01");
  const ids = [...host.querySelectorAll(".row-stack")].map((el) =>
    el.querySelector(".t")?.textContent,
  );
  expect(ids).toHaveLength(BOT_DM_VISIBLE + 1);
  expect(host.querySelector(".row-stack.is-on")).toBeTruthy();
  close();
});

/** You cannot reply one away, so a permanent badge would just be noise. */
test("Bot to Bot rows carry no unread badge", () => {
  const { host, close } = open([
    aBotDirect({ id: "d-01", last_message: aMessage({ author: "bot-1" }) }),
  ]);
  expect(host.querySelector(".row-stack .unread-dot")).toBeNull();
  close();
});

test('mobile archive entry opens an empty archive and returns to active sessions', () => {
  const { host, close } = open([]);
  click(host.querySelector('.mobile-session-tools button'));
  expect(host.querySelector('.archived-empty-hint')?.textContent).toContain(t.sidebar.archivedEmpty);
  expect(host.querySelector('.mobile-session-tools button')?.textContent).toContain(t.sidebar.backToSessions);
  click(host.querySelector('.mobile-session-tools button'));
  expect(host.querySelector('.archived-empty-hint')).toBeNull();
  expect(host.querySelector('.groups')?.textContent).toContain('视频组');
  close();
});
