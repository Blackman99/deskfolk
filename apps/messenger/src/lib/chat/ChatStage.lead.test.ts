import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import ChatStage from "./ChatStage.svelte";

for (const remote of [false, true]) {
  test(`actual ${remote ? "phone" : "local"} group chat proposes by Bot name, never autosets; allows not-now, manual confirmation and clear`, async () => {
    const session = aGroup();
    const state = { session_id: session.id, confirmed_bot_id: null, suggestion: { bot_id: "bot-1", handoffs: 8, since: "2026-09-12T00:00:00Z" } };
    const plain = fakeRuntime({ bots: [aBot({ name: "导演" }), aBot({ id: "bot-2", name: "审片员" })], sessions: [session], messages: [aMessage()] }, { selectedId: session.id, remote });
    const runtime = reactive(plain);
    runtime.groupLeads = { [session.id]: state };
    const { host, close } = render(ChatStage, { runtime, t: copyFor("en"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
    try {
      expect(host.querySelector('.group-lead-card')?.textContent).toContain("导演");
      expect(host.textContent).toContain("8");
      expect(plain.calls.some((call) => call.name === "loadGroupLead")).toBe(true);
      expect(plain.calls.some((call) => call.name === "confirmGroupLead")).toBe(false);
      click(buttonByText(host, "Not now"));
      expect(plain.calls.some((call) => call.name === "confirmGroupLead")).toBe(false);
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Group lead"]');
      expect(select).not.toBeNull();
      select!.value = "bot-2"; select!.dispatchEvent(new Event("change", { bubbles: true })); flushSync();
      click(buttonByText(host, "Confirm lead"));
      await Promise.resolve(); flushSync();
      expect(plain.calls.some((call) => call.name === "confirmGroupLead" && call.args[0] === session.id && call.args[1] === "bot-2")).toBe(true);
      runtime.groupLeads = { [session.id]: { ...state, confirmed_bot_id: "bot-2" } }; flushSync();
      expect(host.textContent).toContain("Confirmed lead: 审片员");
      click(buttonByText(host, "Clear lead"));
      await Promise.resolve(); flushSync();
      expect(plain.calls.some((call) => call.name === "confirmGroupLead" && call.args[0] === session.id && call.args[1] === null)).toBe(true);
      runtime.groupLeadUnsupported = { [session.id]: true }; flushSync();
      expect(host.querySelector('.group-lead-card')).toBeNull();
    } finally { close(); }
  });
}
