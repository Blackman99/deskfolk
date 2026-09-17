import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import { assembleJudgementUser, assembleTurnMessages, extractJudgement, trimToolContent, TRIGGER_FLAG } from "./context";
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
    expect(window).toHaveLength(2);
    expect(window[0]?.content).toBe(`【user】\n${older.body}`);
    expect(window[0]?.content).not.toContain(TRIGGER_FLAG);
    expect(window[1]?.content).toBe(`【Reviewer】\n${TRIGGER_FLAG}\n${trigger.body}`);
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
    const user = messages.find((m) => m.role === "user");
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
    const user = messages.find((m) => m.role === "user");
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
    const user = messages.find((m) => m.role === "user");
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
    const user = messages.find((m) => m.role === "user");
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
    ) as { message: { body: string }; recent_messages: Array<{ body: string }> };
    expect(payload.message.body).toBe("请各自介绍");
    expect(payload.message.body).not.toContain(TRIGGER_FLAG);
    expect(payload.recent_messages[0]?.body).toBe("请各自介绍");
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
