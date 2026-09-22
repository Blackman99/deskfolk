import { expect, test } from "bun:test";
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

test("mobile details and model log actions close the menu", () => {
  const { host, runtime, toggled, close } = openHeader();
  click(host.querySelector(".btn-mobile-actions"));
  click(host.querySelectorAll(".mobile-actions-menu button")[2]);
  expect(toggled).toEqual(["settings"]);
  expect(host.querySelector(".mobile-actions-menu")).toBeNull();
  click(host.querySelector(".btn-mobile-actions"));
  click(host.querySelectorAll(".mobile-actions-menu button")[1]);
  expect(runtime.calls.some((call) => call.name === "toggleRouteLog")).toBe(true);
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
