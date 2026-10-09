/**
 * Built-in prompts you edited reach the model (ADR 0064): a Bot's turn sends your System section and
 * section notes, an app call sends your instructions with its fixed format and names the revision it
 * ran on, and an answer that does not read is counted against that revision.
 */
import { afterEach, expect, test } from "bun:test";
import type { CompletionsClient, JudgeRequest, JudgeResult } from "./completions";
import { assembleTurnMessages } from "./context";
import type { OrganizerRouting } from "./organizer";
import { savePromptText } from "./prompts/book";
import { SCRIBE_FORMAT } from "./prompts/scribe";
import { createScribe } from "./scribe";
import { Store } from "./store";

const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const ROUTING: OrganizerRouting = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", apiFormat: "openai", workspaceId: null, providerId: "p", providerName: "Default", model: "m", thinkingLevel: null };

function judged(content: string | null): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

test("a Bot's turn sends your System section and your section notes", () => {
  const store = new Store();
  stores.push(store);
  const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = bot.direct_session.id;
  const line = store.postMessage(session, { body: "hello" });
  const turn = store.createTurn({ sessionId: session, botId: bot.bot.id, triggerMessageId: line.id });
  store.rememberMemory({ bot_id: bot.bot.id, subject: "tone", body: "short", source_session_id: session, source_message_id: line.id });
  savePromptText(store, { id: "turn.system", locale: "en", text: "Answer in one sentence.", ifRevision: null, actor: "user" });
  savePromptText(store, { id: "turn.memory", locale: "en", text: "Your notes, newest last.", ifRevision: null, actor: "user" });
  const system = String(assembleTurnMessages(store, { sessionId: session, botId: bot.bot.id, turnId: turn.id, triggerMessageId: line.id, locale: "en", interrupt: false, loop: [] })[0]!.content);
  expect(system).toContain("# System\n\nAnswer in one sentence.");
  expect(system).toContain("# Memory\n\nYour notes, newest last.");
  expect(system).not.toContain("You are the Bot named in the profile above.");
  // The other language still gets the default.
  const zh = String(assembleTurnMessages(store, { sessionId: session, botId: bot.bot.id, turnId: turn.id, triggerMessageId: line.id, locale: "zh", interrupt: false, loop: [] })[0]!.content);
  expect(zh).toContain("你是上面人设里的那个 Bot。");
});

test("an app call sends your instructions with its format, names the revision, and an unreadable answer counts against it", async () => {
  const store = new Store();
  stores.push(store);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session.id;
  const opener = store.postMessage(direct, { body: "做 EP01 动画成片" });
  const planId = store.createTurn({ sessionId: direct, botId: director.bot.id, triggerMessageId: opener.id }).task_id!;
  const edit = savePromptText(store, { id: "call.scribe", locale: "zh", text: "你是书记员，只记用户自己的话。\n\n{format}", ifRevision: null, actor: "user" })!;
  const requests: JudgeRequest[] = [];
  const completions: CompletionsClient = {
    complete: () => Promise.reject(new Error("no turns here")),
    judge: async (request) => {
      requests.push(request);
      return judged("I would rather not.");
    },
  };
  const scribe = createScribe({ store, completions, routing: async () => ROUTING, recordSpend: () => {}, draining: () => false, log: () => {} });
  const line = store.postMessage(direct, { body: "机械臂必须是左手" });
  store.db.run("UPDATE messages SET task_id = ? WHERE id = ?", [planId, line.id]);
  await scribe.noteLine(line.id, scribe.handedOverAt());
  expect(requests).toHaveLength(1);
  expect(requests[0]!.prompt).toEqual({ id: "call.scribe", locale: "zh", revision_id: edit.id });
  expect(requests[0]!.messages[0]!.content).toBe(`你是书记员，只记用户自己的话。\n\n${SCRIBE_FORMAT}`);
  expect(store.promptParseFailures("call.scribe", "zh", edit.id)).toBe(1);
  expect(store.promptParseFailures("call.scribe", "zh", null)).toBe(0);
});
