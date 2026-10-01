import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aMessage } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import MessageAttribution from "./MessageAttribution.svelte";

const plans = [
  { id: "plan-a", title: "EP01", tickets: [{ id: "ticket-a", title: "剪辑" }] },
  { id: "plan-b", title: "海报", tickets: [] },
];

test("correction selects multiple plans, optional ticket and part; failed save keeps label and draft, explicit unfile is empty filings", async () => {
  const saved: unknown[] = [];
  let refused = true;
  const { host, close } = render(MessageAttribution, {
    message: Object.assign(aMessage(), { filing_state: "filed", filings: [{ task_id: "plan-a", ticket_id: null, part_key: null }] }),
    plans, t: copyFor("zh"),
    onSave: async (filings: unknown) => { saved.push(filings); return refused ? new Error("not saved") : null; },
  });
  try {
    expect(host.textContent).toContain("归到：EP01");
    click(buttonByText(host, "改"));
    click(host.querySelector('input[type="checkbox"][value="plan-b"]'));
    const ticket = host.querySelector<HTMLSelectElement>('select[aria-label="任务 · EP01"]');
    expect(ticket).not.toBeNull();
    ticket!.value = "ticket-a";
    ticket!.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    fill(host.querySelector('input[aria-label="分件 · EP01"]'), "Shot 01–03");
    click(buttonByText(host, "保存"));
    await Promise.resolve(); flushSync();
    expect(saved[0]).toEqual([
      { plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01–03" },
      { plan_id: "plan-b" },
    ]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("未能保存");
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe("ticket-a");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="分件 · EP01"]')?.value).toBe("Shot 01–03");
    expect(host.querySelector<HTMLInputElement>('input[value="plan-b"]')?.checked).toBe(true);
    expect(host.textContent).toContain("归到：EP01");
    click(buttonByText(host, "移除归属"));
    refused = false;
    click(buttonByText(host, "保存"));
    await Promise.resolve(); flushSync();
    expect(saved[1]).toEqual([]);
    expect(host.querySelector('form')).toBeNull();
  } finally { close(); }
});

test("adding another filing within a plan permits separate parts and removes only the chosen row", async () => {
  const saved: unknown[] = [];
  const { host, close } = render(MessageAttribution, {
    message: aMessage({ filing_state: "filed", filings: [{ task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }] }),
    plans, t: copyFor("en"), onSave: async (filings: unknown) => { saved.push(filings); return null; },
  });
  try {
    click(buttonByText(host, "Change"));
    click(buttonByText(host, "Add another ticket or part"));
    const parts = host.querySelectorAll('input[aria-label="Part · EP01"]');
    expect(parts).toHaveLength(2);
    const ticket = host.querySelectorAll<HTMLSelectElement>('select')[1]!;
    ticket.value = "ticket-a"; ticket.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
    fill(parts[1], "Shot 02");
    click(buttonByText(host, "Save")); await Promise.resolve(); flushSync();
    expect(saved[0]).toEqual([{ plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }, { plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 02" }]);
    click(buttonByText(host, "Change"));
    click(buttonByText(host, "Add another ticket or part"));
    const nextTicket = host.querySelectorAll<HTMLSelectElement>('select')[1]!;
    nextTicket.value = "ticket-a"; nextTicket.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
    fill(host.querySelectorAll('input[aria-label="Part · EP01"]')[1], "Shot 03");
    click(host.querySelectorAll('button[aria-label="Remove filing"]')[0]);
    click(buttonByText(host, "Save")); await Promise.resolve(); flushSync();
    expect(saved[1]).toEqual([{ plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 03" }]);
  } finally { close(); }
});

for (const newTicket of ["", "ticket-b"]) {
  test(`changing ticket to ${newTicket || "whole plan"} clears stale part and plan-only part is disabled`, async () => {
    const saved: unknown[] = [];
    const { host, close } = render(MessageAttribution, {
      message: aMessage({ filing_state: "filed", filings: [{ task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }] }),
      plans: [{ ...plans[0]!, tickets: [...plans[0]!.tickets, { id: "ticket-b", title: "海报" }] }], t: copyFor("en"), onSave: async (filings: unknown) => { saved.push(filings); return null; },
    });
    try {
      click(buttonByText(host, "Change"));
      const ticket = host.querySelector<HTMLSelectElement>('select')!;
      ticket.value = newTicket; ticket.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
      const part = host.querySelector<HTMLInputElement>('input[aria-label="Part · EP01"]')!;
      expect(part.value).toBe("");
      expect(part.disabled).toBe(!newTicket);
      click(buttonByText(host, "Save")); await Promise.resolve(); flushSync();
      expect(saved[0]).toEqual(newTicket ? [{ plan_id: "plan-a", ticket_id: newTicket }] : [{ plan_id: "plan-a" }]);
    } finally { close(); }
  });
}

test("multiple filings within one plan keep their distinct ticket/part rows when corrected", async () => {
  const saved: unknown[] = [];
  const { host, close } = render(MessageAttribution, {
    message: aMessage({ filing_state: "filed", filings: [
      { task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" },
      { task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 02" },
    ] }), plans, t: copyFor("en"), onSave: async (filings: unknown) => { saved.push(filings); return null; },
  });
  try {
    click(buttonByText(host, "Change"));
    const parts = host.querySelectorAll('input[aria-label="Part · EP01"]');
    expect(parts).toHaveLength(2);
    fill(parts[1], "Shot 03");
    click(buttonByText(host, "Save")); await Promise.resolve(); flushSync();
    expect(saved[0]).toEqual([
      { plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" },
      { plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 03" },
    ]);
  } finally { close(); }
});
