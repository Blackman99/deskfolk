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

/** One Bot in your direct; each hop answers with the next scripted reply. */
async function harness(replies: CompletionOk[]) {
  const root = mkdtempSync(join(tmpdir(), "end-turn-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: CompletionRequest[] = [];
  const waiters: Array<() => void> = [];
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish(event) {
      if (event.event === "turn.upsert" && event.status === "completed") for (const wake of waiters.splice(0)) wake();
    },
    completions: {
      async complete(request) {
        seen.push(request);
        return replies[seen.length - 1] ?? say("");
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
  const bot = store.createBot({ name: "Reviewer", duties: "review cuts", boundaries: "stay in the workspace" });
  const session = bot.direct_session.id;
  const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "停工已对齐" });
  const done = new Promise<void>((resolve) => waiters.push(resolve));
  await engine.handleInboundMessage(trigger, { fromUser: true });
  await done;
  const botLines = store.db
    .query<{ body: string }, [string]>(`SELECT body FROM messages WHERE session_id = ? AND kind = 'bot' ORDER BY created_at`)
    .all(session)
    .map((row) => row.body);
  const cited = store.db
    .query<{ path: string }, [string]>(
      `SELECT a.workspace_relpath AS path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.session_id = ?`,
    )
    .all(session)
    .map((row) => row.path);
  const status = store.db
    .query<{ status: string }, [string]>(`SELECT status FROM turns WHERE session_id = ? ORDER BY created_at DESC`)
    .get(session)?.status;
  return { seen, botLines, cited, status, root };
}

function toolNames(request: CompletionRequest): string[] {
  return (request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
}

test("a turn offers end_turn, and calling it ends the turn with nothing posted", async () => {
  const h = await harness([call({ id: "c1", name: "end_turn", arguments: "{}" })]);
  expect(toolNames(h.seen[0]!)).toContain("end_turn");
  // No second hop: the turn is over once end_turn has run.
  expect(h.seen).toHaveLength(1);
  expect(h.botLines).toEqual([]);
  expect(h.status).toBe("completed");
});

test("end_turn waits for the other calls in its hop, then ends the turn", async () => {
  const h = await harness([
    call(
      { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "notes.md", content: "sealed" }) },
      { id: "c2", name: "end_turn", arguments: "{}" },
    ),
  ]);
  expect(h.seen).toHaveLength(1);
  expect(await Bun.file(join(h.root, "notes.md")).text()).toBe("sealed");
  // The file it wrote still goes out, on a line with no words of its own.
  expect(h.botLines).toEqual([""]);
  expect(h.cited).toEqual(["notes.md"]);
  expect(h.status).toBe("completed");
});
