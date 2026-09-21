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
