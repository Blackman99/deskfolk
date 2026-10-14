import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const filed = (id: string, session: string, at: string, filings: { task_id: string; part_key?: string | null }[], over = {}) =>
  Object.assign(aMessage({ id, session_id: session, created_at: `2026-10-14T00:00:${at}.000Z`, ...over }), {
    filing_state: filings.length ? "filed" : "undetermined",
    filings: filings.map((row) => ({ ticket_id: null, part_key: null, ...row })),
  });

// Where a line is filed is the app's own (2026-10-14): the conversation does not show it and offers
// no way to change it; a line's flow is where it is seen.
test("no line says where it is filed, and its menu offers no way to change it, only its flow", async () => {
  const session = aDirect();
  const messages = [
    filed("mine", session.id, "01", [{ task_id: "plan-a", part_key: "Shot 01" }]),
    filed("theirs", session.id, "02", [], { kind: "bot", author: "bot-1" }),
  ];
  const runtime = fakeRuntime({ bots: [aBot()], sessions: [session], messages }, { selectedId: session.id });
  runtime.attributionPlans = { [session.id]: [{ id: "plan-a", title: "EP01", tickets: [] }] };
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session, onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    await tick(); flushSync();
    for (const id of ["mine", "theirs"]) {
      const row = host.querySelector(`[data-message-id="${id}"]`)!;
      expect(row.querySelector(".attribution-chip, .message-attribution")).toBeNull();
      expect(row.textContent).not.toContain("EP01");
      expect(row.textContent).not.toContain("归属");
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      flushSync();
      const menu = host.querySelector(".msg-context-menu")!;
      expect(menu.textContent).not.toContain("归属");
      expect(menu.querySelector('[data-job-view="trace"]')).not.toBeNull();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      flushSync();
    }
    expect(host.querySelector(".attribution-modal")).toBeNull();
    // Nothing in this conversation names a job, so its job list is never asked for.
    expect(runtime.calls.some((call) => call.name === "loadAttributionPlans")).toBe(false);
  } finally { close(); }
});
