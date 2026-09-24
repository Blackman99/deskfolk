import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, USER_MEMBER } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import ChatHeader from "./ChatHeader.svelte";

const t = copyFor("zh");

function openHeader() {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  const toggled: string[] = [];
  const view = render(ChatHeader, {
    runtime,
    t,
    selected,
    pinnedSessionIds: [],
    onTogglePin: (id: string) => toggled.push(id),
    onToggleSessionSettings: () => toggled.push("settings"),
    onCreateBot: () => {},
    onShowOnboarding: () => {},
  });
  return { ...view, runtime, selected, toggled };
}

test("back has a navigation label and returns to the session list", () => {
  const { host, runtime, close } = openHeader();
  const back = host.querySelector(".btn-mobile-back");
  expect(back?.getAttribute("aria-label")).toBe(t.sidebar.backToSessions);
  click(back);
  expect(runtime.selectedId).toBeNull();
  close();
});

test("the identity area opens session details", () => {
  const { host, toggled, close } = openHeader();
  click(host.querySelector(".top-identity-btn"));
  expect(toggled).toEqual(["settings"]);
  expect(host.querySelector(".meta.is-direct-presence")).not.toBeNull();
  close();
});

test("mobile details action closes the menu, and the model log has no entry of its own", () => {
  const { host, toggled, close } = openHeader();
  click(host.querySelector(".btn-mobile-actions"));
  const items = [...host.querySelectorAll(".mobile-actions-menu button")].map((button) => button.textContent?.trim());
  // Model choices are read on the flow board's cards now.
  expect(items).not.toContain("模型选择记录");
  click(host.querySelectorAll(".mobile-actions-menu button")[2]);
  expect(toggled).toEqual(["settings"]);
  expect(host.querySelector(".mobile-actions-menu")).toBeNull();
  close();
});

test("mobile actions stay behind one menu trigger", () => {
  const { host, selected, toggled, close } = openHeader();
  const trigger = host.querySelector(".btn-mobile-actions");
  expect(trigger?.getAttribute("aria-label")).toBe(t.top.moreActions);
  expect(host.querySelector(".mobile-actions-menu")).toBeNull();

  click(trigger);
  const menu = host.querySelector(".mobile-actions-menu");
  expect(menu?.querySelectorAll("button")).toHaveLength(3);
  click(menu?.querySelector("button"));
  expect(toggled).toEqual([selected.id]);
  expect(host.querySelector(".mobile-actions-menu")).toBeNull();
  close();
});

test("the file conversation keeps its mark and hint beside the title, and offers no session actions", () => {
  const selected = aDirect({
    id: FILE_DROP_SESSION_ID,
    participants: [{ member: USER_MEMBER, joined_at: "2026-09-19T00:00:00.000Z", left_at: null }],
  });
  const runtime = reactive(fakeRuntime({ sessions: [selected] }));
  runtime.selectedId = selected.id;
  const viewport = (window as unknown as {
    happyDOM: { setViewport: (size: { width: number; height: number }) => void };
  }).happyDOM;
  const original = { width: window.innerWidth, height: window.innerHeight };
  viewport.setViewport({ width: 390, height: 844 });
  const { host, close } = render(ChatHeader, {
    runtime,
    t,
    selected,
    pinnedSessionIds: [],
    onTogglePin: () => {},
    onToggleSessionSettings: () => {},
    onCreateBot: () => {},
    onShowOnboarding: () => {},
  });
  try {
    const identity = host.querySelector(".top-file-identity") as HTMLElement;
    const title = identity.querySelector(".top-title-text") as HTMLElement;
    const hint = identity.querySelector(".meta") as HTMLElement;
    const back = host.querySelector(".btn-mobile-back") as HTMLElement;
    expect(title.textContent).toBe(t.sidebar.fileDrop);
    expect(hint.textContent).toBe(t.sidebar.fileDropHint);
    expect(identity.querySelector(".file-drop-mark")).not.toBeNull();
    expect(host.querySelector(".top-identity-btn")).toBeNull();
    expect(host.querySelector(".mobile-actions")).toBeNull();
    expect(host.querySelector(".top-actions")).toBeNull();

    const row = getComputedStyle(identity);
    const mark = getComputedStyle(identity.querySelector(".file-drop-mark")!);
    expect(row.display).toBe("flex");
    expect(row.alignItems).toBe("center");
    expect(row.flexDirection).toBe("row");
    expect(mark.flexShrink).toBe("0");
    expect(getComputedStyle(back).alignSelf).not.toBe("flex-start");
    expect(getComputedStyle(hint).whiteSpace).toBe("nowrap");
    expect(parseFloat(getComputedStyle(hint).fontSize)).toBeLessThan(parseFloat(getComputedStyle(title).fontSize));
  } finally {
    viewport.setViewport(original);
    close();
  }
});

test("a workbench pane's header shows the settings open in its own tab, not the runtime's drawer", () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  const { host, close } = render(ChatHeader, {
    runtime,
    t,
    selected,
    pinnedSessionIds: [],
    onTogglePin: () => {},
    onToggleSessionSettings: () => {},
    settingsOpen: true,
    onCreateBot: () => {},
    onShowOnboarding: () => {},
  });
  const titles = [...host.querySelectorAll<HTMLButtonElement>(".top-actions .btn-top-action")].map((b) => b.title);
  expect(titles).not.toContain("模型选择记录");
  const settings = [...host.querySelectorAll<HTMLButtonElement>(".top-actions .btn-top-action")].find((b) => b.title === t.top.botSettings)!;
  expect(settings.classList.contains("is-active")).toBe(true);
  expect(settings.getAttribute("aria-expanded")).toBe("true");
  close();
});

test("in a workbench pane the header is the one that folds into the tab once it is narrow", () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  const props = {
    runtime,
    t,
    selected,
    pinnedSessionIds: [],
    onTogglePin: () => {},
    onToggleSessionSettings: () => {},
    onCreateBot: () => {},
    onShowOnboarding: () => {},
  };
  const pane = render(ChatHeader, { ...props, foldsIntoTab: true });
  const phone = render(ChatHeader, props);
  try {
    expect(pane.host.querySelector(".top.folds-into-tab")).not.toBeNull();
    // The phone's header has no tab above it, so it stays.
    expect(phone.host.querySelector(".top.folds-into-tab")).toBeNull();
  } finally {
    pane.close();
    phone.close();
  }
});
