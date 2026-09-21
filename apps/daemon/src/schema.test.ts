import { describe, expect, test } from "bun:test";
import { generateBoringAvatar } from "@real-bot/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_AGE_MAX, MEMORY_DIGEST_LIMIT, memoryEntryCost } from "./context";
import { Store } from "./store";
import {
  MEMORY_BODY_MAX,
  MEMORY_MAX_PER_BOT,
  MEMORY_SUBJECT_MAX,
} from "./store/memories";
import { memoryKeyStore } from "./secrets";

describe("schema", () => {
  test("opens an empty database with the locked tables", () => {
    const store = new Store();
    const names = store.db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "allow_rules",
      "approvals",
      "attachments",
      "bots",
      "judgements",
      "mcp_servers",
      "memories",
      "messages",
      "profile_revisions",
      "providers",
      "reactions",
      "route_feedback",
      "route_learned",
      "route_reviews",
      "routines",
      "session_participants",
      "sessions",
      "settings",
      "skills",
      "spend",
      "tasks",
      "turn_route_decisions",
      "turns",
    ]);
    store.close();
  });

  test("alive bot names are unique; deleted names stay taken", () => {
    const store = new Store();
    const a = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    expect(() => store.createBot({ name: "Writer", duties: "x", boundaries: "y" })).toThrow();
    store.deleteBot(a.bot.id);
    expect(() => store.createBot({ name: "Writer", duties: "x", boundaries: "y" })).toThrow();
    store.close();
  });

  test("creating a bot also opens the you↔bot direct session", () => {
    const store = new Store();
    const created = store.createBot({ name: "Researcher", duties: "read", boundaries: "stay" });
    expect(created.bot.model).toBeNull();
    const cols = store.db
      .query<{ name: string }, []>(`PRAGMA table_info(bots)`)
      .all()
      .map((row) => row.name);
    expect(cols).toContain("model");
    expect(cols).toContain("avatar");
    expect(cols).toContain("thinking_level");
    expect(created.bot.thinking_level).toBeNull();
    expect(created.bot.avatar).toBeString();
    expect(created.bot.avatar?.startsWith("<svg")).toBe(true);
    expect(created.bot.id).toHaveLength(26);
    expect(created.direct_session.id).toHaveLength(26);
    expect(created.direct_session.kind).toBe("direct");
    expect(created.direct_session.name).toBeNull();
    const members = created.direct_session.participants.map((p) => p.member).sort();
    expect(members).toEqual(["user", created.bot.id].sort());
    const sessionCols = store.db
      .query<{ name: string }, []>(`PRAGMA table_info(sessions)`)
      .all()
      .map((row) => row.name);
    const mcpCols = store.db
      .query<{ name: string }, []>(`PRAGMA table_info(mcp_servers)`)
      .all()
      .map((row) => row.name);
    expect(mcpCols).toContain("instructions");
    expect(mcpCols).toContain("usage_note");
    expect(mcpCols).toContain("tool_catalog");
    const skillCols = store.db
      .query<{ name: string }, []>(`PRAGMA table_info(skills)`)
      .all()
      .map((row) => row.name);
    expect(skillCols).toContain("uses");
    expect(mcpCols).toContain("transport");
    expect(mcpCols).toContain("url");
    expect(mcpCols).toContain("headers");
    const approvalCols = store.db
      .query<{ name: string }, []>(`PRAGMA table_info(approvals)`)
      .all()
      .map((row) => row.name);
    expect(approvalCols).toContain("requires_api_key");
    const providerCols = store.db
      .query<{ name: string }, []>(`PRAGMA table_info(providers)`)
      .all()
      .map((row) => row.name);
    expect(providerCols).toContain("available_models");
    expect(sessionCols).toContain("last_read_at");
    expect(created.direct_session.last_read_at).toBeString();
    expect(created.direct_session.unread_count).toBe(0);
    store.close();
  });

  test("unread counts main-transcript messages from others after last_read_at", () => {
    const store = new Store();
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const sessionId = created.direct_session.id;
    store.markSessionRead(sessionId, "2000-01-01T00:00:00.000Z");
    store.insertMessage({
      sessionId,
      kind: "user",
      author: "user",
      body: "hello",
    });
    const botMsg = store.insertMessage({
      sessionId,
      kind: "bot",
      author: created.bot.id,
      body: "done",
    });
    store.insertMessage({
      sessionId,
      parentId: botMsg.id,
      kind: "user",
      author: "user",
      body: "thread",
    });
    expect(store.unreadCount(sessionId)).toBe(1);
    expect(store.listSessions().find((s) => s.id === sessionId)?.unread_count).toBe(1);
    store.markSessionRead(sessionId);
    expect(store.unreadCount(sessionId)).toBe(0);
    store.insertMessage({
      sessionId,
      kind: "bot",
      author: created.bot.id,
      body: "later",
    });
    expect(store.unreadCount(sessionId)).toBe(1);
    store.close();
  });

  test("bot avatar defaults to boringavatars and supports custom avatar", () => {
    const store = new Store();
    const botDefault = store.createBot({ name: "DefaultAvatarBot", duties: "test", boundaries: "test" });
    expect(botDefault.bot.avatar).toBeString();
    expect(botDefault.bot.avatar).toContain("<svg");
    expect(botDefault.bot.avatar).toBe(generateBoringAvatar({ name: "DefaultAvatarBot" }));
    const other = store.createBot({ name: "OtherAvatarBot", duties: "test", boundaries: "test" });
    expect(other.bot.avatar).toBe(generateBoringAvatar({ name: "OtherAvatarBot" }));
    expect(other.bot.avatar).not.toBe(botDefault.bot.avatar);

    const custom = "data:image/jpeg;base64,/9j/4AAQ";
    const botCustom = store.createBot({
      name: "CustomAvatarBot",
      duties: "test",
      boundaries: "test",
      avatar: custom,
    });
    expect(botCustom.bot.avatar).toBe(custom);

    // Patch with a new uploaded data URI
    const updated = store.patchBot(botCustom.bot.id, {
      avatar: "data:image/jpeg;base64,/9j/updated",
    });
    expect(updated.avatar).toBe("data:image/jpeg;base64,/9j/updated");

    // Patch with empty/null resets/regenerates default boring avatar
    const regenerated = store.patchBot(botCustom.bot.id, { avatar: "" });
    expect(regenerated.avatar).toContain("<svg");
    expect(regenerated.avatar).toBe(generateBoringAvatar({ name: "CustomAvatarBot" }));

    store.close();
  });

  test("clearSessionMessages clears messages, turns, and judgements for that session", () => {
    const store = new Store();
    const b1 = store.createBot({ name: "BotOne", duties: "one", boundaries: "none" });
    const b2 = store.createBot({ name: "BotTwo", duties: "two", boundaries: "none" });
    const group = store.createGroup({ name: "WorkGroup", members: [b1.bot.id, b2.bot.id] });
    const msg = store.postMessage(group.id, { body: "Hello group" });
    const turn = store.createTurn({ sessionId: group.id, botId: b1.bot.id, triggerMessageId: msg.id });
    store.putReaction(msg.id, "👍");

    expect(store.listMessages(group.id).items).toHaveLength(1);
    expect(store.listLiveTurns({ sessionId: group.id })).toHaveLength(1);

    store.clearSessionMessages(group.id);

    expect(store.listMessages(group.id).items).toHaveLength(0);
    expect(store.listLiveTurns({ sessionId: group.id })).toHaveLength(0);
    // Session still exists
    expect(store.getSession(group.id).id).toBe(group.id);

    store.close();
  });

  test("clearSessionMessages and deleteSession succeed when the session has a route review", () => {
    const store = new Store();
    const b1 = store.createBot({ name: "BotOne", duties: "one", boundaries: "none" });
    const b2 = store.createBot({ name: "BotTwo", duties: "two", boundaries: "none" });
    const group = store.createGroup({ name: "WorkGroup", members: [b1.bot.id, b2.bot.id] });
    const msg = store.postMessage(group.id, { body: "Hello group" });
    const turn = store.createTurn({
      sessionId: group.id,
      botId: b1.bot.id,
      triggerMessageId: msg.id,
    });
    store.recordRouteReview({
      botId: b1.bot.id,
      chainId: turn.id,
      turnId: turn.id,
      sessionId: group.id,
      signature: "coding",
      model: "code-pro",
      thinkingLevel: "medium",
      verdict: { fault: "model", direction: "stronger", rounds: 1, confidence: 0.9, reason: "r" },
    });
    expect(store.listSessionReviews(group.id)).toHaveLength(1);

    store.clearSessionMessages(group.id);

    expect(store.listMessages(group.id).items).toHaveLength(0);
    expect(store.listSessionReviews(group.id)).toHaveLength(0);
    expect(store.getSession(group.id).id).toBe(group.id);

    const again = store.postMessage(group.id, { body: "after clear" });
    const nextTurn = store.createTurn({
      sessionId: group.id,
      botId: b1.bot.id,
      triggerMessageId: again.id,
    });
    store.recordRouteReview({
      botId: b1.bot.id,
      chainId: nextTurn.id,
      turnId: nextTurn.id,
      sessionId: group.id,
      signature: "coding",
      model: "code-pro",
      thinkingLevel: "medium",
      verdict: { fault: "none", direction: "stronger", rounds: 0, confidence: 0.1, reason: "" },
    });

    store.deleteSession(group.id);

    expect(() => store.getSession(group.id)).toThrow();
    expect(store.listSessions().some((s) => s.id === group.id)).toBe(false);
    expect(store.listSessionReviews(group.id)).toHaveLength(0);

    store.close();
  });

  test("leftover profile_change rows stay out of listings, last_message, unread, and search", () => {
    const store = new Store();
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const sessionId = created.direct_session.id;
    const user = store.postMessage(sessionId, { body: "please update" });
    store.insertMessage({
      sessionId,
      kind: "profile_change",
      author: created.bot.id,
      body: "Writer\n\nwrite\n\nstay",
    });
    expect(store.listMainMessages(sessionId, 10).map((m) => m.kind)).toEqual(["user"]);
    expect(store.listMessages(sessionId).items.map((m) => m.kind)).toEqual(["user"]);
    expect(store.listSessions().find((s) => s.id === sessionId)?.last_message?.id).toBe(user.id);
    expect(store.unreadCount(sessionId)).toBe(0);
    expect(store.search("Writer").some((hit) => hit.kind === "message")).toBe(false);
    const botHit = store.search("Writer").find((hit) => hit.kind === "bot");
    expect(botHit).toBeDefined();
    expect(botHit?.id).toBe(created.bot.id);
    expect(botHit?.avatar).toBe(created.bot.avatar);
    store.close();
  });

  test("quoting a bot prepends @Name and quote-replies stay on the main transcript", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const parent = store.insertMessage({
      sessionId: group.id,
      kind: "bot",
      author: writer.bot.id,
      body: "draft ready",
    });
    const reply = store.postMessage(group.id, { body: "please revise", parent_id: parent.id });
    expect(reply.parent_id).toBe(parent.id);
    expect(reply.body).toBe("@Writer please revise");
    expect(store.listMainMessages(group.id, 10).map((m) => m.id)).toEqual([reply.id, parent.id]);
    expect(store.listSessions().find((s) => s.id === group.id)?.last_message?.id).toBe(reply.id);
    store.close();
  });

  test("message search hits name the session and keep the message id", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "read", boundaries: "stay" });
    const group = store.createGroup({ name: "调研", members: [writer.bot.id, researcher.bot.id] });
    const botBot = store.createBotDirect(writer.bot.id, researcher.bot.id, null);
    const youMsg = store.postMessage(writer.direct_session.id, { body: "unique-alpha in private" });
    const groupMsg = store.postMessage(group.id, { body: "unique-alpha in the group" });
    const themMsg = store.insertMessage({
      sessionId: botBot.id,
      kind: "bot",
      author: writer.bot.id,
      body: "unique-alpha between bots",
    });
    const reply = store.insertMessage({
      sessionId: writer.direct_session.id,
      parentId: youMsg.id,
      kind: "user",
      author: "user",
      body: "unique-alpha thread reply",
    });

    const hits = store.search("unique-alpha").filter((hit) => hit.kind === "message");
    const byId = new Map(hits.map((hit) => [hit.id, hit]));

    expect(byId.get(youMsg.id)).toMatchObject({
      kind: "message",
      id: youMsg.id,
      session_id: writer.direct_session.id,
      session_title: "Writer",
      parent_id: null,
    });
    expect(byId.get(groupMsg.id)).toMatchObject({
      kind: "message",
      session_id: group.id,
      session_title: "调研",
    });
    expect(byId.get(themMsg.id)).toMatchObject({
      kind: "message",
      session_id: botBot.id,
      session_title: "Writer ↔ Researcher",
    });
    expect(byId.get(reply.id)).toMatchObject({
      kind: "message",
      session_id: writer.direct_session.id,
      parent_id: youMsg.id,
    });
    store.close();
  });

  test("skills are unique per bot, capped, and survive bot deletion", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const skill = store.createSkill({
      bot_id: writer.bot.id,
      name: "Commits",
      description: "when committing",
      body: "use conventional commits",
    });
    expect(skill.enabled).toBe(true);
    expect(store.listEnabledSkills(writer.bot.id)).toHaveLength(1);
    expect(() =>
      store.createSkill({
        bot_id: writer.bot.id,
        name: "commits",
        description: "dup",
        body: "dup",
      }),
    ).toThrow();
    store.createSkill({
      bot_id: reviewer.bot.id,
      name: "Commits",
      description: "reviewer copy",
      body: "reviewer body",
    });
    expect(() =>
      store.createSkill({
        bot_id: writer.bot.id,
        name: "x".repeat(65),
        description: "when",
        body: "how",
      }),
    ).toThrow();
    for (let i = 0; i < 31; i++) {
      store.createSkill({
        bot_id: writer.bot.id,
        name: `Skill ${i}`,
        description: "when",
        body: "how",
      });
    }
    expect(() =>
      store.createSkill({
        bot_id: writer.bot.id,
        name: "overflow",
        description: "when",
        body: "how",
      }),
    ).toThrow();
    store.deleteBot(writer.bot.id);
    expect(store.listSkills().some((row) => row.id === skill.id)).toBe(true);
    store.close();
  });

  test("deleteSession deletes group and rejects direct session", () => {
    const store = new Store();
    const b1 = store.createBot({ name: "BotAlpha", duties: "alpha", boundaries: "none" });
    const b2 = store.createBot({ name: "BotBeta", duties: "beta", boundaries: "none" });
    const group = store.createGroup({ name: "AlphaBeta", members: [b1.bot.id, b2.bot.id] });

    // Cannot delete direct session
    expect(() => store.deleteSession(b1.direct_session.id)).toThrow();

    // Can delete group session
    store.deleteSession(group.id);
    expect(() => store.getSession(group.id)).toThrow();
    expect(store.listSessions().some((s) => s.id === group.id)).toBe(false);

    store.close();
  });

  test("archiveSession and restoreSession update archived_at on group session", () => {
    const store = new Store();
    const b1 = store.createBot({ name: "BotOne", duties: "one", boundaries: "none" });
    const b2 = store.createBot({ name: "BotTwo", duties: "two", boundaries: "none" });
    const group = store.createGroup({ name: "WorkGroup", members: [b1.bot.id, b2.bot.id] });
    expect(group.archived_at).toBeNull();

    const archived = store.archiveSession(group.id);
    expect(archived.archived_at).toBeString();
    expect(store.getSession(group.id).archived_at).toBe(archived.archived_at);
    expect(store.listSessions().find((s) => s.id === group.id)?.archived_at).toBe(archived.archived_at);

    // Archiving again is idempotent
    const archivedAgain = store.archiveSession(group.id);
    expect(archivedAgain.archived_at).toBe(archived.archived_at);

    const restored = store.restoreSession(group.id);
    expect(restored.archived_at).toBeNull();
    expect(store.getSession(group.id).archived_at).toBeNull();
    expect(store.listSessions().find((s) => s.id === group.id)?.archived_at).toBeNull();

    // Restoring again is idempotent
    const restoredAgain = store.restoreSession(group.id);
    expect(restoredAgain.archived_at).toBeNull();

    store.close();
  });

  test("stopTurn refuses group turns unless allowGroup", () => {
    const store = new Store();
    const b1 = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const b2 = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [b1.bot.id, b2.bot.id] });
    const msg = store.postMessage(group.id, { body: "go" });
    const turn = store.createTurn({
      sessionId: group.id,
      botId: b1.bot.id,
      triggerMessageId: msg.id,
    });
    expect(() => store.stopTurn(turn.id)).toThrow("group turns cannot be stopped");
    expect(store.getTurn(turn.id).status).toBe("running");
    expect(store.stopTurn()).toBeNull();
    const stopped = store.stopTurn(turn.id, { allowGroup: true });
    expect(stopped?.status).toBe("stopped");
    expect(store.getTurn(turn.id).status).toBe("stopped");
    store.close();
  });

  test("stopTurn without an id skips a live group turn for the newest direct", () => {
    const store = new Store();
    const b1 = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const b2 = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [b1.bot.id, b2.bot.id] });
    const groupMsg = store.postMessage(group.id, { body: "go" });
    const groupTurn = store.createTurn({
      sessionId: group.id,
      botId: b1.bot.id,
      triggerMessageId: groupMsg.id,
    });
    const directMsg = store.postMessage(b1.direct_session.id, { body: "hi" });
    const directTurn = store.createTurn({
      sessionId: b1.direct_session.id,
      botId: b1.bot.id,
      triggerMessageId: directMsg.id,
    });
    const stopped = store.stopTurn();
    expect(stopped?.id).toBe(directTurn.id);
    expect(store.getTurn(directTurn.id).status).toBe("stopped");
    expect(store.getTurn(groupTurn.id).status).toBe("running");
    store.close();
  });

  test("interruptRunningTurns inserts a 中断 system line and marks the bot pending", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = store.postMessage(writer.direct_session.id, { body: "go" });
    const turn = store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    store.interruptRunningTurns();
    expect(store.getTurn(turn.id).status).toBe("interrupted");
    expect(store.pendingInterrupt(writer.bot.id)).toBe(true);
    const note = store
      .listMainMessages(writer.direct_session.id, 10)
      .find((m) => m.kind === "system" && m.body === "中断");
    expect(note).toMatchObject({
      author: writer.bot.id,
      turn_id: turn.id,
      source_turn_id: null,
    });
    const fail = store.insertMessage({
      sessionId: writer.direct_session.id,
      turnId: turn.id,
      kind: "system",
      author: writer.bot.id,
      body: "这一轮没写完：没有可用的模型",
    });
    expect(() => store.claimInterruptContinue(fail.id)).toThrow("message is not an interrupted turn");
    store.close();
  });

  const CODING_CATALOG = [
    { name: "cheap-chat", price: 1, thinking_levels: ["none", "low"], strengths: ["chat"] },
    { name: "code-pro", price: 12, thinking_levels: ["medium", "high"], strengths: ["code", "coding"] },
  ] as const;
  const TASK = "please implement a TypeScript function that parses the AST";

  async function storeWithCodingCatalog(filename?: string, keys = memoryKeyStore("sk-test")) {
    const store = new Store(filename ? { filename, endpointKey: keys } : { endpointKey: keys });
    await store.createProvider({
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      models: CODING_CATALOG.map((row) => ({ ...row, thinking_levels: [...row.thinking_levels], strengths: [...row.strengths] })),
      default_model: "cheap-chat",
    });
    return store;
  }

  /**
   * Opens a turn on `text` and records the decision the Bot would make (or `forced`, to replay a
   * specific pick), returning both.
   */
  function decidedTurn(
    store: Store,
    sessionId: string,
    botId: string,
    text = TASK,
    forced?: { model: string; thinkingLevel: "none" | "low" | "medium" | "high" },
    opts?: { continuesPrevious?: boolean },
  ) {
    const bot = store.getBot(botId);
    const chosen = store.decideTurnRoute({
      botId,
      text,
      botModel: bot.model,
      botProviderId: bot.provider_id,
      botThinkingLevel: bot.thinking_level,
    })!;
    const decision = forced ? { ...chosen, ...forced } : chosen;
    const trigger = store.insertMessage({ sessionId, kind: "user", author: "user", body: text });
    const turn = store.createTurn({ sessionId, botId, triggerMessageId: trigger.id });
    store.recordTurnRoute({ turnId: turn.id, decision, continuesPrevious: opts?.continuesPrevious });
    return { decision, chosen, trigger, turn };
  }

  test("decisions, follow-ups and review conclusions survive a store reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-route-"));
    const filename = join(dir, "state.sqlite");
    const keys = memoryKeyStore("sk-test");
    const first = await storeWithCodingCatalog(filename, keys);
    const created = first.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const { decision, turn } = decidedTurn(first, created.direct_session.id, created.bot.id);
    expect(decision).toMatchObject({ model: "code-pro", thinkingLevel: "medium" });
    first.setTurnStatus(turn.id, "completed");
    const followUp = first.insertMessage({
      sessionId: created.direct_session.id,
      kind: "user",
      author: "user",
      body: "这里有 bug，选的模型不对",
    });
    expect(first.collectRouteFeedback(followUp)).toBe(true);
    first.recordRouteReview({
      botId: created.bot.id,
      chainId: turn.id,
      turnId: turn.id,
      sessionId: created.direct_session.id,
      signature: decision!.signature,
      model: decision!.model,
      thinkingLevel: decision!.thinkingLevel,
      verdict: { fault: "model", direction: "stronger", rounds: 1, confidence: 0.7, reason: "答得浅" },
    });
    first.close();

    const second = new Store({ filename, endpointKey: keys });
    const providers = await second.listProviders();
    expect(providers[0]?.model_catalog).toEqual(
      CODING_CATALOG.map((row) => ({ ...row, thinking_levels: [...row.thinking_levels], strengths: [...row.strengths] })),
    );
    expect(second.listRouteFeedback()).toHaveLength(1);
    expect(second.listRouteFeedback()[0]).toMatchObject({ bot_id: created.bot.id, model: "code-pro" });
    expect(second.recentRouteReviews(created.bot.id)[0]).toMatchObject({
      fault: "model",
      direction: "stronger",
      reason: "答得浅",
    });
    const record = second.getTurnRoute(turn.id);
    expect(record).toMatchObject({
      bot_id: created.bot.id,
      provider_id: providers[0]!.id,
      outcome: "completed",
      fail_kind: null,
      feedback: [{ message_id: followUp.id, body: "这里有 bug，选的模型不对" }],
    });
    expect(record?.finished_at).not.toBeNull();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a conclusion belongs to one Bot and goes away with it", async () => {
    const store = await storeWithCodingCatalog();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const turn = decidedTurn(store, writer.direct_session.id, writer.bot.id);
    store.recordRouteReview({
      botId: writer.bot.id,
      chainId: turn.turn.id,
      turnId: turn.turn.id,
      sessionId: writer.direct_session.id,
      signature: "coding",
      model: "code-pro",
      thinkingLevel: "medium",
      verdict: { fault: "model", direction: "stronger", rounds: 2, confidence: 0.9, reason: "r" },
    });
    expect(store.recentRouteReviews(writer.bot.id)).toHaveLength(1);
    expect(store.recentRouteReviews(reviewer.bot.id)).toHaveLength(0);
    store.deleteBot(writer.bot.id);
    expect(store.recentRouteReviews(writer.bot.id)).toHaveLength(0);
    store.close();
  });

  test("in a group a critique lands on the @-mentioned Bot, or on the quoted turn", async () => {
    const store = await storeWithCodingCatalog();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const writerTurn = decidedTurn(store, group.id, writer.bot.id);
    store.insertMessage({ sessionId: group.id, turnId: writerTurn.turn.id, kind: "bot", author: writer.bot.id, body: "draft done" });
    store.setTurnStatus(writerTurn.turn.id, "completed");
    const reviewerTurn = decidedTurn(store, group.id, reviewer.bot.id);
    const reviewerReply = store.insertMessage({
      sessionId: group.id,
      turnId: reviewerTurn.turn.id,
      kind: "bot",
      author: reviewer.bot.id,
      body: "review done",
    });
    store.setTurnStatus(reviewerTurn.turn.id, "completed");

    // Reviewer spoke last, but the user names the Writer.
    const named = store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 太慢了，换个模型" });
    expect(store.collectRouteFeedback(named)).toBe(true);
    expect(store.listRouteFeedback({ botId: writer.bot.id })).toHaveLength(1);
    expect(store.listRouteFeedback({ botId: reviewer.bot.id })).toHaveLength(0);

    // A reply to the Reviewer's line lands on the Reviewer's turn even without an @.
    const quoted = store.insertMessage({
      sessionId: group.id,
      parentId: reviewerReply.id,
      kind: "user",
      author: "user",
      body: "想得太少了",
    });
    expect(store.collectRouteFeedback(quoted)).toBe(true);
    expect(store.listRouteFeedback({ botId: reviewer.bot.id })).toHaveLength(1);

    // No @ and no quote: the most recently visible turn (the Reviewer's) takes it.
    const bare = store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "模型不行" });
    expect(store.collectRouteFeedback(bare)).toBe(true);
    expect(store.listRouteFeedback({ botId: reviewer.bot.id })).toHaveLength(2);
    expect(store.listRouteFeedback({ botId: writer.bot.id })).toHaveLength(1);

    const routes = store.listSessionRoutes(group.id);
    expect(routes.map((row) => [row.bot_id, row.feedback.length])).toEqual([
      [writer.bot.id, 1],
      [reviewer.bot.id, 2],
    ]);
    // Content criticism is kept too: whether it was the model's fault is the review's call, and
    // «这里不对» is exactly the wording no keyword ever matched.
    const content = store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "这里不对，重来" });
    expect(store.collectRouteFeedback(content)).toBe(true);
    store.close();
  });

  test("a chain gathers the turns the user kept pushing back on, and is reviewed once", async () => {
    const store = await storeWithCodingCatalog();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;

    const first = decidedTurn(store, session, writer.bot.id);
    store.insertMessage({ sessionId: session, turnId: first.turn.id, kind: "bot", author: writer.bot.id, body: "初稿" });
    store.setTurnStatus(first.turn.id, "completed");
    // Every follow-up is kept, including ones no keyword would ever have matched.
    const one = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "这里不对" });
    expect(store.collectRouteFeedback(one)).toBe(true);

    // The next turn says it is still the same thing, so it joins the open chain.
    const second = decidedTurn(store, session, writer.bot.id, TASK, undefined, { continuesPrevious: true });
    store.setTurnStatus(second.turn.id, "completed");
    const two = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "还是不行" });
    expect(store.collectRouteFeedback(two)).toBe(true);

    const chainId = store.openChain(session, writer.bot.id);
    expect(chainId).toBe(first.turn.id);
    const chain = store.chainForReview(chainId!)!;
    expect(chain.turnId).toBe(first.turn.id);
    expect(chain.reply).toBe("初稿");
    expect(chain.followUps).toEqual(["这里不对", "还是不行"]);

    store.recordRouteReview({
      botId: writer.bot.id,
      chainId: chainId!,
      turnId: chain.turnId,
      sessionId: session,
      signature: chain.signature,
      model: chain.model,
      thinkingLevel: chain.thinkingLevel,
      verdict: { fault: "model", direction: "stronger", rounds: 2, confidence: 0.8, reason: "反复改不对" },
    });
    // A reviewed chain is closed: the next turn starts a new one.
    expect(store.openChain(session, writer.bot.id)).toBeNull();
    expect(store.recentRouteReviews(writer.bot.id)).toHaveLength(1);
    store.close();
  });

  test("an older turn_route_decisions table without chain_id still opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-old-route-"));
    const filename = join(dir, "state.sqlite");
    const first = new Store({ filename });
    first.db.exec(`DROP INDEX IF EXISTS turn_route_decisions_chain`);
    first.db.exec(`DROP INDEX IF EXISTS route_reviews_chain`);
    const cols = first.db
      .query<{ name: string }, []>(`PRAGMA table_info(turn_route_decisions)`)
      .all()
      .map((row) => row.name);
    if (cols.includes("chain_id")) {
      const keep = cols.filter((name) => name !== "chain_id");
      first.db.exec(`
        CREATE TABLE turn_route_decisions_old (${keep.join(", ")});
        INSERT INTO turn_route_decisions_old SELECT ${keep.join(", ")} FROM turn_route_decisions;
        DROP TABLE turn_route_decisions;
        ALTER TABLE turn_route_decisions_old RENAME TO turn_route_decisions;
      `);
    }
    const reviewCols = first.db
      .query<{ name: string }, []>(`PRAGMA table_info(route_reviews)`)
      .all()
      .map((row) => row.name);
    if (reviewCols.includes("chain_id")) {
      const keep = reviewCols.filter((name) => name !== "chain_id");
      first.db.exec(`
        CREATE TABLE route_reviews_old (${keep.join(", ")});
        INSERT INTO route_reviews_old SELECT ${keep.join(", ")} FROM route_reviews;
        DROP TABLE route_reviews;
        ALTER TABLE route_reviews_old RENAME TO route_reviews;
      `);
    }
    first.close();
    const second = new Store({ filename });
    const nextCols = second.db
      .query<{ name: string }, []>(`PRAGMA table_info(turn_route_decisions)`)
      .all()
      .map((row) => row.name);
    expect(nextCols).toContain("chain_id");
    const index = second.db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'turn_route_decisions_chain'`,
      )
      .get();
    expect(index?.name).toBe("turn_route_decisions_chain");
    const nextReviewCols = second.db
      .query<{ name: string }, []>(`PRAGMA table_info(route_reviews)`)
      .all()
      .map((row) => row.name);
    expect(nextReviewCols).toContain("chain_id");
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a chain the daemon never got to review is found again on the next start", async () => {
    const store = await storeWithCodingCatalog();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const quiet = new Date(Date.now() - 10 * 60_000).toISOString();
    const floor = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

    const open = decidedTurn(store, session, writer.bot.id);
    store.setTurnStatus(open.turn.id, "completed");
    const done = decidedTurn(store, session, writer.bot.id);
    store.setTurnStatus(done.turn.id, "completed");
    const cold = decidedTurn(store, session, writer.bot.id);
    store.setTurnStatus(cold.turn.id, "completed");

    // Age them: two went quiet a while ago, one is older than the daemon will dig for.
    store.db.run(`UPDATE turn_route_decisions SET created_at = ? WHERE turn_id IN (?, ?)`, [
      quiet,
      open.turn.id,
      done.turn.id,
    ]);
    store.db.run(`UPDATE turn_route_decisions SET created_at = ? WHERE turn_id = ?`, [
      new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      cold.turn.id,
    ]);
    store.recordRouteReview({
      botId: writer.bot.id,
      chainId: done.turn.id,
      turnId: done.turn.id,
      sessionId: session,
      signature: "coding",
      model: "code-pro",
      thinkingLevel: "medium",
      verdict: { fault: "none", direction: "same", rounds: 0, confidence: 1, reason: "" },
    });

    const stale = store.staleOpenChains({
      quietBefore: new Date(Date.now() - 3 * 60_000).toISOString(),
      notBefore: floor,
    });
    // The reviewed one is finished and the cold one is not worth a call; only the open one is swept.
    expect(stale).toEqual([open.turn.id]);

    // A chain that is still being talked to is not swept out from under the live timer.
    const fresh = decidedTurn(store, session, writer.bot.id);
    store.setTurnStatus(fresh.turn.id, "completed");
    expect(
      store.staleOpenChains({
        quietBefore: new Date(Date.now() - 3 * 60_000).toISOString(),
        notBefore: floor,
      }),
    ).not.toContain(fresh.turn.id);
    store.close();
  });

  test("half-pinned bots are squared up on open: a level needs a model, a model needs a level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-half-pin-"));
    const filename = join(dir, "state.sqlite");
    const keys = memoryKeyStore("sk-test");
    const first = await storeWithCodingCatalog(filename, keys);
    const orphanLevel = first.createBot({ name: "Orphan", duties: "x", boundaries: "y" });
    const orphanModel = first.createBot({ name: "Modelled", duties: "x", boundaries: "y" });
    // Rewind to what an older database could hold: each Bot carrying only half a pin.
    first.db.run(`UPDATE bots SET model = NULL, thinking_level = 'high' WHERE id = ?`, [
      orphanLevel.bot.id,
    ]);
    first.db.run(`UPDATE bots SET model = 'code-pro', thinking_level = NULL WHERE id = ?`, [
      orphanModel.bot.id,
    ]);
    first.close();

    const second = new Store({ filename, endpointKey: keys });
    expect(second.getBot(orphanLevel.bot.id).thinking_level).toBeNull();
    const squared = second.getBot(orphanModel.bot.id);
    expect(squared.model).toBe("code-pro");
    expect(squared.thinking_level).not.toBeNull();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("decisions written before the outcome column learn how their turn ended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-route-outcome-"));
    const filename = join(dir, "state.sqlite");
    const keys = memoryKeyStore("sk-test");
    const first = await storeWithCodingCatalog(filename, keys);
    const writer = first.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const done = decidedTurn(first, session, writer.bot.id);
    first.setTurnStatus(done.turn.id, "completed");
    const stopped = decidedTurn(first, session, writer.bot.id);
    first.stopTurn(stopped.turn.id);
    const live = decidedTurn(first, session, writer.bot.id);
    // Rewind to what an old database looks like: the turns ended, the decisions never learned it.
    first.db.run(`UPDATE turn_route_decisions SET outcome = NULL, finished_at = NULL`);
    first.close();

    const second = new Store({ filename, endpointKey: keys });
    expect(second.getTurnRoute(done.turn.id)).toMatchObject({ outcome: "completed" });
    expect(second.getTurnRoute(done.turn.id)!.finished_at).not.toBeNull();
    expect(second.getTurnRoute(stopped.turn.id)).toMatchObject({ outcome: "stopped" });
    // A turn that is still running keeps an open record.
    expect(second.getTurnRoute(live.turn.id)).toMatchObject({ outcome: null, finished_at: null });
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

});

describe("a Bot↔Bot direct and its source", () => {
  test("a database from before sessions recorded a source still opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-old-origin-"));
    const filename = join(dir, "state.sqlite");
    const first = new Store({ filename });
    first.db.exec(`DROP INDEX IF EXISTS sessions_origin_message`);
    first.db.exec(`ALTER TABLE sessions DROP COLUMN origin_message_id`);
    first.db.exec(`ALTER TABLE sessions DROP COLUMN origin_session_id`);
    first.close();

    const second = new Store({ filename });
    const cols = second.db
      .query<{ name: string }, []>(`PRAGMA table_info(sessions)`)
      .all()
      .map((row) => row.name);
    expect(cols).toContain("origin_session_id");
    expect(cols).toContain("origin_message_id");
    const index = second.db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_origin_message'`,
      )
      .get();
    expect(index?.name).toBe("sessions_origin_message");
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("createDirect refuses two bots so the per-trigger door stays the only one", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    expect(() => store.createDirect(writer.bot.id, researcher.bot.id)).toThrow();
    store.close();
  });

  test("clearing the source session leaves the source but drops the message to jump to", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, researcher.bot.id] });
    const trigger = store.postMessage(group.id, { body: "go ask" });
    const direct = store.createBotDirect(writer.bot.id, researcher.bot.id, {
      sessionId: group.id,
      messageId: trigger.id,
    });

    store.clearSessionMessages(group.id);
    const after = store.getSession(direct.id);
    expect(after.origin_session_id).toBe(group.id);
    expect(after.origin_message_id).toBeNull();
    store.close();
  });

  test("deleting the source session clears the source entirely", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, researcher.bot.id] });
    const trigger = store.postMessage(group.id, { body: "go ask" });
    const direct = store.createBotDirect(writer.bot.id, researcher.bot.id, {
      sessionId: group.id,
      messageId: trigger.id,
    });

    store.deleteSession(group.id);
    const after = store.getSession(direct.id);
    expect(after.origin_session_id).toBeNull();
    expect(after.origin_message_id).toBeNull();
    store.close();
  });
});

describe("memory", () => {
  function twoBots(store: Store) {
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    return { writer, researcher };
  }

  /**
   * The render budget is a backstop, not a working limit: the per-Bot cap's worst case has to fit
   * under it, or a Bot silently stops seeing memories it wrote.
   */
  test("the per-Bot cap's worst case fits inside the render budget", () => {
    const dearest = memoryEntryCost(
      "x".repeat(MEMORY_SUBJECT_MAX),
      "y".repeat(MEMORY_BODY_MAX),
      "z".repeat(MEMORY_AGE_MAX),
    );
    expect(MEMORY_MAX_PER_BOT * dearest).toBeLessThanOrEqual(MEMORY_DIGEST_LIMIT);
  });

  test("the same subject is replaced, not added a second time", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer } = twoBots(store);
    const first = store.rememberMemory({ bot_id: writer.bot.id, subject: "用户的时区", body: "UTC+8" });
    const again = store.rememberMemory({ bot_id: writer.bot.id, subject: "用户的时区", body: "改成 UTC+9 了" });
    expect(again.id).toBe(first.id);
    expect(again.body).toBe("改成 UTC+9 了");
    expect(store.listMemories(writer.bot.id)).toHaveLength(1);
    store.close();
  });

  test("subjects collide case-insensitively, like skill names", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer } = twoBots(store);
    store.rememberMemory({ bot_id: writer.bot.id, subject: "Release Script", body: "a" });
    store.rememberMemory({ bot_id: writer.bot.id, subject: "release script", body: "b" });
    expect(store.listMemories(writer.bot.id)).toHaveLength(1);
    store.close();
  });

  /** The cap is the forcing function: a full Bot has to choose, and is told what to choose. */
  test("a full Bot is refused and told which memory is stalest", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer } = twoBots(store);
    for (let i = 0; i < MEMORY_MAX_PER_BOT; i += 1) {
      store.rememberMemory({ bot_id: writer.bot.id, subject: `事实 ${i}`, body: "x" });
    }
    expect(() => store.rememberMemory({ bot_id: writer.bot.id, subject: "再来一条", body: "x" })).toThrow(
      /事实 0/,
    );
    // Re-confirming an existing subject still works: it takes no new slot.
    expect(store.rememberMemory({ bot_id: writer.bot.id, subject: "事实 3", body: "还是对的" }).body).toBe(
      "还是对的",
    );
    store.close();
  });

  test("a disabled memory frees a slot but keeps its row", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer } = twoBots(store);
    for (let i = 0; i < MEMORY_MAX_PER_BOT; i += 1) {
      store.rememberMemory({ bot_id: writer.bot.id, subject: `事实 ${i}`, body: "x" });
    }
    const first = store.listMemories(writer.bot.id).find((m) => m.subject === "事实 0")!;
    store.patchMemory(first.id, { enabled: false });
    expect(store.rememberMemory({ bot_id: writer.bot.id, subject: "新的", body: "x" }).subject).toBe("新的");
    expect(store.listMemories(writer.bot.id)).toHaveLength(MEMORY_MAX_PER_BOT + 1);
    expect(store.listEnabledMemories(writer.bot.id)).toHaveLength(MEMORY_MAX_PER_BOT);
    store.close();
  });

  test("over-long subject or body is refused", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer } = twoBots(store);
    expect(() =>
      store.rememberMemory({ bot_id: writer.bot.id, subject: "x".repeat(MEMORY_SUBJECT_MAX + 1), body: "y" }),
    ).toThrow();
    expect(() =>
      store.rememberMemory({ bot_id: writer.bot.id, subject: "ok", body: "y".repeat(MEMORY_BODY_MAX + 1) }),
    ).toThrow();
    store.close();
  });

  /** A memory holds what the user said, so it goes with the Bot — the ADR 0018 rule. */
  test("a deleted Bot loses its memories but keeps its skills", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer } = twoBots(store);
    store.rememberMemory({ bot_id: writer.bot.id, subject: "用户的时区", body: "UTC+8" });
    store.createSkill({ bot_id: writer.bot.id, name: "发布", description: "怎么发版", body: "步骤" });
    store.deleteBot(writer.bot.id);
    expect(store.listMemories().filter((m) => m.bot_id === writer.bot.id)).toHaveLength(0);
    expect(store.listSkills().filter((s) => s.bot_id === writer.bot.id)).toHaveLength(1);
    store.close();
  });

  test("archiving a Bot keeps its memories", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer } = twoBots(store);
    store.rememberMemory({ bot_id: writer.bot.id, subject: "用户的时区", body: "UTC+8" });
    store.archiveBot(writer.bot.id);
    expect(store.listMemories(writer.bot.id)).toHaveLength(1);
    store.close();
  });

  test("clearing the source session keeps the memory and drops only the receipt", () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { writer, researcher } = twoBots(store);
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, researcher.bot.id] });
    const trigger = store.postMessage(group.id, { body: "记一下" });
    const memory = store.rememberMemory({
      bot_id: writer.bot.id,
      subject: "用户的时区",
      body: "UTC+8",
      source_session_id: group.id,
      source_message_id: trigger.id,
    });

    store.clearSessionMessages(group.id);
    const afterClear = store.getMemory(memory.id);
    expect(afterClear.source_session_id).toBe(group.id);
    expect(afterClear.source_message_id).toBeNull();

    store.deleteSession(group.id);
    const afterDelete = store.getMemory(memory.id);
    expect(afterDelete.source_session_id).toBeNull();
    store.close();
  });

  test("a database from before memories still opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-old-memory-"));
    const filename = join(dir, "state.sqlite");
    const first = new Store({ filename });
    first.db.exec(`DROP INDEX IF EXISTS memories_bot_subject`);
    first.db.exec(`DROP INDEX IF EXISTS memories_bot_recent`);
    first.db.exec(`DROP TABLE IF EXISTS memories`);
    first.close();

    const second = new Store({ filename });
    const tables = second.db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);
    expect(tables).toContain("memories");
    const index = second.db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'memories_bot_subject'`,
      )
      .get();
    expect(index?.name).toBe("memories_bot_subject");
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
