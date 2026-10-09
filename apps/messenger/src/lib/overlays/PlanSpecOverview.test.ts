import { expect, test } from "bun:test";
import PlanSpecOverview from "./PlanSpecOverview.svelte";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";

const t = copyFor("zh");

test("the overview reads the tickets by state, the checks passed and the written progress; a state opens the board on it", () => {
  const shown: string[] = [];
  const view = render(PlanSpecOverview, {
    t,
    ticketStates: [{ status: "todo", count: 3 }, { status: "doing", count: 1 }],
    checks: { pass: 1, total: 4 },
    progress: { done: 2, open: 1, blocked: 1 },
    onShowTickets: (status: string) => shown.push(status),
  } as never);
  expect(view.host.querySelector(".plan-overview-title")?.textContent).toBe(t.plan.spec.overview);
  const states = [...view.host.querySelectorAll<HTMLButtonElement>("button.plan-spec-ticket-state")];
  expect(states.map((state) => state.textContent?.replace(/\s+/g, ""))).toEqual(["待做3", "进行中1"]);
  click(states[1]);
  expect(shown).toEqual(["doing"]);
  expect(view.host.querySelector(".plan-overview-value")?.textContent).toBe("1/4");
  expect(view.host.querySelector<HTMLElement>(".plan-overview-meter-fill")?.style.width).toBe("25%");
  expect([...view.host.querySelectorAll(".plan-overview-count")].map((count) => count.textContent?.replace(/\s+/g, ""))).toEqual([
    `${t.plan.spec.done}2`,
    `${t.plan.spec.open}1`,
    `${t.plan.spec.blocked}1`,
  ]);
  view.close();
});

test("nothing to count leaves its row out: no checks, no progress written, nothing blocked", () => {
  const view = render(PlanSpecOverview, {
    t,
    ticketStates: [],
    checks: { pass: 0, total: 0 },
    progress: { done: 0, open: 0, blocked: 0 },
  } as never);
  expect(view.host.querySelector(".plan-spec-ticket-states")).toBeNull();
  expect(view.host.querySelector(".plan-overview-meter")).toBeNull();
  expect(view.host.querySelector(".plan-overview-counts")).toBeNull();
  view.close();
  const partial = render(PlanSpecOverview, { t, ticketStates: [], checks: { pass: 2, total: 2 }, progress: { done: 1, open: 0, blocked: 0 } } as never);
  expect(partial.host.querySelector(".plan-overview-meter-fill")?.classList.contains("is-all")).toBe(true);
  expect(partial.host.querySelector(".plan-overview-count.is-blocked")).toBeNull();
  partial.close();
});
