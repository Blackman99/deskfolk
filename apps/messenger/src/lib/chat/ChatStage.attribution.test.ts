import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { flushSync } from "svelte";
import { buttonByText, click, fill, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const filed = (id: string, session: string, at: string, filings: { task_id: string; part_key?: string | null }[], over = {}) =>
  Object.assign(aMessage({ id, session_id: session, created_at: `2026-10-02T00:00:${at}.000Z`, ...over }), {
    filing_state: filings.length ? "filed" : "undetermined",
    filings: filings.map((row) => ({ ticket_id: null, part_key: null, ...row })),
  });

test("actual transcript tags the first line of each run, shows nothing on app control lines, and says 「一件事」 for a job not loaded", () => {
  const session = aDirect();
  const messages = [
    filed("user", session.id, "01", [{ task_id: "plan-a", part_key: "Shot 01–03" }, { task_id: "plan-b" }]),
    filed("same", session.id, "02", [{ task_id: "plan-a", part_key: "Shot 01–03" }, { task_id: "plan-b" }], { kind: "bot", author: "bot-1" }),
    filed("bot", session.id, "03", [], { kind: "bot", author: "bot-1" }),
    aMessage({ id: "control", session_id: session.id, created_at: "2026-10-02T00:00:04.000Z", control: { kind: "status_answer" } }),
  ];
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages }, { selectedId: session.id });
  const { host, close } = render(ChatStage, {
    runtime, t: copyFor("zh"), selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    const chip = (id: string) => host.querySelector(`[data-message-id="${id}"] .attribution-chip`);
    expect(chip("user")?.textContent).toContain("一件事");
    expect(chip("user")?.textContent).toContain("另 1 件");
    expect(chip("user")?.textContent).not.toContain("plan-a");
    expect(chip("same")).toBeNull();
    expect(chip("bot")?.textContent?.replace(/\s+/g, " ").trim()).toBe("未归属 · 选择归属");
    expect(host.querySelector('[data-message-id="control"] .attribution-chip')).toBeNull();
    expect(host.querySelector(".attribution-modal")).toBeNull();
  } finally { close(); }
});

for (const remote of [false, true]) {
  test(`actual ${remote ? "phone" : "local"} ChatStage changes attribution in a dialog and saves it through runtime`, async () => {
    const session = aDirect();
    const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages: [aMessage({ session_id: session.id })] }, { selectedId: session.id, remote });
    runtime.attributionPlans = { [session.id]: [{ id: "plan-a", title: "EP01", tickets: [{ id: "ticket-a", title: "剪辑" }] }] };
    const { host, close } = render(ChatStage, { runtime, t: copyFor("en"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
    try {
      click(host.querySelector(".attribution-chip"));
      expect(host.querySelector(".attribution-modal")).not.toBeNull();
      expect(host.querySelector(".message-attribution form")).toBeNull();
      click(buttonByText(host, "Show 1 other jobs"));
      click(host.querySelector('input[value="plan-a"]'));
      const ticket = host.querySelector<HTMLSelectElement>('select[aria-label="Ticket · EP01"]')!;
      ticket.value = "ticket-a"; ticket.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
      click(buttonByText(host, "Set a part"));
      fill(host.querySelector('input[aria-label="Part · EP01"]'), "Shot 01");
      click(buttonByText(host, "Save"));
      await Promise.resolve(); await Promise.resolve(); flushSync();
      expect(runtime.calls).toContainEqual({ name: "patchMessageAttribution", args: ["msg-1", [{ plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }]] });
      expect(runtime.calls.some((call) => call.name === "loadAttributionPlans" && call.args[0] === session.id)).toBe(true);
      expect(host.querySelector(".attribution-modal")).toBeNull();
    } finally { close(); }
  });
}

test("a line whose tag a run hides can still be changed from its right-click menu", async () => {
  const session = aDirect();
  const messages = [
    filed("first", session.id, "01", [{ task_id: "plan-a" }]),
    filed("second", session.id, "02", [{ task_id: "plan-a" }]),
  ];
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages }, { selectedId: session.id });
  runtime.attributionPlans = { [session.id]: [{ id: "plan-a", title: "EP01", tickets: [] }, { id: "plan-b", title: "海报", tickets: [] }] };
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    expect(host.querySelector('[data-message-id="second"] .attribution-chip')).toBeNull();
    const second = host.querySelector('[data-message-id="second"]')!;
    second.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    flushSync();
    click(buttonByText(host, "改归属…"));
    expect(host.querySelector(".msg-context-menu")).toBeNull();
    expect(host.querySelector(".attribution-modal")).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[value="plan-a"]')?.checked).toBe(true);
    click(buttonByText(host, "显示其他 1 件"));
    click(host.querySelector('input[value="plan-b"]'));
    click(buttonByText(host, "保存"));
    await Promise.resolve(); await Promise.resolve(); flushSync();
    expect(runtime.calls).toContainEqual({ name: "patchMessageAttribution", args: ["second", [{ plan_id: "plan-a" }, { plan_id: "plan-b" }]] });
  } finally { close(); }
});
