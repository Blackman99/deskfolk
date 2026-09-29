import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, CompletionOk, JudgeResult } from "./completions";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";
import { emptyReplyNote } from "./turn-pace";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

/** One Bot in your direct; each hop answers with the next scripted reply. */
async function harness(replies: CompletionOk[]) {
  const root = mkdtempSync(join(tmpdir(), "empty-reply-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: ChatMessage[][] = [];
  const waiters: Array<() => void> = [];
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish(event) {
      if (event.event === "turn.upsert" && event.status === "completed") for (const wake of waiters.splice(0)) wake();
    },
    completions: {
      async complete(request) {
        seen.push(request.messages);
        return replies[seen.length - 1] ?? say("");
      },
      async judge() {
        // Organizer, route pick and closing check all fail open on an unreadable answer.
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
  const bot = store.createBot({ name: "Analyst", duties: "write the report", boundaries: "stay in the workspace" });
  const session = bot.direct_session.id;
  const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "把 report.md 写出来" });
  const done = new Promise<void>((resolve) => waiters.push(resolve));
  await engine.handleInboundMessage(trigger, { fromUser: true });
  await done;
  const botLines = store.db
    .query<{ body: string }, [string]>(`SELECT body FROM messages WHERE session_id = ? AND kind = 'bot' ORDER BY created_at`)
    .all(session)
    .map((row) => row.body);
  return { seen, botLines };
}

function lastUserLine(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]!;
  expect(last.role).toBe("user");
  return typeof last.content === "string" ? last.content : "";
}

test("an empty reply is answered with one note, and the reply after it reaches the session", async () => {
  const h = await harness([say(""), say("报告写好了，在 report.md")]);
  expect(h.seen).toHaveLength(2);
  // The empty answer is not kept in the loop; the note is the last thing the model sees.
  expect(lastUserLine(h.seen[1]!)).toBe(emptyReplyNote("zh"));
  expect(h.seen[1]!.some((message) => message.role === "assistant" && message.content === "")).toBe(false);
  expect(h.botLines).toEqual(["报告写好了，在 report.md"]);
});

test("a second empty reply ends the turn as before: no second note, nothing posted", async () => {
  const h = await harness([say(""), say("   ")]);
  expect(h.seen).toHaveLength(2);
  expect(h.botLines).toEqual([]);
});

test("a reply with words goes out on the first hop, with no note", async () => {
  const h = await harness([say("报告写好了")]);
  expect(h.seen).toHaveLength(1);
  expect(h.botLines).toEqual(["报告写好了"]);
});

test("the note reads in English for an English turn", () => {
  expect(emptyReplyNote("en")).toStartWith("(App note) Your last reply was empty");
  expect(emptyReplyNote("zh")).toStartWith("（应用提示）你刚才的回复是空的");
});
