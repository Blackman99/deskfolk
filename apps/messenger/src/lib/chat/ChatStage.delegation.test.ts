import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { reactive } from "../test-reactive.svelte.ts";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { aDelegation } from "../test-delegations.ts";
import { render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

test("actual peer thread renders persisted request, real wait and reply without duplicating linked messages or interpreting discussion", () => {
  const session = aBotDirect();
  const waiting = aDelegation({ request_message_id: "linked-request" });
  const replied = aDelegation({ id: "delegation-2", ask: "审 Shot 12", status: "replied", wait: null,
    result_message_id: "linked-result", reply: { body: "2 通过 1 不通过", created_at: "2026-09-19T03:00:00.000Z", ref: "submission-fixture" } });
  const runtime = fakeRuntime({ bots: [aBot({ name: "导演" }), aBot({ id: "bot-2", name: "审片员" })], sessions: [session],
    delegations: [waiting, replied], messages: [
      aMessage({ id: "linked-request", session_id: session.id, kind: "bot", author: "bot-1", body: "审 Shot 11" }),
      aMessage({ id: "linked-result", session_id: session.id, kind: "bot", author: "bot-2", body: "2 通过 1 不通过" }),
      aMessage({ id: "discussion", session_id: session.id, kind: "bot", author: "bot-2", body: "收到。委派：普通讨论里写着等结果，并不建立等待。" }),
    ] }, { selectedId: session.id, loadDelegations: async () => {} });
  const { host, close } = render(ChatStage, { runtime, t: copyFor("zh"), selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    const records = host.querySelector('[aria-label="委派记录"]');
    expect(records).not.toBeNull();
    expect(records?.textContent).toContain("委派：审 Shot 11（等结果）");
    expect(records?.textContent).toContain("交回：2 通过 1 不通过");
    expect(records?.textContent).toContain("导演 → 审片员");
    expect(records?.querySelectorAll(".delegation-wait")).toHaveLength(1);
    expect(host.querySelectorAll('[data-message-id="linked-request"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-message-id="linked-result"]')).toHaveLength(0);
    expect(host.querySelector('[data-message-id="discussion"]')?.textContent).toContain("普通讨论里写着等结果");
    expect(host.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe("false");
  } finally { close(); }
});

test("stable visible thread only re-reads on snapshot epoch or connection change, not unrelated streaming updates", () => {
  const session = aBotDirect();
  const plain = fakeRuntime({ bots: [aBot(), aBot({ id: "bot-2" })], sessions: [session], delegations: [aDelegation()] }, { selectedId: session.id });
  const runtime = reactive(plain);
  const { host, close } = render(ChatStage, { runtime, t: copyFor("en"), selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  const reads = () => plain.calls.filter((call) => call.name === "loadDelegations");
  try {
    expect(reads()).toHaveLength(1);
    runtime.snapshot = { ...runtime.snapshot, sessions: [{ ...session, updated_at: "2026-09-19T03:00:00.000Z" }] }; flushSync();
    runtime.snapshot = { ...runtime.snapshot, messages: [aMessage({ session_id: session.id, kind: "bot", body: "ordinary discussion" })] }; flushSync();
    expect(reads()).toHaveLength(1);
    runtime.delegationSnapshotEpoch++; flushSync();
    expect(reads()).toHaveLength(2);
    runtime.delegationUnsupported = { [session.id]: true }; flushSync();
    expect(host.querySelector(".delegation-records")).toBeNull();
    expect(host.textContent).not.toContain(copyFor("en").delegation.loadFailed);
  } finally { close(); }
});
