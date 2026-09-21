import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import { assembleComposerSuggestUser, assembleJudgementUser, assembleTurnMessages, extractJudgement, trimToolContent, SITUATION_HEADING, TRIGGER_FLAG } from "./context";
import { Store } from "./store";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const workspaces: string[] = [];

afterEach(() => {
  while (workspaces.length) {
    const dir = workspaces.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("assembleTurnMessages", () => {
  test("marks only the trigger line in the transcript window", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const older = store.insertMessage({
      sessionId: group.id,
      kind: "user",
      author: USER_MEMBER,
      body: "大家好，请各自用一句话介绍自己",
    });
    const trigger = store.insertMessage({
      sessionId: group.id,
      kind: "bot",
      author: reviewer.bot.id,
      body: "大家好，我是审查员。@Writer 请也用一句话介绍自己。",
    });
    const turn = store.createTurn({
      sessionId: group.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: group.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const window = messages.filter((m) => m.role !== "system");
    expect(window).toHaveLength(3);
    expect(window[0]?.content).toContain(SITUATION_HEADING);
    expect(String(window[0]?.content)).toContain("本轮由【Reviewer】叫醒。");
    expect(String(window[0]?.content)).toContain("用户最近一条：大家好，请各自用一句话介绍自己");
    expect(window[1]?.content).toBe(`【user】\n${older.body}`);
    expect(window[1]?.content).not.toContain(TRIGGER_FLAG);
    expect(window[2]?.content).toBe(`【Reviewer】\n${TRIGGER_FLAG}\n${trigger.body}`);
    store.close();
  });

  test("enabled skills enter the system catalog; disabled ones do not", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.createSkill({
      bot_id: writer.bot.id,
      name: "commits",
      description: "when committing",
      body: "use conventional commits",
    });
    const hidden = store.createSkill({
      bot_id: writer.bot.id,
      name: "drafts",
      description: "when drafting",
      body: "keep a private draft",
      enabled: false,
    });
    expect(hidden.enabled).toBe(false);
    const trigger = store.postMessage(writer.direct_session.id, { body: "commit this" });
    const turn = store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const system = String(messages[0]?.content);
    expect(system).toContain("# 技能");
    expect(system).toContain("## commits");
    expect(system).toContain("when committing");
    expect(system).not.toContain("## drafts");
    expect(system).not.toContain("use conventional commits");
    store.close();
  });

  test("a skill's declared MCP servers are checked against the servers connected this turn", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.createSkill({
      bot_id: writer.bot.id,
      name: "release",
      description: "when cutting a release",
      body: "call mcp_github_create_release",
      uses: ["GitHub", "slack"],
    });
    const trigger = store.postMessage(writer.direct_session.id, { body: "ship it" });
    const turn = store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const base = {
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      interrupt: false,
      loop: [],
    };
    const zh = String(
      assembleTurnMessages(store, {
        ...base,
        locale: "zh",
        mcpGuides: [{ name: "github", instructions: null, tools: [{ modelName: "mcp_github_create_release", description: "" }] }],
      })[0]?.content,
    );
    // Matching is case-insensitive; the name is echoed as the skill wrote it.
    expect(zh).toContain("依赖 MCP：GitHub、slack（本轮未连接）");
    expect(zh).toContain("依赖的服务器不在时，正文照做不了");
    const en = String(assembleTurnMessages(store, { ...base, locale: "en", mcpGuides: [] })[0]?.content);
    expect(en).toContain("Uses MCP: GitHub (not connected this turn), slack (not connected this turn)");
    expect(en).toContain("cannot be followed as written");
    store.close();
  });

  test("raster image attachments are sent as image_url parts after the path line", async () => {
    const root = mkdtempSync(join(tmpdir(), "real-bot-ctx-img-"));
    workspaces.push(root);
    const store = new Store();
    await store.patchSettings({ workspace_path: root });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = store.postMessage(writer.direct_session.id, {
      body: "这是什么",
      attachments: [{ originalFilename: "pixel.png", buffer: PNG_1X1 }],
    });
    const turn = store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({
      type: "text",
      text: `【user】\n${TRIGGER_FLAG}\n这是什么\n附件：${trigger.attachments[0]!.workspace_relpath}`,
    });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG_1X1.toString("base64")}` },
    });
    store.close();
  });

  test("non-image attachments stay as path lines without image parts", async () => {
    const root = mkdtempSync(join(tmpdir(), "real-bot-ctx-pdf-"));
    workspaces.push(root);
    const store = new Store();
    await store.patchSettings({ workspace_path: root });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = store.postMessage(writer.direct_session.id, {
      body: "看这份",
      attachments: [{ originalFilename: "notes.pdf", buffer: Buffer.from("%PDF-1.4") }],
    });
    const turn = store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(user?.content).toBe(
      `【user】\n${TRIGGER_FLAG}\n看这份\n附件：${trigger.attachments[0]!.workspace_relpath}`,
    );
    store.close();
  });

  test("a missing image file keeps the path line and drops the image part", async () => {
    const root = mkdtempSync(join(tmpdir(), "real-bot-ctx-missing-"));
    workspaces.push(root);
    const store = new Store();
    await store.patchSettings({ workspace_path: root });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = store.postMessage(writer.direct_session.id, {
      body: "图呢",
      attachments: [{ originalFilename: "gone.png", buffer: PNG_1X1 }],
    });
    rmSync(join(root, trigger.attachments[0]!.workspace_relpath));
    const turn = store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(user?.content).toBe(
      `【user】\n${TRIGGER_FLAG}\n图呢\n附件：${trigger.attachments[0]!.workspace_relpath}`,
    );
    store.close();
  });

  test("a bot-cited raster in the workspace is sent as image_url to the woken bot", async () => {
    const root = mkdtempSync(join(tmpdir(), "real-bot-ctx-cite-"));
    workspaces.push(root);
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "mock.png"), PNG_1X1);
    const store = new Store();
    await store.patchSettings({ workspace_path: root });
    const designer = store.createBot({ name: "设计师", duties: "design", boundaries: "stay" });
    const developer = store.createBot({ name: "开发", duties: "code", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [designer.bot.id, developer.bot.id] });
    const trigger = store.insertMessage({
      sessionId: group.id,
      kind: "bot",
      author: designer.bot.id,
      body: "首页稿在 [mock](out/mock.png)，请按此切。@开发",
      paths: ["out/mock.png"],
    });
    const turn = store.createTurn({
      sessionId: group.id,
      botId: developer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: group.id,
      botId: developer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const situation = messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SITUATION_HEADING));
    expect(String(situation?.content)).toContain("本轮由【设计师】叫醒。");
    expect(String(situation?.content)).toContain("在场成员（点名请逐字写全名）：@设计师。");
    const user = messages.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({
      type: "text",
      text: `【设计师】\n${TRIGGER_FLAG}\n${trigger.body}\n附件：out/mock.png`,
    });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG_1X1.toString("base64")}` },
    });
    store.close();
  });

  test("a group's situation block keeps its facts and adds the work dir", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const trigger = store.insertMessage({
      sessionId: group.id,
      kind: "user",
      author: USER_MEMBER,
      body: "导出季度报表",
    });
    const turn = store.createTurn({
      sessionId: group.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: group.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const situation = String(
      messages.find((m) => typeof m.content === "string" && m.content.includes(SITUATION_HEADING))
        ?.content,
    );
    expect(situation).toContain("在场成员");
    expect(situation).toContain("本轮由");
    expect(situation.trimEnd().endsWith(`本轮工作目录：${store.getTask(turn.task_id!).dir}/`)).toBe(true);
    store.close();
  });

  test("a direct session's situation block is the work dir and nothing else", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = store.insertMessage({
      sessionId: writer.direct_session.id,
      kind: "user",
      author: USER_MEMBER,
      body: "hello",
    });
    const turn = store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const messages = assembleTurnMessages(store, {
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    // Members, live turns and the waker are group facts; a direct has none of them. The work dir
    // is every turn's, because it is where a shell without cwd runs.
    const situation = messages.find(
      (m) => typeof m.content === "string" && m.content.includes(SITUATION_HEADING),
    );
    const body = String(situation?.content).slice(SITUATION_HEADING.length).trim();
    expect(body).toBe(`本轮工作目录：${store.getTask(turn.task_id!).dir}/`);
    store.close();
  });
});

describe("assembleJudgementUser", () => {
  test("keeps trigger body unmarked in the judgement JSON", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const trigger = store.insertMessage({
      sessionId: group.id,
      kind: "user",
      author: USER_MEMBER,
      body: "请各自介绍",
    });
    const payload = JSON.parse(
      assembleJudgementUser(store, {
        sessionId: group.id,
        botId: writer.bot.id,
        message: trigger,
        mentions: [],
        everyone: false,
      }),
    ) as {
      message: { body: string };
      situation: { seats: string[]; waker: string; latest_user: string | null };
      recent_messages: Array<{ body: string }>;
    };
    expect(payload.message.body).toBe("请各自介绍");
    expect(payload.message.body).not.toContain(TRIGGER_FLAG);
    expect(payload.recent_messages[0]?.body).toBe("请各自介绍");
    expect(payload.situation.waker).toBe("user");
    expect(payload.situation.latest_user).toBe("请各自介绍");
    expect(payload.situation.seats).toEqual([]);
    expect(Object.keys(payload)).toEqual([
      "you",
      "session",
      "members",
      "message",
      "situation",
      "recent_messages",
    ]);
    store.close();
  });
});

describe("assembleComposerSuggestUser", () => {
  test("lists present members and recent transcript without the trigger flag", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    store.insertMessage({
      sessionId: group.id,
      kind: "user",
      author: USER_MEMBER,
      body: "请各自介绍",
    });
    const payload = JSON.parse(assembleComposerSuggestUser(store, group.id)) as {
      session: { kind: string; name: string | null };
      members: unknown[];
      situation: { waker: string; latest_user: string | null };
      recent_messages: Array<{ body: string; author: string }>;
    };
    expect(payload.session.kind).toBe("group");
    expect(payload.session.name).toBe("Brief");
    expect(payload.members).toContain("user");
    expect(payload.members).toContainEqual({ name: "Writer", duties: "write" });
    expect(payload.members).toContainEqual({ name: "Reviewer", duties: "review" });
    expect(payload.members).toHaveLength(3);
    expect(payload.recent_messages[0]?.body).toBe("请各自介绍");
    expect(payload.recent_messages[0]?.author).toBe("user");
    expect(payload.situation.waker).toBe("user");
    expect(payload.situation.latest_user).toBe("请各自介绍");
    expect(JSON.stringify(payload)).not.toContain(TRIGGER_FLAG);
    store.close();
  });
});

describe("extractJudgement", () => {
  test("strips a fence and takes the first object", () => {
    const got = extractJudgement("```json\n{ \"decision\": \"join\", \"reason\": \"matches duties\" }\n```\nnope", false);
    expect(got).toEqual({ decision: "join", reason: "matches duties", error: null });
  });

  test("empty reason is omitted; tool calls are invalid", () => {
    expect(extractJudgement('{ "decision": "pass", "reason": "" }', false)).toEqual({
      decision: "pass",
      reason: null,
      error: null,
    });
    expect(extractJudgement('{ "decision": "join" }', true).error).toBe("invalid_output");
  });
});

describe("trimToolContent", () => {
  test("keeps small JSON intact", () => {
    const raw = JSON.stringify({ ok: true, data: { message_id: "abc" } });
    expect(trimToolContent(raw)).toBe(raw);
  });
});

describe("situation members", () => {
  test("the situation block lists the other members by exact name in both locales", () => {
    const store = new Store();
    const director = store.createBot({ name: "导演", duties: "direct", boundaries: "stay" });
    const storyboard = store.createBot({ name: "分镜师", duties: "storyboard", boundaries: "stay" });
    const writer = store.createBot({ name: "编剧", duties: "write", boundaries: "stay" });
    const group = store.createGroup({
      name: "Film",
      members: [director.bot.id, storyboard.bot.id, writer.bot.id],
    });
    const trigger = store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@导演 开始" });
    const turn = store.createTurn({ sessionId: group.id, botId: director.bot.id, triggerMessageId: trigger.id });
    const find = (locale: "zh" | "en") => {
      const messages = assembleTurnMessages(store, {
        sessionId: group.id,
        botId: director.bot.id,
        turnId: turn.id,
        triggerMessageId: trigger.id,
        locale,
        interrupt: false,
        loop: [],
      });
      const situation = messages.find(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SITUATION_HEADING),
      );
      return String(situation?.content);
    };
    const zh = find("zh");
    const membersLine = zh.split("\n").find((line) => line.startsWith("在场成员")) ?? "";
    expect(membersLine.startsWith("在场成员（点名请逐字写全名）：@")).toBe(true);
    expect(membersLine.endsWith("。")).toBe(true);
    expect(membersLine.slice("在场成员（点名请逐字写全名）：".length, -1).split("、").sort()).toEqual(["@分镜师", "@编剧"]);
    expect(zh.indexOf("在场成员")).toBeLessThan(zh.indexOf("本群"));
    const enLine = find("en").split("\n").find((line) => line.startsWith("Members here")) ?? "";
    expect(enLine.startsWith("Members here (mention by exact full name): @")).toBe(true);
    expect(enLine.slice("Members here (mention by exact full name): ".length, -1).split(", ").sort()).toEqual(["@分镜师", "@编剧"]);
    store.close();
  });
});

describe("memory in the turn context", () => {
  function systemFor(store: Store, botId: string, sessionId: string, locale: "zh" | "en" = "zh"): string {
    const trigger = store.postMessage(sessionId, { body: "说点什么" });
    const turn = store.createTurn({ sessionId, botId, triggerMessageId: trigger.id });
    const messages = assembleTurnMessages(store, {
      sessionId,
      botId,
      turnId: turn.id,
      triggerMessageId: trigger.id,
      locale,
      interrupt: false,
      loop: [],
    });
    return String(messages[0]?.content);
  }

  test("enabled memories enter the system block; disabled ones do not", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.rememberMemory({ bot_id: writer.bot.id, subject: "用户的时区", body: "UTC+8，别换算" });
    const hidden = store.rememberMemory({ bot_id: writer.bot.id, subject: "旧结论", body: "已经不对了" });
    store.patchMemory(hidden.id, { enabled: false });

    const system = systemFor(store, writer.bot.id, writer.direct_session.id);
    expect(system).toContain("# 记忆");
    expect(system).toContain("## 用户的时区");
    expect(system).toContain("UTC+8，别换算");
    expect(system).not.toContain("## 旧结论");
    store.close();
  });

  test("no memories means no heading at all", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    expect(systemFor(store, writer.bot.id, writer.direct_session.id)).not.toContain("# 记忆");
    store.close();
  });

  test("another Bot's memories never appear", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    store.rememberMemory({ bot_id: researcher.bot.id, subject: "只有我知道", body: "别人看不到" });
    expect(systemFor(store, writer.bot.id, writer.direct_session.id)).not.toContain("只有我知道");
    store.close();
  });

  /**
   * Memory changes most often, so it renders after everything a prefix cache would otherwise
   * have to throw away with it.
   */
  test("the memory block comes after the MCP block and the system rules", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.rememberMemory({ bot_id: writer.bot.id, subject: "用户的时区", body: "UTC+8" });
    const system = systemFor(store, writer.bot.id, writer.direct_session.id);
    expect(system.indexOf("# 系统指令")).toBeLessThan(system.indexOf("# 记忆"));
    expect(system.indexOf("# 人设")).toBeLessThan(system.indexOf("# 记忆"));
    store.close();
  });

  /** The cut takes newest-first; the survivors render by subject so the text stays put. */
  test("memories render in subject order, not in the order they were written", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.rememberMemory({ bot_id: writer.bot.id, subject: "zebra", body: "written first" });
    store.rememberMemory({ bot_id: writer.bot.id, subject: "alpha", body: "written second" });
    const system = systemFor(store, writer.bot.id, writer.direct_session.id);
    expect(system.indexOf("## alpha")).toBeLessThan(system.indexOf("## zebra"));
    store.close();
  });

  test("the system text points at remember instead of denying a memory layer", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const zh = systemFor(store, writer.bot.id, writer.direct_session.id, "zh");
    expect(zh).not.toContain("也不是记忆层");
    expect(zh).toContain("remember");

    const en = systemFor(store, writer.bot.id, writer.direct_session.id, "en");
    expect(en).not.toContain("not a memory layer");
    expect(en).toContain("store it with remember");
    store.close();
  });
});
