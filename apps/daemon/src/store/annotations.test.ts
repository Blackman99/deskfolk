/**
 * 批注的数据与规则：挂到谁、只批工作区内的文件、草稿与已发出的各自能改什么、整批发送合成一条引用回复、
 * 叫醒的那一轮沿用交付那一轮的工作目录、陈旧现算、清空与删会话一起带走。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER, type Annotation, type ClientEvent, type TextRangeAnchor } from "@real-bot/protocol";
import { Store, TASK_QUIET_MS } from ".";
import { sha256 } from "../request-digest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type World = {
  store: Store;
  root: string;
  bot: { id: string; name: string };
  other: { id: string; name: string };
  direct: string;
  group: string;
  /** A Bot message in your direct that cites `report.md`, with a turn and a work dir behind it. */
  delivery: { id: string; turn_id: string; task_id: string };
  write(relpath: string, text: string): string;
};

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "real-bot-annotations-"));
  roots.push(root);
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const created = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const other = store.createBot({ name: "Editor", duties: "edit", boundaries: "none" });
  const group = store.createGroup({ name: "Team", members: [created.bot.id, other.bot.id] });
  const write = (relpath: string, text: string): string => {
    const abs = join(root, relpath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
    return sha256(new TextEncoder().encode(text));
  };
  write("report.md", "# Title\n\nfirst paragraph\n\nsecond paragraph\n");
  const trigger = store.postMessage(created.direct_session.id, { body: "写个报告" });
  const turn = store.createTurn({ sessionId: created.direct_session.id, botId: created.bot.id, triggerMessageId: trigger.id });
  const delivery = store.insertMessage({
    sessionId: created.direct_session.id,
    turnId: turn.id,
    kind: "bot",
    author: created.bot.id,
    body: "写好了：report.md",
    paths: ["report.md"],
  });
  store.setTurnStatus(turn.id, "completed");
  return {
    store,
    root,
    bot: { id: created.bot.id, name: created.bot.name },
    other: { id: other.bot.id, name: other.bot.name },
    direct: created.direct_session.id,
    group: group.id,
    delivery: { id: delivery.id, turn_id: turn.id, task_id: turn.task_id! },
    write,
  };
}

const anchor: TextRangeAnchor = {
  start_line: 3,
  start_col: 1,
  end_line: 3,
  end_col: 16,
  quote: "first paragraph",
  prefix: "# Title\n\n",
  suffix: "\n\nsecond",
};

function draft(w: World, overrides: Partial<Parameters<Store["createAnnotation"]>[0]> = {}): Annotation {
  return w.store.createAnnotation({
    target_message_id: w.delivery.id,
    relpath: "report.md",
    anchor_kind: "text_range",
    anchor,
    content_sha256: sha256(new TextEncoder().encode("# Title\n\nfirst paragraph\n\nsecond paragraph\n")),
    body: "这段太长了",
    ...overrides,
  });
}

describe("a draft hangs on the delivery", () => {
  test("records the Bot, the turn, the session, and starts as a draft", () => {
    const w = world();
    const a = draft(w);
    expect(a.status).toBe("draft");
    expect(a.bot_id).toBe(w.bot.id);
    expect(a.target_turn_id).toBe(w.delivery.turn_id);
    expect(a.target_session_id).toBe(w.direct);
    expect(a.session_id).toBe(w.direct);
    expect(a.message_id).toBeNull();
    expect(a.stale).toBeNull();
    expect(a.crop_mime).toBeNull();
    expect(w.store.getAnnotation(a.id).anchor).toEqual(anchor);
  });

  test("refuses a message that is not a Bot's, a link, a path outside, a missing file, a directory", () => {
    const w = world();
    const mine = w.store.postMessage(w.direct, { body: "我的话" });
    expect(() => draft(w, { target_message_id: mine.id })).toThrow(/Bot's message/);
    expect(() => draft(w, { target_message_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toThrow(/not found/);
    expect(() => draft(w, { relpath: "https://example.com/report.md" })).toThrow(/links/);
    expect(() => draft(w, { relpath: "../outside.md" })).toThrow(/inside the workspace/);
    expect(() => draft(w, { relpath: "/etc/hosts" })).toThrow(/inside the workspace/);
    expect(() => draft(w, { relpath: "missing.md" })).toThrow(/does not exist/);
    mkdirSync(join(w.root, "dir"));
    expect(() => draft(w, { relpath: "dir" })).toThrow(/not a directory/);
  });

  test("checks the anchor, the hash, the body, and the crop", () => {
    const w = world();
    expect(() => draft(w, { anchor: { ...anchor, end_line: 1 } })).toThrow(/anchor/);
    expect(() => draft(w, { anchor_kind: "sticker" as never })).toThrow(/anchor_kind/);
    expect(() => draft(w, { content_sha256: "nope" })).toThrow(/SHA-256/);
    expect(() => draft(w, { body: "   " })).toThrow(/empty/);
    expect(() => draft(w, { body: "x".repeat(2001) })).toThrow(/2000/);
    expect(() => draft(w, { crop: { mime: "image/gif" as never, base64: "AAAA" } })).toThrow(/PNG or JPEG/);
    expect(() => draft(w, { crop: { mime: "image/png", base64: Buffer.alloc(1024 * 1024 + 1).toString("base64") } })).toThrow(/1 MB/);
    const withCrop = draft(w, { crop: { mime: "image/png", base64: Buffer.from("PNGBYTES").toString("base64") } });
    expect(withCrop.crop_mime).toBe("image/png");
    expect(new TextDecoder().decode(w.store.annotationCrop(withCrop.id)!.bytes)).toBe("PNGBYTES");
  });

  test("an artifact from a Bot↔Bot direct hangs on your direct with that Bot", () => {
    const w = world();
    const botDm = w.store.createBotDirect(w.bot.id, w.other.id, { sessionId: w.group, messageId: w.delivery.id });
    const handoff = w.store.insertMessage({ sessionId: botDm.id, kind: "bot", author: w.other.id, body: "改好了 report.md", paths: ["report.md"] });
    const a = draft(w, { target_message_id: handoff.id });
    expect(a.bot_id).toBe(w.other.id);
    expect(a.target_session_id).toBe(botDm.id);
    const mine = w.store.findDirectSession(USER_MEMBER, w.other.id)!;
    expect(a.session_id).toBe(mine.id);
  });
});

describe("editing", () => {
  test("a draft changes body, anchor, and crop; a sent one only its state", () => {
    const w = world();
    const a = draft(w);
    const edited = w.store.patchAnnotation(a.id, { body: "改短一点", anchor: { ...anchor, end_col: 6, quote: "first" } });
    expect(edited.body).toBe("改短一点");
    expect((edited.anchor as TextRangeAnchor).quote).toBe("first");
    expect(() => w.store.patchAnnotation(a.id, { status: "resolved" })).toThrow(/draft is sent/);
    expect(() => w.store.patchAnnotation(a.id, {})).toThrow(/at least one field/);
    w.store.sendAnnotations({ session_id: w.direct, body: "看看", annotation_ids: [a.id] });
    expect(() => w.store.patchAnnotation(a.id, { body: "再改" })).toThrow(/only changes state/);
    const resolved = w.store.patchAnnotation(a.id, { status: "resolved" });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_by).toBe(USER_MEMBER);
    expect(resolved.resolved_at).not.toBeNull();
    const reopened = w.store.patchAnnotation(a.id, { status: "open" });
    expect(reopened.status).toBe("open");
    expect(reopened.resolved_by).toBeNull();
  });

  test("only a draft can be deleted", () => {
    const w = world();
    const a = draft(w);
    const b = draft(w, { body: "另一条" });
    w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [b.id] });
    expect(() => w.store.deleteAnnotation(b.id)).toThrow(/resolve it instead/);
    w.store.deleteAnnotation(a.id);
    expect(() => w.store.getAnnotation(a.id)).toThrow(/not found/);
  });

  test("a Bot resolves with a note, once, and never a draft", () => {
    const w = world();
    const a = draft(w);
    expect(() => w.store.resolveAnnotationByBot(a.id, w.bot.id, "改了")).toThrow(/not been sent/);
    w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id] });
    expect(() => w.store.resolveAnnotationByBot(a.id, w.bot.id, "  ")).toThrow(/note is required/);
    const done = w.store.resolveAnnotationByBot(a.id, w.bot.id, "缩成一句");
    expect(done).toMatchObject({ status: "resolved", resolved_by: w.bot.id, resolved_note: "缩成一句" });
    expect(() => w.store.resolveAnnotationByBot(a.id, w.bot.id, "再来")).toThrow(/already resolved/);
  });
});

describe("sending a batch", () => {
  test("quotes the delivery's root, names the Bot once, and opens the drafts", () => {
    const w = world();
    const a = draft(w);
    const b = draft(w, { body: "还有这里" });
    const { message, annotations } = w.store.sendAnnotations({ session_id: w.direct, body: `@${w.bot.name} 两处请改`, annotation_ids: [a.id, b.id] });
    expect(message.kind).toBe("user");
    expect(message.parent_id).toBe(w.delivery.id);
    expect(message.body).toBe(`@${w.bot.name} 两处请改`);
    expect(message.annotation_source_message_id ?? null).toBeNull();
    expect(message.task_id).toBe(w.delivery.task_id);
    expect(annotations.map((x) => x.status)).toEqual(["open", "open"]);
    expect(annotations.every((x) => x.message_id === message.id)).toBe(true);
    expect(w.store.annotationsOfMessage(message.id)).toHaveLength(2);
  });

  test("prepends the Bot's name when the summary does not name it, and works with no summary", () => {
    const w = world();
    const a = draft(w);
    expect(w.store.sendAnnotations({ session_id: w.direct, body: "看看", annotation_ids: [a.id] }).message.body).toBe(`@${w.bot.name} 看看`);
    const b = draft(w);
    expect(w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [b.id] }).message.body).toBe(`@${w.bot.name}`);
  });

  test("a delivery that is itself a reply is quoted through its root", () => {
    const w = world();
    const root = w.store.postMessage(w.direct, { body: "起个头" });
    const reply = w.store.insertMessage({ sessionId: w.direct, turnId: w.delivery.turn_id, parentId: root.id, kind: "bot", author: w.bot.id, body: "回在这里 report.md", paths: ["report.md"] });
    const a = draft(w, { target_message_id: reply.id });
    const { message } = w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id] });
    expect(message.parent_id).toBe(root.id);
  });

  test("refuses a mixed, oversized, or already sent batch, as a whole", () => {
    const w = world();
    const a = draft(w);
    const botDm = w.store.createBotDirect(w.bot.id, w.other.id, { sessionId: w.group, messageId: w.delivery.id });
    const handoff = w.store.insertMessage({ sessionId: botDm.id, kind: "bot", author: w.other.id, body: "改好了 report.md", paths: ["report.md"] });
    const elsewhere = draft(w, { target_message_id: handoff.id });
    expect(() => w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id, elsewhere.id] })).toThrow(/not for this session/);
    expect(w.store.getAnnotation(a.id).status).toBe("draft");
    expect(() => w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [] })).toThrow(/at least one/);
    const many = Array.from({ length: 51 }, (_, i) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0")}`);
    expect(() => w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: many })).toThrow(/at most 50/);
    w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id] });
    expect(() => w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id] })).toThrow(/already sent/);
    expect(() => w.store.sendAnnotations({ session_id: botDm.id, body: "", annotation_ids: [elsewhere.id] })).toThrow(/not in this session/);
  });

  test("a batch on a Bot↔Bot artifact lands in your direct with a pointer back", () => {
    const w = world();
    const botDm = w.store.createBotDirect(w.bot.id, w.other.id, { sessionId: w.group, messageId: w.delivery.id });
    const handoff = w.store.insertMessage({ sessionId: botDm.id, kind: "bot", author: w.other.id, body: "改好了 report.md", paths: ["report.md"] });
    const a = draft(w, { target_message_id: handoff.id });
    const { message } = w.store.sendAnnotations({ session_id: a.session_id, body: "标题呢", annotation_ids: [a.id] });
    expect(message.session_id).toBe(w.store.findDirectSession(USER_MEMBER, w.other.id)!.id);
    expect(message.parent_id).toBeNull();
    expect(message.annotation_source_message_id).toBe(handoff.id);
    expect(message.body).toBe(`@${w.other.name} 标题呢`);
  });

  test("a group batch across two Bots names both and quotes the newest delivery", () => {
    const w = world();
    const first = w.store.insertMessage({ sessionId: w.group, kind: "bot", author: w.bot.id, body: "初稿 report.md", paths: ["report.md"] });
    const second = w.store.insertMessage({ sessionId: w.group, kind: "bot", author: w.other.id, body: "修订 report.md", paths: ["report.md"] });
    const a = draft(w, { target_message_id: first.id });
    const b = draft(w, { target_message_id: second.id });
    const { message } = w.store.sendAnnotations({ session_id: w.group, body: "都看下", annotation_ids: [a.id, b.id] });
    expect(message.parent_id).toBe(second.id);
    expect(message.body).toBe(`@${w.bot.name} @${w.other.name} 都看下`);
  });
});

describe("the turn a batch wakes", () => {
  test("works in the delivery's folder even after the quiet period, and even from your direct", () => {
    const w = world();
    // Long after the delivery: an ordinary follow-up would open a fresh folder.
    const later = new Date(Date.now() + TASK_QUIET_MS * 2);
    const fresh = w.store.postMessage(w.direct, { body: "另一件事" });
    const unrelated = w.store.createTurn({ sessionId: w.direct, botId: w.bot.id, triggerMessageId: fresh.id, newTask: true });
    expect(unrelated.task_id).not.toBe(w.delivery.task_id);
    w.store.setTurnStatus(unrelated.id, "completed");
    expect(w.store.getTask(w.delivery.task_id).closed_at).not.toBeNull();

    const a = draft(w);
    const { message } = w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id] });
    // Named outright, the job wins over the quiet window and over the session's open dir.
    expect(w.store.resolveTurnTask({ sessionId: w.direct, trigger: message, taskId: w.delivery.task_id, now: later })).toBe(w.delivery.task_id);
    const turn = w.store.createTurn({ sessionId: w.direct, botId: w.bot.id, triggerMessageId: message.id });
    expect(turn.task_id).toBe(w.delivery.task_id);
    // Reopened, and the session's other open job closed: one open dir per session.
    expect(w.store.getTask(w.delivery.task_id).closed_at).toBeNull();
    expect(w.store.getTask(unrelated.task_id!).closed_at).not.toBeNull();
  });

  test("a batch from your direct on a Bot↔Bot artifact continues that job", () => {
    const w = world();
    const botDm = w.store.createBotDirect(w.bot.id, w.other.id, { sessionId: w.group, messageId: w.delivery.id });
    const opener = w.store.insertMessage({ sessionId: botDm.id, turnId: w.delivery.turn_id, kind: "bot", author: w.bot.id, body: "帮我改 report.md", paths: ["report.md"] });
    const handoffTurn = w.store.createTurn({ sessionId: botDm.id, botId: w.other.id, triggerMessageId: opener.id });
    const handoff = w.store.insertMessage({ sessionId: botDm.id, turnId: handoffTurn.id, kind: "bot", author: w.other.id, body: "改好了 report.md", paths: ["report.md"] });
    w.store.setTurnStatus(handoffTurn.id, "completed");
    const a = draft(w, { target_message_id: handoff.id });
    const { message } = w.store.sendAnnotations({ session_id: a.session_id, body: "", annotation_ids: [a.id] });
    const turn = w.store.createTurn({ sessionId: message.session_id, botId: w.other.id, triggerMessageId: message.id });
    expect(turn.task_id).toBe(handoffTurn.task_id);
    expect(turn.task_id).toBe(w.delivery.task_id);
  });
});

describe("stale", () => {
  test("is computed on every read: fresh, moved, changed, missing", () => {
    const w = world();
    const a = draft(w);
    expect(w.store.getAnnotation(a.id).stale).toBeNull();
    w.write("report.md", "# Title\n\nintro\n\nfirst paragraph\n\nsecond paragraph\n");
    expect(w.store.getAnnotation(a.id).stale).toEqual({ kind: "moved", start_line: 5, start_col: 1, end_line: 5, end_col: 16 });
    w.write("report.md", "# Title\n\nsecond paragraph\n");
    expect(w.store.listAnnotations({ relpath: "report.md" })[0]!.stale).toEqual({ kind: "changed" });
    rmSync(join(w.root, "report.md"));
    expect(w.store.getAnnotation(a.id).stale).toEqual({ kind: "missing" });
  });

  test("lists filter by path, session, message, target, and status", () => {
    const w = world();
    const a = draft(w);
    const b = draft(w, { body: "b" });
    w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [b.id] });
    expect(w.store.listAnnotations({ status: "draft" }).map((x) => x.id)).toEqual([a.id]);
    expect(w.store.listAnnotations({ status: "open" }).map((x) => x.id)).toEqual([b.id]);
    expect(w.store.listAnnotations({ relpath: "./report.md" })).toHaveLength(2);
    expect(w.store.listAnnotations({ target_message_id: w.delivery.id })).toHaveLength(2);
    expect(w.store.listAnnotations({ session_id: w.group })).toHaveLength(0);
    expect(w.store.listAnnotations({ target_session_id: w.direct })).toHaveLength(2);
    expect(w.store.openAnnotationCount("report.md")).toBe(1);
    expect(() => w.store.listAnnotations({ status: "weird" as never })).toThrow(/status/);
  });
});

describe("events and deletion", () => {
  test("create, patch, send, and delete each ride the journal", () => {
    const w = world();
    const seen: ClientEvent[] = [];
    w.store.onCommit((event) => seen.push(event));
    const a = draft(w);
    expect(seen.filter((e) => e.event === "annotation.upsert").map((e) => (e as { id: string }).id)).toEqual([a.id]);
    seen.length = 0;
    w.store.patchAnnotation(a.id, { body: "改" });
    expect(seen.some((e) => e.event === "annotation.upsert" && (e as Annotation).body === "改")).toBe(true);
    seen.length = 0;
    w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id] });
    expect(seen.some((e) => e.event === "message.created")).toBe(true);
    expect(seen.some((e) => e.event === "annotation.upsert" && (e as Annotation).status === "open")).toBe(true);
    const b = draft(w);
    seen.length = 0;
    w.store.deleteAnnotation(b.id);
    expect(seen).toContainEqual(expect.objectContaining({ event: "annotation.removed", id: b.id }));
  });

  test("clearing the history and deleting a session take their annotations along", () => {
    const w = world();
    const a = draft(w);
    w.store.sendAnnotations({ session_id: w.direct, body: "", annotation_ids: [a.id] });
    w.store.clearSessionMessages(w.direct);
    expect(w.store.listAnnotations()).toHaveLength(0);

    const first = w.store.insertMessage({ sessionId: w.group, kind: "bot", author: w.bot.id, body: "初稿 report.md", paths: ["report.md"] });
    const b = draft(w, { target_message_id: first.id });
    expect(w.store.listAnnotations({ session_id: w.group })).toHaveLength(1);
    w.store.deleteSession(w.group);
    expect(() => w.store.getAnnotation(b.id)).toThrow(/not found/);

    // A delivery in a Bot↔Bot direct whose batch went to your direct: clearing either end removes it.
    const botDm = w.store.createBotDirect(w.bot.id, w.other.id, { sessionId: w.direct, messageId: w.delivery.id });
    const handoff = w.store.insertMessage({ sessionId: botDm.id, kind: "bot", author: w.other.id, body: "改好了 report.md", paths: ["report.md"] });
    const c = draft(w, { target_message_id: handoff.id });
    w.store.clearSessionMessages(botDm.id);
    expect(() => w.store.getAnnotation(c.id)).toThrow(/not found/);
  });

  test("a deleted file keeps its annotations, marked missing", () => {
    const w = world();
    const a = draft(w);
    rmSync(join(w.root, "report.md"));
    expect(w.store.getAnnotation(a.id).stale).toEqual({ kind: "missing" });
  });
});
