/**
 * 批注的本机接口：草稿的增删改查、裁图、整批发送合成一条引用回复并叫醒交付的 Bot（那一轮沿用交付
 * 那一轮的工作目录），拒绝路径，回执重放，以及 sync-v1 事件流上的 annotation.upsert / removed。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER, type Annotation, type Message } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store, TASK_QUIET_MS } from "./store";
import { sha256 } from "./request-digest";
import { ulid } from "./ids";
import type { CompletionRequest, CompletionResult, CompletionsClient } from "./completions";

type Harness = {
  origin: string;
  token: string;
  store: Store;
  root: string;
  requests: CompletionRequest[];
  close: () => Promise<void>;
};

const harnesses: Harness[] = [];

function answer(content = "收到，改好了。"): CompletionResult {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

async function start(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "real-bot-annotations-api-"));
  const token = "test-token";
  const store = new Store({ endpointKey: memoryKeyStore() });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "https://fixture.invalid/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  const requests: CompletionRequest[] = [];
  const completions: CompletionsClient = {
    async complete(request) {
      requests.push(request);
      return answer();
    },
    async judge() {
      return { content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
    },
  };
  const api = createLocalApi({ store, token, schedule: false, completions });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const harness: Harness = {
    origin: `http://${server.hostname}:${server.port}`,
    token,
    store,
    root,
    requests,
    close: async () => {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close();
});

function headers(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json", ...extra };
}

async function call(h: Harness, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${h.origin}${path}`, { method, headers: headers(h, extra), body: body === undefined ? undefined : JSON.stringify(body) });
}

const REPORT = "# Title\n\nfirst paragraph\n\nsecond paragraph\n";

/** A Bot in your direct that delivered `report.md` from a turn with a work dir. */
function delivered(h: Harness) {
  writeFileSync(join(h.root, "report.md"), REPORT);
  const created = h.store.createBot({ name: "Writer", duties: "write", boundaries: "none", model: "fixture", thinking_level: "low" });
  const trigger = h.store.postMessage(created.direct_session.id, { body: "写个报告" });
  const turn = h.store.createTurn({ sessionId: created.direct_session.id, botId: created.bot.id, triggerMessageId: trigger.id });
  const delivery = h.store.insertMessage({ sessionId: created.direct_session.id, turnId: turn.id, kind: "bot", author: created.bot.id, body: "写好了：report.md", paths: ["report.md"] });
  h.store.setTurnStatus(turn.id, "completed");
  return { bot: created.bot, direct: created.direct_session.id, delivery, turn };
}

const draftBody = (deliveryId: string, overrides: Record<string, unknown> = {}) => ({
  target_message_id: deliveryId,
  relpath: "report.md",
  anchor_kind: "text_range",
  anchor: { start_line: 3, start_col: 1, end_line: 3, end_col: 16, quote: "first paragraph", prefix: "# Title\n\n", suffix: "\n\nsecond" },
  content_sha256: sha256(new TextEncoder().encode(REPORT)),
  body: "这段太长了",
  ...overrides,
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("annotation drafts over HTTP", () => {
  test("create, read, list, patch, and delete a draft", async () => {
    const h = await start();
    const { delivery, direct } = delivered(h);
    const created = await call(h, "POST", "/v1/annotations", draftBody(delivery.id));
    expect(created.status).toBe(201);
    const row = (await created.json()) as Annotation;
    expect(row).toMatchObject({ status: "draft", relpath: "report.md", session_id: direct, target_message_id: delivery.id, stale: null });

    const one = await call(h, "GET", `/v1/annotations/${row.id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as Annotation).id).toBe(row.id);

    const listed = await call(h, "GET", `/v1/annotations?relpath=report.md&status=draft`);
    expect(((await listed.json()) as { items: Annotation[] }).items.map((a) => a.id)).toEqual([row.id]);
    expect((await call(h, "GET", `/v1/annotations?status=weird`)).status).toBe(422);

    const patched = await call(h, "PATCH", `/v1/annotations/${row.id}`, { body: "短一点" });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as Annotation).body).toBe("短一点");
    // A stale revision is refused the way every other entity refuses one.
    expect((await call(h, "PATCH", `/v1/annotations/${row.id}`, { body: "x", if_revision: "2000-01-01T00:00:00.000Z" })).status).toBe(409);

    expect((await call(h, "DELETE", `/v1/annotations/${row.id}`)).status).toBe(204);
    expect((await call(h, "GET", `/v1/annotations/${row.id}`)).status).toBe(404);
    expect((await call(h, "DELETE", `/v1/annotations/${row.id}`)).status).toBe(404);
  });

  test("refuses what the rules refuse, with 422 and nothing written", async () => {
    const h = await start();
    const { delivery, direct } = delivered(h);
    const mine = h.store.postMessage(direct, { body: "我的" });
    for (const body of [
      draftBody(mine.id),
      draftBody(delivery.id, { relpath: "https://example.com/a.md" }),
      draftBody(delivery.id, { relpath: "../etc/passwd" }),
      draftBody(delivery.id, { relpath: "missing.md" }),
      draftBody(delivery.id, { anchor: { start_line: 0 } }),
      draftBody(delivery.id, { anchor_kind: "sticker" }),
      draftBody(delivery.id, { body: "" }),
      draftBody(delivery.id, { content_sha256: "zz" }),
      draftBody(delivery.id, { crop: { mime: "image/gif", base64: "AAAA" } }),
      null,
    ]) {
      const res = await call(h, "POST", "/v1/annotations", body);
      expect(res.status).toBe(422);
    }
    expect((await call(h, "POST", "/v1/annotations", draftBody("01ARZ3NDEKTSV4RRFFQ69G5FAV"))).status).toBe(404);
    expect(h.store.listAnnotations()).toHaveLength(0);
  });

  test("a crop round-trips as bytes with an ETag, and a draft without one is 404", async () => {
    const h = await start();
    const { delivery } = delivered(h);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const created = await call(h, "POST", "/v1/annotations", draftBody(delivery.id, { crop: { mime: "image/png", base64: png.toString("base64") } }));
    const row = (await created.json()) as Annotation;
    expect(row.crop_mime).toBe("image/png");
    const crop = await fetch(`${h.origin}/v1/annotations/${row.id}/crop`, { headers: { Authorization: `Bearer ${h.token}` } });
    expect(crop.status).toBe(200);
    expect(crop.headers.get("Content-Type")).toBe("image/png");
    expect(crop.headers.get("ETag")).toBe(`"${sha256(png)}"`);
    expect(Buffer.from(await crop.arrayBuffer()).equals(png)).toBe(true);
    const plain = (await (await call(h, "POST", "/v1/annotations", draftBody(delivery.id))).json()) as Annotation;
    expect((await fetch(`${h.origin}/v1/annotations/${plain.id}/crop`, { headers: { Authorization: `Bearer ${h.token}` } })).status).toBe(404);
  });
});

describe("sending a batch over HTTP", () => {
  test("makes one quoted reply that names the Bot, opens the drafts, and wakes the Bot in the delivery's folder", async () => {
    const h = await start();
    const { bot, direct, delivery, turn } = delivered(h);
    // Long quiet, and another job since: an ordinary message would get a new folder.
    h.store.db.run("UPDATE turns SET last_activity_at = ? WHERE id = ?", [new Date(Date.now() - TASK_QUIET_MS * 2).toISOString(), turn.id]);
    const other = h.store.postMessage(direct, { body: "另一件事" });
    const otherTurn = h.store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: other.id, newTask: true });
    h.store.setTurnStatus(otherTurn.id, "completed");
    expect(h.store.getTask(turn.task_id!).closed_at).not.toBeNull();

    const a = (await (await call(h, "POST", "/v1/annotations", draftBody(delivery.id))).json()) as Annotation;
    const b = (await (await call(h, "POST", "/v1/annotations", draftBody(delivery.id, { body: "标题呢" }))).json()) as Annotation;
    const sent = await call(h, "POST", "/v1/annotations/send", { session_id: direct, body: "两处请改", annotation_ids: [a.id, b.id] }, { "X-Request-Id": ulid() });
    expect(sent.status).toBe(201);
    const result = (await sent.json()) as { message: Message; annotations: Annotation[] };
    expect(result.message.parent_id).toBe(delivery.id);
    expect(result.message.body).toBe(`@${bot.name} 两处请改`);
    expect(result.message.author).toBe(USER_MEMBER);
    expect(result.annotations.map((x) => x.status)).toEqual(["open", "open"]);
    expect(result.annotations.every((x) => x.message_id === result.message.id)).toBe(true);

    // The Bot woke, and its turn ran in the delivery's work dir, reopened.
    await until(() => h.requests.length >= 1);
    const woken = h.store.db.query<{ id: string; task_id: string }, [string]>("SELECT id, task_id FROM turns WHERE trigger_message_id = ?").get(result.message.id);
    expect(woken?.task_id).toBe(turn.task_id!);
    await until(() => h.store.getTurn(woken!.id).status === "completed");
    expect(h.store.getTask(turn.task_id!).closed_at).toBeNull();
    expect(h.store.getTask(otherTurn.task_id!).closed_at).not.toBeNull();
  });

  test("refuses a mixed or oversized batch as a whole, and replays the same request id", async () => {
    const h = await start();
    const { direct, delivery } = delivered(h);
    const a = (await (await call(h, "POST", "/v1/annotations", draftBody(delivery.id))).json()) as Annotation;
    const many = Array.from({ length: 51 }, () => ulid());
    expect((await call(h, "POST", "/v1/annotations/send", { session_id: direct, body: "", annotation_ids: many })).status).toBe(422);
    expect((await call(h, "POST", "/v1/annotations/send", { session_id: direct, body: "", annotation_ids: [a.id, ulid()] })).status).toBe(404);
    expect(h.store.getAnnotation(a.id).status).toBe("draft");
    const requestId = ulid();
    const first = await call(h, "POST", "/v1/annotations/send", { session_id: direct, body: "", annotation_ids: [a.id] }, { "X-Request-Id": requestId });
    expect(first.status).toBe(201);
    const again = await call(h, "POST", "/v1/annotations/send", { session_id: direct, body: "", annotation_ids: [a.id] }, { "X-Request-Id": requestId });
    expect(again.status).toBe(201);
    expect(((await again.json()) as { message: Message }).message.id).toBe(((await first.json()) as { message: Message }).message.id);
    expect(h.store.listMainMessages(direct, 10).filter((m) => m.kind === "user" && m.parent_id === delivery.id)).toHaveLength(1);
  });

  test("a Bot↔Bot artifact's batch lands in your direct with a pointer back", async () => {
    const h = await start();
    const { bot, delivery } = delivered(h);
    const other = h.store.createBot({ name: "Editor", duties: "edit", boundaries: "none", model: "fixture", thinking_level: "low" });
    const botDm = h.store.createBotDirect(bot.id, other.bot.id, { sessionId: delivery.session_id, messageId: delivery.id });
    const handoff = h.store.insertMessage({ sessionId: botDm.id, kind: "bot", author: other.bot.id, body: "改好了 report.md", paths: ["report.md"] });
    const a = (await (await call(h, "POST", "/v1/annotations", draftBody(handoff.id))).json()) as Annotation;
    expect(a.session_id).toBe(other.direct_session.id);
    const sent = await call(h, "POST", "/v1/annotations/send", { session_id: a.session_id, body: "标题呢", annotation_ids: [a.id] });
    expect(sent.status).toBe(201);
    const { message } = (await sent.json()) as { message: Message };
    expect(message.session_id).toBe(other.direct_session.id);
    expect(message.parent_id).toBeNull();
    expect(message.annotation_source_message_id).toBe(handoff.id);
    expect(message.body).toBe(`@${other.bot.name} 标题呢`);
    await until(() => h.requests.length >= 1);
  });
});

describe("the sync stream", () => {
  test("carries annotation.upsert and annotation.removed", async () => {
    const h = await start();
    const { delivery } = delivered(h);
    const ws = new WebSocket(`${h.origin.replace("http:", "ws:")}/v1/events`);
    const frames: Array<{ type: string; payload?: { event: string; id?: string; status?: string } }> = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => { ws.send(JSON.stringify({ type: "auth", token: h.token, protocol: "sync-v1" })); };
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as { type: string; payload?: { event: string; id?: string; status?: string } };
        frames.push(frame);
        if (frame.type === "ready") resolve();
      };
    });
    const a = (await (await call(h, "POST", "/v1/annotations", draftBody(delivery.id))).json()) as Annotation;
    await until(() => frames.some((f) => f.payload?.event === "annotation.upsert" && f.payload.id === a.id && f.payload.status === "draft"));
    await call(h, "DELETE", `/v1/annotations/${a.id}`);
    await until(() => frames.some((f) => f.payload?.event === "annotation.removed" && f.payload.id === a.id));
    ws.close();
  });
});
