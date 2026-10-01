/**
 * A line of yours that arrives while a Bot works (ADR 0040 P4a): it is a row in the turn's inbox,
 * and when it asks for a change the calls still waiting in that hop do not run.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionOk, CompletionRequest, JudgeResult, ToolCall } from "./completions";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function call(...toolCalls: ToolCall[]): CompletionOk {
  return { ok: true, content: "", toolCalls, finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

test("a change that arrives between tool calls defers the calls still waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-delivery-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: CompletionRequest[] = [];
  const bot = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const session = bot.direct_session.id;
  let sent = false;
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish() {},
    // After the first call returns, one line of yours arrives before the second is looked at.
    async betweenCalls() {
      if (sent) return;
      sent = true;
      const line = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "第二份先别写" });
      await engine.handleInboundMessage(line, { fromUser: true });
    },
    completions: {
      async complete(request) {
        seen.push(request);
        if (seen.length === 1) {
          return call(
            { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "first" }) },
            { id: "c2", name: "write_file", arguments: JSON.stringify({ path: "b.md", content: "second" }) },
          );
        }
        return call({ id: "c3", name: "end_turn", arguments: JSON.stringify({ inbox: [{ id: "U1", disposition: "adopted" }] }) });
      },
      async judge() {
        return judged("");
      },
    },
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "先写两份" });
  await engine.handleInboundMessage(trigger, { fromUser: true });
  await Bun.sleep(100);

  expect(await Bun.file(join(root, "a.md")).text()).toBe("first");
  expect(await Bun.file(join(root, "b.md")).exists()).toBe(false);
  const note = seen[1]?.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  expect(note).toContain("第二份先别写");
  expect(note).toContain("收件 1 条");
});
