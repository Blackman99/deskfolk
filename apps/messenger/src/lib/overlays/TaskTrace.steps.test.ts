/**
 * The app's own calls on the flow board (ADR 0083): drawn as steps between your line and the turns
 * it woke, opened in place with the model, prompt and answer, hidden with one press, the ones that
 * went wrong lit; and a line filed under no job as a board of its own.
 */
import { afterEach, expect, test } from "bun:test";
import type { TaskTrace, TraceStep } from "@real-bot/protocol";
import { forgetKeptBoards } from "./task-trace.ts";
import { forgetTraceMinimap } from "./trace-minimap.ts";
import { forgetSpentAsks } from "./trace-view.ts";
import { forgetTraceSteps } from "./trace-steps.ts";
import { click } from "../test-render.ts";
import { settle } from "../test-async.ts";
import { forgetStored } from "../storage.ts";
import { closeMessageText } from "../chat/message-text-pages.ts";
import { THEME_STORAGE_KEY, themeManager } from "../theme.ts";
import { open, picture, until } from "./task-trace-test-kit.ts";

afterEach(() => {
  forgetKeptBoards();
  forgetTraceMinimap();
  forgetSpentAsks();
  forgetTraceSteps();
});

function step(over: Partial<TraceStep>): TraceStep {
  return {
    id: "s1",
    role: "reader",
    prompt_id: "call.read_user_line",
    prompt_revision: null,
    prompt_locale: "zh",
    session_id: "group-1",
    message_id: "m1",
    turn_id: null,
    task_id: null,
    ticket_id: null,
    bot_id: null,
    check_run_id: null,
    provider_id: "p",
    model: "haiku-4.6",
    thinking_level: "minimal",
    outcome: "ok",
    fail_kind: null,
    verdict: { kind: "user_line", control: "none", control_only: false, status_only: false, objections: [], by_words: false },
    cached: false,
    spend_id: null,
    ms: 2300,
    created_at: "2026-09-22T00:00:00.300Z",
    ...over,
  };
}

/** The stock job with your line read, filed, and the picture judge failing the artist's hand-in. */
function stepped(): TaskTrace {
  return {
    ...picture(),
    steps: [
      step({}),
      step({ id: "s2", role: "organizer", prompt_id: "call.organizer", created_at: "2026-09-22T00:00:00.600Z",
        verdict: { kind: "organizer", mode: "message", decision: "continue", applied: true, reject_reason: null, organizer_run_id: "r1" } }),
      step({ id: "s3", role: "judge", prompt_id: "call.seams_image", message_id: null, task_id: "task-1", check_run_id: "run-1", created_at: "2026-09-22T00:00:03.000Z",
        model: "seer", verdict: { kind: "judge", mode: "image", passed: false, note: "1/2" } }),
    ],
  };
}

const stepCards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".trace-step")];

test("your line's reading and filing sit between it and the turn it woke, each saying what it concluded", async () => {
  const view = open({ trace: stepped(), pane: true });
  await until(view.host, ".trace-step");
  expect(stepCards(view.host).map((card) => [card.querySelector(".trace-step-title")?.textContent, card.querySelector(".trace-step-said")?.textContent])).toEqual([
    ["读你的话", "读成：普通的一句"],
    ["归档", "接着这件事"],
    ["看图判定 · 衔接", "没过 1/2"],
  ]);
  expect(stepCards(view.host)[2]!.classList.contains("is-anomalous")).toBe(true);
  // The turn your line woke hangs from the filing now, not from your card.
  const edges = view.host.querySelectorAll(".trace-edges path");
  expect(edges.length).toBe(5);
  view.close();
});

test("a step opens in a panel beside the board with its model, prompt and time, fetches its answer, and opens its call to change", async () => {
  const view = open({ trace: stepped(), pane: true });
  await until(view.host, ".trace-step");
  click(stepCards(view.host)[0]);
  await settle();
  const detail = view.host.querySelector(".trace-step-detail")!;
  // Over the stage, not in the card's slot on the board, which keeps its size.
  expect(view.host.querySelector(".trace-flow .trace-step-detail")).toBeNull();
  expect(detail.parentElement?.classList.contains("has-step-panel")).toBe(true);
  expect(stepCards(view.host)[0]!.classList.contains("is-open")).toBe(true);
  expect([...detail.querySelectorAll(".trace-step-chip")].map((chip) => chip.textContent?.trim())).toEqual(["haiku-4.6", "思考 minimal", "提示词 · 默认", "2.3 秒"]);
  const raw = detail.querySelector<HTMLDetailsElement>(".trace-step-raw")!;
  raw.open = true;
  raw.dispatchEvent(new Event("toggle"));
  await until(view.host, ".trace-step-raw pre");
  expect(view.host.querySelector(".trace-step-raw pre")?.textContent).toBe("原始回答 s1");
  expect(view.fetchedRuns).toEqual(["s1"]);
  click([...detail.querySelectorAll("button")].find((button) => button.textContent === "跳到这句"));
  expect(view.jumps).toEqual([["group-1", "m1"]]);
  click(detail.querySelector("[data-edit-call]"));
  expect(view.edited).toEqual(["reader"]);
  view.close();
});

test("another step takes the panel over, and on a phone Back puts it away before leaving the board", async () => {
  const view = open({ trace: stepped() });
  await until(view.host, ".trace-step");
  click(stepCards(view.host)[0]);
  await settle();
  click(stepCards(view.host)[1]);
  await settle();
  expect(view.host.querySelectorAll(".trace-step-detail").length).toBe(1);
  expect(view.host.querySelector(".trace-step-detail-title")?.textContent).toBe("归档");
  expect(closeMessageText()).toBe(true);
  await settle();
  expect(view.host.querySelector(".trace-step-detail")).toBeNull();
  expect(view.closed()).toBe(0);
  // Put away, it holds Back no longer: the next one is the board's.
  expect(closeMessageText()).toBe(false);
  view.close();
});

test("an answer that is JSON unfolds as a tree, light or dark as the app is", async () => {
  const before = themeManager.preference;
  const view = open({ trace: stepped(), pane: true, raw: () => '{"restates": false, "later": "先找能下的片源"}' });
  await until(view.host, ".trace-step");
  click(stepCards(view.host)[0]);
  await settle();
  const raw = view.host.querySelector<HTMLDetailsElement>(".trace-step-raw")!;
  raw.open = true;
  raw.dispatchEvent(new Event("toggle"));
  await until(view.host, ".trace-step-raw .view-struct");
  const tree = view.host.querySelector(".trace-step-raw .view-struct")!;
  expect([...tree.querySelectorAll(".property")].map((key) => key.textContent)).toEqual(["restates", "later"]);
  expect(view.host.querySelector(".trace-step-raw pre")).toBeNull();
  try {
    themeManager.setTheme("dark");
    await settle();
    expect(tree.classList.contains("sjd-theme-dark")).toBe(true);
    themeManager.setTheme("light");
    await settle();
    expect(tree.classList.contains("sjd-theme-light")).toBe(true);
  } finally {
    themeManager.setTheme(before);
    forgetStored(THEME_STORAGE_KEY);
    view.close();
  }
});

test("the steps hide with one press, and the ones that went wrong can be lit", async () => {
  const view = open({ trace: stepped(), pane: true });
  await until(view.host, ".trace-step");
  click(view.host.querySelector("[data-steps-lit]"));
  await settle();
  expect(stepCards(view.host).map((card) => card.classList.contains("is-lit"))).toEqual([false, false, true]);
  expect([...view.host.querySelectorAll(".trace-card")].every((card) => card.classList.contains("is-dim"))).toBe(true);
  click(view.host.querySelector("[data-steps-toggle]"));
  await settle();
  expect(stepCards(view.host)).toEqual([]);
  expect(view.host.querySelector("[data-steps-lit]")).toBeNull();
  view.close();
});

test("a line filed under no job opens as a board of its own, with no jobs to switch to", async () => {
  const line = picture().nodes[0]!;
  const view = open({
    pane: true,
    taskId: null,
    line: "m1",
    lineTrace: { message_id: "m1", session_id: "group-1", nodes: [line], steps: [step({ verdict: { kind: "user_line", control: "stop", control_only: true, status_only: false, objections: [], by_words: false } })] },
  });
  await until(view.host, ".trace-step");
  expect(view.host.querySelector(".trace-line-title")?.textContent).toBe("这句话 · 先出分镜");
  expect(view.host.querySelector(".trace-title-trigger")).toBeNull();
  expect(view.asked).toEqual([]);
  expect(stepCards(view.host)[0]!.querySelector(".trace-step-said")?.textContent).toBe("读成：停下");
  view.close();
});
