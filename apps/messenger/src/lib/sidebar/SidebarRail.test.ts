import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, type SessionSummary } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aMessage, anApproval, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import SidebarRail from "./SidebarRail.svelte";

const t = copyFor("en");

function open(selectedId: string | null = null) {
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
    sessions: [
      aGroup({ id: "sess-1", name: "Video crew" }),
      aGroup({ id: "sess-old", name: "Old crew", archived_at: "2026-09-20T00:00:00.000Z" }),
      aDirect({ id: "direct-1", unread_count: 4 }),
      aDirect({ id: "direct-pin", participants: [
        { member: "user", joined_at: "t", left_at: null },
        { member: "bot-2", joined_at: "t", left_at: null },
      ] }),
      aDirect({
        id: FILE_DROP_SESSION_ID,
        participants: [{ member: "user", joined_at: "t", left_at: null }],
        last_message: aMessage({ body: "shot.png", session_id: FILE_DROP_SESSION_ID }),
      }),
      aBotDirect(),
    ],
    turns: [aTurn({ id: "turn-1", session_id: "sess-1", status: "waiting_approval" })],
    approvals: [anApproval({ turn_id: "turn-1" }), anApproval({ id: "appr-2", turn_id: "turn-1" })],
  });
  runtime.selectedId = selectedId;
  const menus: string[] = [];
  let expanded = 0;
  let settings = 0;
  const view = render(SidebarRail, {
    runtime,
    t,
    pinnedSessionIds: ["direct-pin"],
    contextMenuSessionId: null,
    onOpenContextMenu: (_e: MouseEvent, session: SessionSummary) => menus.push(session.id),
    onExpand: () => (expanded += 1),
    onOpenSettings: () => (settings += 1),
  });
  return { ...view, runtime, menus, expanded: () => expanded, settings: () => settings };
}

const item = (host: HTMLElement, id: string) => host.querySelector(`.rail-item[data-session="${id}"]`) as HTMLElement | null;

test("the rail keeps the list's order and sections, avatars only, and leaves out what the list leaves out", () => {
  const view = open("direct-1");
  const ids = [...view.host.querySelectorAll<HTMLElement>(".rail-item")].map((el) => el.dataset.session);
  expect(ids).toEqual(["direct-pin", FILE_DROP_SESSION_ID, "sess-1", "direct-1", "botbot-1"]);
  expect(view.host.querySelectorAll(".rail-divider")).toHaveLength(4);
  expect(item(view.host, "sess-old")).toBeNull();
  // Names live in the tooltip; nothing but the picture is drawn.
  expect(item(view.host, "sess-1")?.getAttribute("title")).toBe("Video crew");
  expect(item(view.host, "sess-1")?.querySelector(".row-avatar")).not.toBeNull();
  expect(item(view.host, "direct-1")?.getAttribute("aria-current")).toBe("true");
  expect(item(view.host, "direct-1")?.classList.contains("is-on")).toBe(true);
  view.close();
});

test("what waits on you outranks what is unread, and both are on the avatar", () => {
  const view = open();
  const waiting = item(view.host, "sess-1")?.querySelector(".rail-badge");
  expect(waiting?.classList.contains("is-waiting")).toBe(true);
  expect(waiting?.textContent).toBe("2");
  const unread = item(view.host, "direct-1");
  expect(unread?.querySelector(".rail-badge:not(.is-waiting)")?.textContent).toBe("4");
  expect(unread?.getAttribute("aria-label")).toBe(`${unread?.getAttribute("title")} · ${t.sidebar.unread} 4`);
  expect(item(view.host, "direct-pin")?.querySelector(".rail-badge")).toBeNull();
  view.close();
});

test("an avatar opens its conversation or its menu, and the rail's buttons expand the list or open settings", () => {
  const view = open();
  click(item(view.host, "sess-1"));
  expect(view.runtime.calls.filter((call) => call.name === "selectSession").map((call) => call.args[0])).toEqual(["sess-1"]);
  item(view.host, "direct-1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(view.menus).toEqual(["direct-1"]);
  const expand = view.host.querySelector(".rail-expand") as HTMLElement;
  expect(expand.getAttribute("aria-label")).toBe(t.sidebar.show);
  click(expand);
  expect(view.expanded()).toBe(1);
  click(view.host.querySelector(".rail-settings"));
  expect(view.settings()).toBe(1);
  view.close();
});
