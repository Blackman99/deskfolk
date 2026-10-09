import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aMessage } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import AttributionDialog from "./AttributionDialog.svelte";

const plans = [
  { id: "plan-a", title: "EP01", tickets: [{ id: "ticket-a", title: "剪辑" }, { id: "ticket-b", title: "调色" }] },
  { id: "plan-b", title: "海报", tickets: [] },
  { id: "plan-c", title: "把「你好」译成英文", tickets: [] },
];
const filed = (filings: { task_id: string; ticket_id?: string | null; part_key?: string | null }[]) =>
  Object.assign(aMessage(), { filing_state: "filed", filings: filings.map((row) => ({ ticket_id: null, part_key: null, ...row })) });

function open(message: ReturnType<typeof aMessage>, over: Record<string, unknown> = {}) {
  const saved: unknown[] = [];
  const state = { closed: 0, loads: 0, refuse: false };
  const view = render(AttributionDialog, {
    message, plans, t: copyFor("zh"),
    lastUsed: new Map([["plan-a", "2026-10-02T03:00:00.000Z"], ["plan-b", "2026-10-02T01:00:00.000Z"]]),
    onLoad: async () => { state.loads += 1; },
    onSave: async (filings: unknown) => { saved.push(filings); return state.refuse ? new Error("not saved") : null; },
    onClose: () => { state.closed += 1; },
    ...over,
  });
  const titles = (selector: string) => [...view.host.querySelectorAll(selector)].map((el) => el.textContent?.trim());
  const checkbox = (id: string) => view.host.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${id}"]`);
  const select = (label: string, value: string) => {
    const el = view.host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
  };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); flushSync(); };
  return { ...view, saved, state, titles, checkbox, select, settle };
}

test("opening loads the list; what is chosen is on top, this conversation's jobs next, and the rest are folded behind a count", () => {
  const { host, state, titles, checkbox, close } = open(filed([{ task_id: "plan-b" }]));
  try {
    expect(state.loads).toBe(1);
    expect(host.querySelector("h2")?.textContent).toBe("归到哪件事");
    expect(titles("h3")).toEqual(["已选", "这个会话里的"]);
    expect(checkbox("plan-b")!.checked).toBe(true);
    expect(titles(".plan-row .plan-title")).toEqual(["海报", "EP01"]);
    // This conversation's jobs say when they were last used, and how many tickets they have.
    expect(titles(".plan-row .plan-meta")[1]).toMatch(/^最近用过 .+ · 2 个任务$/);
    expect(checkbox("plan-c")).toBeNull();
    click(buttonByText(host, "显示其他 1 件"));
    expect(titles("h3")).toEqual(["已选", "这个会话里的", "其他事情（1）"]);
    expect(checkbox("plan-c")).not.toBeNull();
  } finally { close(); }
});

test("searching reaches every job at once, and says so when nothing matches", () => {
  const { host, titles, checkbox, close } = open(filed([]));
  try {
    expect(host.textContent).toContain("这句话不归到任何事。");
    fill(host.querySelector('input[type="search"]'), "你好");
    expect(titles(".plan-row .plan-title")).toEqual(["把「你好」译成英文"]);
    expect(checkbox("plan-c")).not.toBeNull();
    fill(host.querySelector('input[type="search"]'), "zzz");
    expect(host.textContent).toContain("没有匹配的事情");
    expect(host.querySelector(".plan-row")).toBeNull();
  } finally { close(); }
  const chosen = open(filed([{ task_id: "plan-a" }]));
  try {
    fill(chosen.host.querySelector('input[type="search"]'), "zzz");
    expect(chosen.host.textContent).toContain("没有匹配的事情");
    expect(chosen.checkbox("plan-a")!.checked).toBe(true);
  } finally { chosen.close(); }
});

test("choosing is a click on a row; a job with tickets then offers one, and a part only once a ticket is chosen", async () => {
  const { host, saved, state, checkbox, select, settle, close } = open(filed([]));
  try {
    click(checkbox("plan-a"));
    expect(host.querySelector('select[aria-label="任务 · EP01"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="分件 · EP01"]')).toBeNull();
    select("任务 · EP01", "ticket-a");
    expect(host.querySelector('input[aria-label="分件 · EP01"]')).toBeNull();
    click(buttonByText(host, "指定分件"));
    fill(host.querySelector('input[aria-label="分件 · EP01"]'), "Shot 01–03");
    click(checkbox("plan-b"));
    click(buttonByText(host, "保存"));
    await settle();
    expect(saved[0]).toEqual([{ plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01–03" }, { plan_id: "plan-b" }]);
    expect(state.closed).toBe(1);
  } finally { close(); }
});

test("a refused save says so, keeps the draft and stays open; the next try can go through", async () => {
  const { host, saved, state, checkbox, select, settle, close } = open(filed([{ task_id: "plan-a" }]));
  try {
    state.refuse = true;
    select("任务 · EP01", "ticket-b");
    click(checkbox("plan-b"));
    click(buttonByText(host, "保存"));
    await settle();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("未能保存");
    expect(state.closed).toBe(0);
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="任务 · EP01"]')?.value).toBe("ticket-b");
    expect(checkbox("plan-b")!.checked).toBe(true);
    state.refuse = false;
    click(buttonByText(host, "保存"));
    await settle();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual([{ plan_id: "plan-a", ticket_id: "ticket-b" }, { plan_id: "plan-b" }]);
    expect(state.closed).toBe(1);
  } finally { close(); }
});

test("Save waits for a change, and 「不归到任何事」 is a change that saves no filings", async () => {
  const { host, saved, state, settle, close } = open(filed([{ task_id: "plan-a" }]));
  try {
    const save = buttonByText(host, "保存");
    expect(save.disabled).toBe(true);
    const unfile = buttonByText(host, "不归到任何事");
    expect(unfile.disabled).toBe(false);
    click(unfile);
    expect(host.querySelector(".chosen-plan")).toBeNull();
    expect(host.textContent).toContain("这句话不归到任何事。");
    expect(buttonByText(host, "保存").disabled).toBe(false);
    click(buttonByText(host, "保存"));
    await settle();
    expect(saved).toEqual([[]]);
    expect(state.closed).toBe(1);
  } finally { close(); }
});

test("another filing in the same job takes its own ticket and part, and removing one keeps the other", async () => {
  const { host, saved, settle, close } = open(filed([{ task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }]), { t: copyFor("en") });
  try {
    click(buttonByText(host, "Add another ticket"));
    const tickets = host.querySelectorAll<HTMLSelectElement>('select[aria-label="Ticket · EP01"]');
    expect(tickets).toHaveLength(2);
    tickets[1]!.value = "ticket-b"; tickets[1]!.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
    // The first filing already has a part, so its field shows; the new one asks for it.
    expect(host.querySelectorAll('input[aria-label="Part · EP01"]')).toHaveLength(1);
    click(buttonByText(host, "Set a part"));
    const parts = host.querySelectorAll('input[aria-label="Part · EP01"]');
    expect(parts).toHaveLength(2);
    fill(parts[1], "Shot 02");
    click(buttonByText(host, "Save"));
    await settle();
    expect(saved[0]).toEqual([{ plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }, { plan_id: "plan-a", ticket_id: "ticket-b", part_key: "Shot 02" }]);
  } finally { close(); }
  const again = open(filed([{ task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }, { task_id: "plan-a", ticket_id: "ticket-b", part_key: "Shot 02" }]), { t: copyFor("en") });
  try {
    click(buttonByText(again.host, "Remove this one"));
    click(buttonByText(again.host, "Save"));
    await again.settle();
    expect(again.saved[0]).toEqual([{ plan_id: "plan-a", ticket_id: "ticket-b", part_key: "Shot 02" }]);
  } finally { again.close(); }
});

for (const newTicket of ["", "ticket-b"]) {
  test(`changing the ticket to ${newTicket || "the whole job"} drops the old part`, async () => {
    const { host, saved, select, settle, close } = open(filed([{ task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }]));
    try {
      select("任务 · EP01", newTicket);
      // The old part is dropped with the old ticket, and a new one is only asked for on request.
      expect(host.querySelector('input[aria-label="分件 · EP01"]')).toBeNull();
      expect(Boolean(host.querySelector("button.link") && [...host.querySelectorAll("button.link")].some((b) => b.textContent?.trim() === "指定分件"))).toBe(Boolean(newTicket));
      click(buttonByText(host, "保存"));
      await settle();
      expect(saved[0]).toEqual(newTicket ? [{ plan_id: "plan-a", ticket_id: newTicket }] : [{ plan_id: "plan-a" }]);
    } finally { close(); }
  });
}

test("a job that is not in the list any more stays chosen, under a neutral name, and untouched it needs no save", () => {
  const { host, checkbox, titles, close } = open(filed([{ task_id: "gone-plan" }]), { plans: [] });
  try {
    expect(checkbox("gone-plan")!.checked).toBe(true);
    expect(titles(".plan-row .plan-title")).toEqual(["一件事"]);
    expect(buttonByText(host, "保存").disabled).toBe(true);
  } finally { close(); }
});

test("Escape and Cancel close it without saving; a list that failed to load offers a retry", () => {
  const { host, saved, state, close } = open(filed([{ task_id: "plan-a" }]), { loadError: true });
  try {
    expect(host.textContent).toContain("未能载入事情列表。");
    click(buttonByText(host, "重试"));
    expect(state.loads).toBe(2);
    host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(state.closed).toBe(1);
    click(buttonByText(host, "取消"));
    expect(state.closed).toBe(2);
    expect(saved).toHaveLength(0);
  } finally { close(); }
});

test("disconnected, nothing can be changed", () => {
  const { host, checkbox, close } = open(filed([{ task_id: "plan-a" }]), { disabled: true });
  try {
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(buttonByText(host, "保存").disabled).toBe(true);
    expect(checkbox("plan-a")).not.toBeNull();
  } finally { close(); }
});

test("it names the line being filed, shortened, so a dialog reached from a menu still says which", () => {
  const long = "请把第三镜换成夜景，".repeat(30);
  const { host, close } = open(Object.assign(filed([{ task_id: "plan-a" }]), { body: `  ${long}\n\n 谢谢  ` }));
  try {
    const quote = host.querySelector(".attribution-context .quote")!.textContent!;
    expect(quote.startsWith("请把第三镜换成夜景，")).toBe(true);
    expect(quote.endsWith("…")).toBe(true);
    expect(quote.length).toBeLessThanOrEqual(151);
    expect(quote).not.toContain("\n");
  } finally { close(); }
  const empty = open(Object.assign(filed([]), { body: "" }));
  try {
    expect(empty.host.querySelector(".attribution-context .quote")?.textContent).toBe("（没有文字）");
  } finally { empty.close(); }
});

test("the quoted line reads as plain text, without its markdown", () => {
  const { host, close } = open(Object.assign(filed([]), { body: "**great demo**, but `not` sure\n\n- [how](https://x.y) to add" }));
  try {
    expect(host.querySelector(".attribution-context .quote")!.textContent).toBe("great demo, but not sure how to add");
  } finally { close(); }
});

test("Enter on a search takes the first match and clears the search; Arrow Down goes to the list; Enter on an empty search still saves", async () => {
  const { host, saved, checkbox, settle, close } = open(filed([]));
  try {
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    fill(search, "你好");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    search.dispatchEvent(enter);
    flushSync();
    expect(enter.defaultPrevented).toBe(true);
    expect(checkbox("plan-c")!.checked).toBe(true);
    expect(search.value).toBe("");
    fill(search, "zzz");
    const none = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    search.dispatchEvent(none);
    expect(none.defaultPrevented).toBe(true);
    expect(host.querySelectorAll(".chosen-plan")).toHaveLength(1);
    fill(search, "");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(host.querySelector(".plan-row input"));
    click(buttonByText(host, "保存"));
    await settle();
    expect(saved[0]).toEqual([{ plan_id: "plan-c" }]);
  } finally { close(); }
});
