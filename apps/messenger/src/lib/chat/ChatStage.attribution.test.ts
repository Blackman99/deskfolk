import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { flushSync } from "svelte";
import { buttonByText, click, fill, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

test("actual transcript labels user/Bot multi-filings and undetermined messages, not app control lines", () => {
  const session = aDirect();
  const messages = [
    Object.assign(aMessage({ id: "user", session_id: session.id }), {
      filing_state: "filed", filings: [
        { task_id: "plan-a", ticket_id: null, part_key: "Shot 01–03" },
        { task_id: "plan-b", ticket_id: null, part_key: null },
      ],
    }),
    Object.assign(aMessage({ id: "bot", session_id: session.id, kind: "bot", author: "bot-1" }), {
      filing_state: "undetermined", filings: [],
    }),
    aMessage({ id: "control", session_id: session.id, control: { kind: "status_answer" } }),
  ];
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages }, { selectedId: session.id });
  const { host, close } = render(ChatStage, {
    runtime, t: copyFor("zh"), selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    expect(host.querySelector('[data-message-id="user"] .message-attribution')?.textContent).toContain("归到：plan-a · Shot 01–03、plan-b");
    expect(host.querySelector('[data-message-id="user"] .message-attribution button')?.textContent).toBe("改");
    expect(host.querySelector('[data-message-id="bot"] .message-attribution')?.textContent).toContain("未归属");
    expect(host.querySelector('[data-message-id="bot"] .message-attribution button')?.textContent).toBe("选");
    expect(host.querySelector('[data-message-id="control"] .message-attribution')).toBeNull();
  } finally { close(); }
});

for (const remote of [false, true]) {
  test(`actual ${remote ? "phone" : "local"} ChatStage saves attribution through runtime`, async () => {
    const session = aDirect();
    const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages: [aMessage({ session_id: session.id })] }, { selectedId: session.id, remote });
    runtime.attributionPlans = { [session.id]: [{ id: "plan-a", title: "EP01", tickets: [{ id: "ticket-a", title: "剪辑" }] }] };
    const { host, close } = render(ChatStage, { runtime, t: copyFor("en"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
    try {
      click(buttonByText(host, "Choose"));
      click(host.querySelector('input[value="plan-a"]'));
      const ticket = host.querySelector<HTMLSelectElement>('select[aria-label="Ticket · EP01"]')!;
      ticket.value = "ticket-a"; ticket.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
      fill(host.querySelector('input[aria-label="Part · EP01"]'), "Shot 01");
      click(buttonByText(host, "Save"));
      await Promise.resolve(); flushSync();
      expect(runtime.calls).toContainEqual({ name: "patchMessageAttribution", args: ["msg-1", [{ plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }]] });
      expect(runtime.calls.some((call) => call.name === "loadAttributionPlans" && call.args[0] === session.id)).toBe(true);
    } finally { close(); }
  });
}
