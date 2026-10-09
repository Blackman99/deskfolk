import { expect, test } from "bun:test";
import PlanSpecOverview from "./PlanSpecOverview.svelte";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";

const t = copyFor("zh");

test("the overview reads the tickets by state and the checks passed; a state opens the board on it", () => {
  const shown: string[] = [];
  const view = render(PlanSpecOverview, {
    t,
    ticketStates: [{ status: "todo", count: 3 }, { status: "doing", count: 1 }],
    checks: { pass: 1, total: 4 },
    onShowTickets: (status: string) => shown.push(status),
  } as never);
  expect(view.host.querySelector(".plan-overview-title")?.textContent).toBe(t.plan.spec.overview);
  const states = [...view.host.querySelectorAll<HTMLButtonElement>("button.plan-spec-ticket-state")];
  expect(states.map((state) => state.textContent?.replace(/\s+/g, ""))).toEqual(["待做3", "进行中1"]);
  click(states[1]);
  expect(shown).toEqual(["doing"]);
  expect(view.host.querySelector(".plan-overview-value")?.textContent).toBe("1/4");
  expect(view.host.querySelector<HTMLElement>(".plan-overview-meter-fill")?.style.width).toBe("25%");
  // The written progress counts itself under it; the overview no longer counts it again, nor explains itself in a paragraph.
  expect(view.host.querySelector(".plan-overview-count")).toBeNull();
  expect(view.host.querySelector(".plan-spec-ticket-states-hint")).toBeNull();
  expect(view.host.querySelector(".plan-spec-ticket-states-line")?.getAttribute("title")).toBe(t.plan.links.progressHint);
  view.close();
});

test("nothing to count leaves its row out: no tickets, no checks", () => {
  const view = render(PlanSpecOverview, {
    t,
    ticketStates: [],
    checks: { pass: 0, total: 0 },
  } as never);
  expect(view.host.querySelector(".plan-spec-ticket-states")).toBeNull();
  expect(view.host.querySelector(".plan-overview-meter")).toBeNull();
  view.close();
  const partial = render(PlanSpecOverview, { t, ticketStates: [], checks: { pass: 2, total: 2 } } as never);
  expect(partial.host.querySelector(".plan-overview-meter-fill")?.classList.contains("is-all")).toBe(true);
  partial.close();
});
