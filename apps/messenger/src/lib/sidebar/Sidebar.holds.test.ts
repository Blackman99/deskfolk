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

test("your stops in force sit above the list, each with its lift; a plan parked before stops existed is not among them", () => {
  const holds = [
    aHold({ id: "h-plan", scope: "plan", scope_id: "task-1", plan_title: "EP01", source: "user_text" }),
    aHold({ id: "h-bot", scope: "bot", scope_id: "bot-1", action: "cancel" }),
    aHold({ id: "h-old", scope: "plan", scope_id: "task-2", source: "legacy" }),
  ];
  const { host, pressed, close } = open({ holds, holdsOn: true });
  try {
    const rows = [...host.querySelectorAll(".holds-row")];
    expect(rows.map((row) => row.querySelector(".holds-label")?.textContent)).toEqual(["「EP01」这件事", "视频导演的全部工作"]);
    expect(rows[1]!.querySelector(".holds-tag")?.textContent).toBe("作废");
    click(rows[0]!.querySelector(".holds-lift"));
    expect(pressed).toEqual([["liftHold", "h-plan"]]);
  } finally {
    close();
  }
});

test("every stop of yours is listed while it holds something, a Stop on a reply too, and says whom your word released", () => {
  // ADR 0071: a stop is only "stop for now"; the list is where you see a Bot is stopped and go on.
  const holds = [
    aHold({ id: "h-stop", scope: "bot_plan", scope_id: "bot-1:task-1", plan_title: "EP01", lift_on_next_user_message: true }),
    aHold({ id: "h-menu", scope: "bot", scope_id: "bot-2" }),
    aHold({ id: "h-all", scope: "global", scope_id: null, effect: { released_bots: ["bot-1"] } }),
  ];
  const { host, close } = open({ holds, holdsOn: true });
  try {
    expect([...host.querySelectorAll(".holds-row .holds-label")].map((label) => label.textContent)).toEqual([
      "视频导演在「EP01」上的工作",
      "审片员的全部工作",
      "所有 Bot 的工作（已放开 视频导演）",
    ]);
  } finally {
    close();
  }
});

test("a direct whose Bot you stopped, and a group you stopped, say so where their last line would be", () => {
  const { host, close } = open({ holds: [aHold({ scope: "bot", scope_id: "bot-1" }), aHold({ id: "h-2", scope: "session", scope_id: "sess-1" })], holdsOn: true });
  try {
    const held = [...host.querySelectorAll(".row-status.is-held")].map((status) => status.closest(".row")?.querySelector(".t")?.textContent);
    expect(held.sort()).toEqual(["视频导演", "视频组"]);
    expect(host.querySelector(".row-status.is-held .row-status-text")?.textContent).toBe("已叫停");
  } finally {
    close();
  }
});

test("the tools menu stops everything, and while everything is stopped lets it all go on", () => {
  const { host, runtime, pressed, close } = open({ holdsOn: true });
  try {
    click(host.querySelector(".tools-entry"));
    click(everythingItem(host, "全部停下"));
    expect(pressed).toEqual([["stopScope", "global", null, null]]);
    runtime.snapshot = { ...runtime.snapshot, holds: [aHold({ id: "h-all", scope: "global", scope_id: null })] };
    click(host.querySelector(".tools-entry"));
    click(everythingItem(host, "全部继续"));
    expect(pressed.at(-1)).toEqual(["liftHold", "h-all"]);
  } finally {
    close();
  }
});

test("the tools menu's stop says it stops for now and lets go of the Bot you speak to, and is there with nothing at work", () => {
  const { host, runtime, close } = open({ holdsOn: true });
  try {
    click(host.querySelector(".tools-entry"));
    const item = everythingItem(host, "全部停下");
    const hint = host.querySelector(`#${item.getAttribute("aria-describedby")}`);
    expect(hint?.textContent).toBe("先停下：对哪个 Bot 说话就放开哪个");
    expect(item.contains(hint)).toBe(true);
    runtime.snapshot = { ...runtime.snapshot, holds: [aHold({ id: "h-all", scope: "global", scope_id: null })] };
    flushSync();
    const goOn = everythingItem(host, "全部继续");
    expect(goOn.hasAttribute("aria-describedby")).toBe(false);
    expect(goOn.textContent?.trim()).toBe("全部继续");
  } finally {
    close();
  }
});

test("a stop or a lift the daemon refuses is said above the list, and on the row it was for", async () => {
  const { host, close } = open({ holdsOn: true, holds: [aHold({ id: "h-bot", scope: "bot", scope_id: "bot-1" })] }, { status: 422 });
  try {
    click(host.querySelector(".tools-entry"));
    click(everythingItem(host, "全部停下"));
    await tick();
    flushSync();
    expect(host.querySelector(".holds-failed")?.textContent).toBe("没做成，再试一次");
    click(host.querySelector(".holds-lift"));
    await tick();
    flushSync();
    expect(host.querySelector(".holds-row .holds-error")?.textContent).toBe("没做成，再试一次");
  } finally {
    close();
  }
});

test("the tools menu's refusal goes once everything is stopped or let go some other way", async () => {
  const { host, runtime, close } = open({ holdsOn: true }, { status: 422 });
  try {
    click(host.querySelector(".tools-entry"));
    click(everythingItem(host, "全部停下"));
    await tick();
    flushSync();
    expect(host.querySelector(".holds-failed")).not.toBeNull();
    // Stopped from the menu bar meanwhile: the note would no longer be true.
    runtime.snapshot = { ...runtime.snapshot, holds: [aHold({ id: "h-all", scope: "global", scope_id: null })] };
    flushSync();
    expect(host.querySelector(".holds-failed")).toBeNull();
    // And lifted again: back where the refused press left things, but nobody pressed again.
    runtime.snapshot = { ...runtime.snapshot, holds: [] };
    flushSync();
    expect(host.querySelector(".holds-failed")).toBeNull();
    runtime.snapshot = { ...runtime.snapshot, holds: [aHold({ id: "h-all", scope: "global", scope_id: null })] };
    flushSync();

    click(host.querySelector(".tools-entry"));
    click(everythingItem(host, "全部继续"));
    await tick();
    flushSync();
    expect(host.querySelector(".holds-failed")).not.toBeNull();
    // Lifted from its row, or from the menu bar.
    runtime.snapshot = { ...runtime.snapshot, holds: [] };
    flushSync();
    expect(host.querySelector(".holds-failed")).toBeNull();
    runtime.snapshot = { ...runtime.snapshot, holds: [aHold({ id: "h-all", scope: "global", scope_id: null })] };
    flushSync();
    expect(host.querySelector(".holds-failed")).toBeNull();
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

test("before the daemon has stops there is no bar, no marks and no stop in the tools menu", () => {
  const { host, close } = open({ holds: [aHold()], holdsOn: false });
  try {
    expect(host.querySelector(".holds")).toBeNull();
    expect(host.querySelector(".row-status.is-held")).toBeNull();
    click(host.querySelector(".tools-entry"));
    expect(host.querySelector(".tools-menu-everything")).toBeNull();
  } finally {
    close();
  }
});
