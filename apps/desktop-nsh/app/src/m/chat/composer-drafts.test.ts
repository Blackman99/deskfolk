import "../../platform/install";
import { afterEach, expect, test } from "nsh/test";
import type { ClientEvent, RuntimeSnapshot } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { EventSync } from "../event-sync.ts";
import { MessengerRuntime } from "../runtime.svelte.ts";
import { aDirect, aMessage, aProjectSession } from "../test-fixtures.ts";
import { fakeApi } from "../test-mocks.ts";
import { clearComposerDrafts, loadComposerDraft, saveComposerDraft } from "./composer-drafts.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  clearComposerDrafts();
});

function makeRuntime(api?: object): MessengerRuntime {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  if (api) Reflect.set(runtime, "api", fakeApi(api));
  runtime.connection = "connected";
  return runtime;
}

test("drafts typed in Bot and project conversations survive a restart into a fresh runtime", () => {
  const first = makeRuntime();
  first.sessionView("direct-1").draft = "还没发出去的 Bot 消息\n带换行";
  first.sessionView("proj-1").draft = "重构 composer draft";

  // Simulate a sudden quit or dev reload: a brand new runtime reads the persisted storage.
  const restarted = makeRuntime();
  expect(restarted.sessionView("direct-1").draft).toBe("还没发出去的 Bot 消息\n带换行");
  expect(restarted.sessionView("proj-1").draft).toBe("重构 composer draft");
});

test("sending clears the persisted draft while a failed send keeps it across restart", async () => {
  const failing = makeRuntime({
    postMessage: async () => {
      throw new ApiError(422, "invalid_args", "refused");
    },
  });
  failing.sessionView("direct-1").draft = "发送失败也不能丢";
  expect(await failing.send({ sessionId: "direct-1" })).toBe(false);
  expect(loadComposerDraft("direct-1")).toBe("发送失败也不能丢");

  const restarted = makeRuntime({
    postMessage: async () => aMessage({ id: "m-1", session_id: "direct-1", body: "发送失败也不能丢" }),
  });
  expect(restarted.sessionView("direct-1").draft).toBe("发送失败也不能丢");
  expect(await restarted.send({ sessionId: "direct-1" })).toBe(true);
  expect(restarted.sessionView("direct-1").draft).toBe("");
  expect(loadComposerDraft("direct-1")).toBe("");

  const afterSend = makeRuntime();
  expect(afterSend.sessionView("direct-1").draft).toBe("");
});

test("session.removed forgets a conversation's stored draft", () => {
  const runtime = makeRuntime();
  runtime.sessionView("direct-1").draft = "要被删掉的会话草稿";
  saveComposerDraft("unopened-1", "从未点开但存过草稿");

  const ingest = (runtime as unknown as { ingest: (event: ClientEvent) => void }).ingest.bind(runtime);
  ingest({ event: "session.removed", id: "direct-1", occurred_at: "2026-11-25T00:00:00.000Z" });
  ingest({ event: "session.removed", id: "unopened-1", occurred_at: "2026-11-25T00:00:00.000Z" });

  expect(loadComposerDraft("direct-1")).toBe("");
  expect(loadComposerDraft("unopened-1")).toBe("");
});

test("installSnapshot prunes drafts for deleted conversations while keeping live ones", async () => {
  saveComposerDraft("direct-live", "留着");
  saveComposerDraft("proj-live", "项目会话也留着");
  saveComposerDraft("gone-offline", "离线期间删了");

  const runtime = makeRuntime({});
  const api = runtime.client!;
  const sync = new EventSync();
  Reflect.set(runtime, "sync", sync);
  sync.receive({ type: "ready", event_instance_id: "inst-1", watermark_seq: 1 });

  const snap: RuntimeSnapshot = {
    event_instance_id: "inst-1",
    watermark_seq: 1,
    settings: {
      locale: "zh",
      theme: "system",
      onboarding_completed: true,
      workspace_path: "/tmp/ws",
      endpoint_base_url: null,
      endpoint_models: [],
      endpoint_default_model: null,
      endpoint_key_set: false,
      providers: [],
      speech: null,
      spend_cap_usd: null,
    } as unknown as RuntimeSnapshot["settings"],
    bots: [],
    sessions: [aDirect({ id: "direct-live" }), aProjectSession({ id: "proj-live" })],
    turns: [],
    approvals: [],
    holds: [],
    holds_on: false,
    messages: [],
    pending_judgements: [],
    agent_runs: {},
  } as unknown as RuntimeSnapshot;

  const install = (runtime as unknown as {
    installSnapshot: (a: unknown, s: EventSync, sn: RuntimeSnapshot) => Promise<void>;
  }).installSnapshot.bind(runtime);
  await install(api, sync, snap);

  expect(runtime.sessionView("direct-live").draft).toBe("留着");
  expect(runtime.sessionView("proj-live").draft).toBe("项目会话也留着");
  expect(loadComposerDraft("gone-offline")).toBe("");
});
