import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { closeFullscreenPreview, fullscreenPreviewOpen } from "../overlays/fullscreen-preview.ts";
import { click, render } from "../test-render.ts";
import ProjectPlanCard from "./ProjectPlanCard.svelte";

const t = copyFor("zh");

function open(summary = "## 计划\n1. 改 **登录**，见 [文件](src/login.ts)") {
  const answers: boolean[] = [];
  const paths: string[] = [];
  const view = render(ProjectPlanCard, {
    t,
    approval: { kind_key: "plan", target: "/Users/a/.claude/plans/p.md", summary },
    disabled: false,
    onAnswer: (allow: boolean) => answers.push(allow),
    onOpenPath: (path: string) => paths.push(path),
  });
  const card = () => view.host.querySelector("[data-plan-card]")!;
  const toggle = () => view.host.querySelector("[data-plan-full-toggle]");
  const button = (text: string) => [...card().querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
  return { ...view, card, toggle, button, answers, paths };
}

// The list of full views is the module's: one left behind would answer the next test's Escape.
afterEach(() => {
  while (closeFullscreenPreview());
});

test("the plan takes the whole window and gives it back, the same plan and buttons", () => {
  const { card, toggle, button, close } = open();
  const plan = card().querySelector(".md-body");
  expect(toggle()?.getAttribute("aria-label")).toBe(t.project.planFullscreen);
  expect(card().querySelector(".plan-hint")?.textContent).toBe(t.project.planHint);

  click(toggle());
  expect(card().classList.contains("is-full")).toBe(true);
  expect(toggle()?.getAttribute("aria-label")).toBe(t.project.planExitFullscreen);
  expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  // Not drawn again: where you were reading stays where it was.
  expect(card().querySelector(".md-body")).toBe(plan);
  expect(button(t.project.planApprove)).not.toBeNull();
  // The composer is not under the whole window, so the hint does not point below.
  expect(card().querySelector(".plan-hint")?.textContent).toBe(t.project.planHintFull);

  click(toggle());
  expect(card().classList.contains("is-full")).toBe(false);
  expect(fullscreenPreviewOpen()).toBe(false);
  close();
});

test("Escape and Back close it first, the way they do a preview's full view", () => {
  const { card, toggle, close } = open();
  click(toggle());
  expect(fullscreenPreviewOpen()).toBe(true);
  expect(closeFullscreenPreview()).toBe(true);
  flushSync();
  expect(card().classList.contains("is-full")).toBe(false);
  expect(fullscreenPreviewOpen()).toBe(false);
  close();
});

test("answering from the whole window answers and goes back, where a failed answer is said", () => {
  const { card, toggle, button, answers, close } = open();
  click(toggle());
  click(button(t.project.planApprove));
  expect(answers).toEqual([true]);
  expect(card().classList.contains("is-full")).toBe(false);
  click(toggle());
  click(button(t.project.planKeep));
  expect(answers).toEqual([true, false]);
  expect(card().classList.contains("is-full")).toBe(false);
  close();
});

test("a file named in the plan opens behind the whole window, so it goes back first", () => {
  const { card, toggle, paths, close } = open();
  click(toggle());
  click(card().querySelector(".md-body a"));
  expect(paths).toEqual(["src/login.ts"]);
  expect(card().classList.contains("is-full")).toBe(false);
  close();
});

test("the plan answered elsewhere takes its whole window with it", () => {
  const { toggle, close } = open();
  click(toggle());
  expect(fullscreenPreviewOpen()).toBe(true);
  close();
  expect(fullscreenPreviewOpen()).toBe(false);
});

test("it holds the card's place in the conversation, so nothing under the window moves", () => {
  const { host, card, toggle, close } = open();
  Object.defineProperty(card(), "offsetHeight", { value: 321 });
  expect(host.querySelector(".plan-held")).toBeNull();
  click(toggle());
  expect(host.querySelector<HTMLElement>(".plan-held")?.style.height).toBe("321px");
  click(toggle());
  expect(host.querySelector(".plan-held")).toBeNull();
  close();
});

test("it goes into the top layer, out of any pane's transform, and comes back out", () => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const was = { show: proto.showPopover, hide: proto.hidePopover };
  const calls: string[] = [];
  let heldAtHide = false;
  let hostEl: HTMLElement | null = null;
  proto.showPopover = () => calls.push("show");
  proto.hidePopover = () => {
    calls.push("hide");
    heldAtHide = hostEl?.querySelector(".plan-held") !== null;
  };
  try {
    const { host, card, toggle, close } = open();
    hostEl = host;
    Object.defineProperty(card(), "offsetHeight", { value: 321 });
    click(toggle());
    expect(card().getAttribute("popover")).toBe("manual");
    expect(calls).toEqual(["show"]);
    click(toggle());
    expect(card().hasAttribute("popover")).toBe(false);
    expect(calls).toEqual(["show", "hide"]);
    // Its place goes only once it is back: a moment with neither shortens the transcript, and
    // the conversation's scroll position does not come back from that.
    expect(heldAtHide).toBe(true);
    expect(host.querySelector(".plan-held")).toBeNull();
    close();
  } finally {
    proto.showPopover = was.show;
    proto.hidePopover = was.hide;
  }
});

test("a plan with nothing in it has nothing to enlarge", () => {
  const { card, toggle, close } = open("  ");
  expect(toggle()).toBeNull();
  expect(card().querySelector(".plan-empty")?.textContent).toBe(t.project.planEmpty);
  close();
});
