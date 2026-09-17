import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
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
      "messages",
      "profile_revisions",
      "providers",
      "reactions",
      "route_feedback",
      "routines",
      "session_participants",
      "sessions",
      "settings",
      "skills",
      "spend",
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
    const botBot = store.createDirect(writer.bot.id, researcher.bot.id);
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

  test("learned routing state and catalog survive a store reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-route-"));
    const filename = join(dir, "state.sqlite");
    const keys = memoryKeyStore("sk-test");
    const first = new Store({ filename, endpointKey: keys });
    await first.createProvider({
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      models: [
        {
          name: "cheap-chat",
          price: 1,
          thinking_levels: ["none", "low"],
          strengths: ["chat"],
        },
        {
          name: "code-pro",
          price: 12,
          thinking_levels: ["medium", "high"],
          strengths: ["code", "coding"],
        },
      ],
      default_model: "cheap-chat",
    });
    const created = first.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const task = "please implement a TypeScript function that parses the AST";
    const before = first.decideTurnRoute({ text: task, botModel: null, botProviderId: null });
    expect(before).toMatchObject({ model: "code-pro", thinkingLevel: "medium" });
    const trigger = first.insertMessage({
      sessionId: created.direct_session.id,
      kind: "user",
      author: "user",
      body: task,
    });
    const turn = first.createTurn({
      sessionId: created.direct_session.id,
      botId: created.bot.id,
      triggerMessageId: trigger.id,
    });
    first.recordTurnRoute({
      turnId: turn.id,
      sessionId: created.direct_session.id,
      triggerMessageId: trigger.id,
      decision: before!,
    });
    first.setTurnStatus(turn.id, "completed");
    const critique = first.insertMessage({
      sessionId: created.direct_session.id,
      kind: "user",
      author: "user",
      body: "这里有 bug，选的模型不对",
    });
    expect(first.collectRouteFeedback(critique)).toBe(true);
    first.close();

    const second = new Store({ filename, endpointKey: keys });
    const providers = await second.listProviders();
    expect(providers[0]?.model_catalog).toEqual([
      {
        name: "cheap-chat",
        price: 1,
        thinking_levels: ["none", "low"],
        strengths: ["chat"],
      },
      {
        name: "code-pro",
        price: 12,
        thinking_levels: ["medium", "high"],
        strengths: ["code", "coding"],
      },
    ]);
    expect(second.listRouteFeedback()).toHaveLength(1);
    const after = second.decideTurnRoute({ text: task, botModel: null, botProviderId: null });
    expect(after).not.toBeNull();
    expect(`${after!.model}:${after!.thinkingLevel}`).not.toBe("code-pro:medium");
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
