import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup, aHold, fakeRuntime } from "../test-fixtures.ts";
import type { Snapshot } from "../snapshot.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import Sidebar from "./Sidebar.svelte";

const t = copyFor("zh");

function open(over: Partial<Snapshot>, refusal: unknown = null) {
  // Recorded outside the runtime: reading `runtime.calls` between two presses would freeze it
  // through the reactive proxy.
  const pressed: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => {
    pressed.push([name, ...args]);
    return Promise.resolve(refusal);
  };
  const runtime = reactive(
    fakeRuntime(
      {
        bots: [aBot({ id: "bot-1", name: "视频导演" }), aBot({ id: "bot-2", name: "审片员" })],
        sessions: [aGroup({ id: "sess-1", name: "视频组" }), aDirect({ id: "direct-1" }), aDirect({ id: "direct-2", participants: [{ member: "user", joined_at: "2026-09-19T00:00:00.000Z", left_at: null }, { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null }] })],
        ...over,
      },
      { stopScope: record("stopScope"), liftHold: record("liftHold") },
    ),
  );
  const view = render(Sidebar, {
    runtime,
    t,
    selected: null,
    pinnedSessionIds: [],
    workspaceOpen: false,
    contextMenuSessionId: null,
    onOpenContextMenu: () => {},
    onToggleWorkspace: () => {},
    onOpenRoutines: () => {},
    onOpenSpend: () => {},
    workbench: true,
    onNewTerminal: () => {},
    onOpenSettings: () => {},
    onCreateBot: () => {},
    onCreateGroup: () => {},
    onOpenSearch: () => {},
  });
  return { ...view, runtime, pressed };
}

/** The tools menu's stop-everything item, checked to read `label` (a line under it says more). */
function everythingItem(host: HTMLElement, label: string): HTMLButtonElement {
  const item = host.querySelector<HTMLButtonElement>(".tools-menu-everything");
  expect(item && host.querySelector(`#${item.getAttribute("aria-labelledby")}`)?.textContent).toBe(label);
  return item!;
}

test("a stop you dropped a job with sits above the list with its lift; a plan parked before stops existed is not there", () => {
  const holds = [
    aHold({ id: "h-plan", scope: "plan", scope_id: "task-1", plan_title: "EP01", source: "user_text", action: "cancel" }),
    aHold({ id: "h-bot", scope: "bot", scope_id: "bot-1", action: "cancel" }),
    aHold({ id: "h-old", scope: "plan", scope_id: "task-2", source: "legacy" }),
  ];
  const { host, pressed, close } = open({ holds, holdsOn: true });
  try {
    const rows = [...host.querySelectorAll(".holds-row")];
    expect(rows.map((row) => row.querySelector(".holds-label")?.textContent)).toEqual(["「EP01」这件事", "视频导演的全部工作"]);
    expect(rows.map((row) => row.querySelector(".holds-tag")?.textContent)).toEqual(["作废", "作废"]);
    click(rows[0]!.querySelector(".holds-lift"));
    expect(pressed).toEqual([["liftHold", "h-plan"]]);
  } finally {
    close();
  }
});

test("a stop for now is never listed and marks no row: your next line is the end of it", () => {
  // ADR 0081: a stop is just a stop, as anywhere else; there is nothing to press to go on.
  const holds = [
    aHold({ id: "h-stop", scope: "bot_plan", scope_id: "bot-1:task-1", plan_title: "EP01", lift_on_next_user_message: true }),
    aHold({ id: "h-menu", scope: "bot", scope_id: "bot-2", lift_on_next_user_message: true }),
    aHold({ id: "h-group", scope: "session", scope_id: "sess-1", lift_on_next_user_message: true }),
    aHold({ id: "h-all", scope: "global", scope_id: null, lift_on_next_user_message: true }),
  ];
  const { host, close } = open({ holds, holdsOn: true });
  try {
    expect(host.querySelector(".holds")).toBeNull();
    expect(host.querySelector(".row-status.is-held")).toBeNull();
  } finally {
    close();
  }
});

test("the tools menu stops everything for now, and says so, with or without a stop in force", () => {
  const { host, runtime, pressed, close } = open({ holdsOn: true });
  try {
    click(host.querySelector(".tools-entry"));
    const item = everythingItem(host, "全部停下");
    expect(host.querySelector(`#${item.getAttribute("aria-describedby")}`)?.textContent).toBe("先停下：你再说话就接着");
    click(item);
    expect(pressed).toEqual([["stopScope", "global", null, null]]);
    runtime.snapshot = { ...runtime.snapshot, holds: [aHold({ id: "h-all", scope: "global", scope_id: null, lift_on_next_user_message: true })] };
    flushSync();
    click(host.querySelector(".tools-entry"));
    click(everythingItem(host, "全部停下"));
    expect(pressed.at(-1)).toEqual(["stopScope", "global", null, null]);
  } finally {
    close();
  }
});

test("a lift the daemon refuses is said on the row it was for", async () => {
  const { host, close } = open({ holdsOn: true, holds: [aHold({ id: "h-bot", scope: "bot", scope_id: "bot-1", action: "cancel" })] }, { status: 422 });
  try {
    click(host.querySelector(".holds-lift"));
    await tick();
    flushSync();
    expect(host.querySelector(".holds-row .holds-error")?.textContent).toBe("没做成，再试一次");
  } finally {
    close();
  }
});

test("with the daemon out of reach the tools menu's stop is shown but cannot be pressed", () => {
  const { host, runtime, pressed, close } = open({ holdsOn: true });
  try {
    runtime.connection = "disconnected";
    flushSync();
    click(host.querySelector(".tools-entry"));
    const item = host.querySelector<HTMLButtonElement>(".tools-menu-everything");
    expect(item?.disabled).toBe(true);
    click(item);
    expect(pressed).toEqual([]);
  } finally {
    close();
  }
});

test("before the daemon has stops there is no bar and no stop in the tools menu", () => {
  const { host, close } = open({ holds: [aHold({ action: "cancel" })], holdsOn: false });
  try {
    expect(host.querySelector(".holds")).toBeNull();
    click(host.querySelector(".tools-entry"));
    expect(host.querySelector(".tools-menu-everything")).toBeNull();
  } finally {
    close();
  }
});
