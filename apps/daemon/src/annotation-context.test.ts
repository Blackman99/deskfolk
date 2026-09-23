/**
 * 批注在上下文窗里的样子：带批注的用户消息在正文后面逐条展开，文本带引文和重新定位后的行区间，
 * 图片带裁图像素；陈旧的标出来；判断用的短窗口不带这些。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatContentPart } from "./completions";
import { annotationContext } from "./annotation-context";
import { assembleJudgementUser, assembleTurnMessages } from "./context";
import { sha256 } from "./request-digest";
import { Store } from "./store";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const REPORT = "# Title\n\nfirst paragraph\n\nsecond paragraph\n";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "real-bot-annotation-context-"));
  roots.push(root);
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  writeFileSync(join(root, "report.md"), REPORT);
  writeFileSync(join(root, "cover.png"), PNG_1X1);
  const created = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const direct = created.direct_session.id;
  const trigger = store.postMessage(direct, { body: "写个报告和封面" });
  const turn = store.createTurn({ sessionId: direct, botId: created.bot.id, triggerMessageId: trigger.id });
  const delivery = store.insertMessage({ sessionId: direct, turnId: turn.id, kind: "bot", author: created.bot.id, body: "写好了：report.md cover.png", paths: ["report.md", "cover.png"] });
  store.setTurnStatus(turn.id, "completed");
  const text = store.createAnnotation({
    target_message_id: delivery.id,
    relpath: "report.md",
    anchor_kind: "text_range",
    anchor: { start_line: 3, start_col: 1, end_line: 3, end_col: 16, quote: "first paragraph", prefix: "# Title\n\n", suffix: "\n\nsecond" },
    content_sha256: sha256(new TextEncoder().encode(REPORT)),
    body: "这段太长了",
  });
  const image = store.createAnnotation({
    target_message_id: delivery.id,
    relpath: "cover.png",
    anchor_kind: "image_region",
    anchor: { x: 0.12, y: 0.3, w: 0.2, h: 0.15, natural_width: 2048, natural_height: 1365 },
    content_sha256: sha256(PNG_1X1),
    body: "这里的字看不清",
    crop: { mime: "image/png", base64: PNG_1X1.toString("base64") },
  });
  const { message } = store.sendAnnotations({ session_id: direct, body: "两处请改", annotation_ids: [text.id, image.id] });
  return { store, root, bot: created.bot, direct, delivery, turn, text, image, message };
}

describe("annotationContext", () => {
  test("spells out a text and an image annotation, one of them moved, with the crop as pixels", () => {
    const w = world();
    // The Bot edited the report since: the quoted paragraph moved down two lines.
    writeFileSync(join(w.root, "report.md"), "# Title\n\nintro\n\nfirst paragraph\n\nsecond paragraph\n");
    const { text, images } = annotationContext(w.store, w.message.id, "zh");
    expect(text).toBe(
      [
        "",
        "",
        `[批注 1/2 · id=${w.text.id}] report.md · 文本区间`,
        "  位置：第 3 行（原文已变，重新定位到第 5 行）",
        "  引文：first paragraph",
        "  意见：这段太长了",
        `[批注 2/2 · id=${w.image.id}] cover.png · 图片区域`,
        "  位置：x 12%–32%，y 30%–45%（原图 2048×1365，像素 246,410 → 655,614）",
        "  意见：这里的字看不清",
        "  （附区域裁图）",
      ].join("\n"),
    );
    expect(images).toHaveLength(1);
    expect((images[0] as { image_url: { url: string } }).image_url.url).toBe(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
  });

  test("marks a resolved one with who and how, in English too", () => {
    const w = world();
    w.store.resolveAnnotationByBot(w.text.id, w.bot.id, "缩成一句");
    const { text } = annotationContext(w.store, w.message.id, "en");
    expect(text).toContain(`[Annotation 1/2 · id=${w.text.id}] report.md · text range · resolved (Writer: 缩成一句)`);
    expect(text).toContain("  Where：line 3");
    expect(text).toContain("  Quote：first paragraph");
    expect(text).toContain("  Note：这段太长了");
    expect(text).toContain("  (region crop attached)");
  });

  test("says when the file is gone, and adds nothing to a message without annotations", () => {
    const w = world();
    rmSync(join(w.root, "cover.png"));
    const { text, images } = annotationContext(w.store, w.message.id, "zh");
    expect(text).toContain("  位置：x 12%–32%，y 30%–45%（原图 2048×1365，像素 246,410 → 655,614）（文件不在了）");
    expect(images).toHaveLength(1);
    expect(annotationContext(w.store, w.delivery.id, "zh")).toEqual({ text: "", images: [] });
  });
});

describe("the turn window", () => {
  test("carries the batch under the user's message with the crop as an image part; the judgement window does not", () => {
    const w = world();
    const woken = w.store.createTurn({ sessionId: w.direct, botId: w.bot.id, triggerMessageId: w.message.id });
    const messages = assembleTurnMessages(w.store, {
      sessionId: w.direct,
      botId: w.bot.id,
      turnId: woken.id,
      triggerMessageId: w.message.id,
      locale: "zh",
      interrupt: false,
      loop: [],
    });
    const batch = messages.find((m) => Array.isArray(m.content) && (m.content as ChatContentPart[]).some((part) => part.type === "text" && part.text.includes("[批注 1/2")));
    expect(batch).toBeDefined();
    const parts = batch!.content as ChatContentPart[];
    const textPart = parts.find((part) => part.type === "text") as { type: "text"; text: string };
    expect(textPart.text).toContain(`@Writer 两处请改`);
    expect(textPart.text).toContain("  意见：这段太长了");
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(1);
    // The judgement window is text only and never spells out annotations.
    const judged = assembleJudgementUser(w.store, { sessionId: w.direct, botId: w.bot.id, message: w.message, mentions: [], everyone: false });
    expect(String(judged)).not.toContain("[批注");
  });
});
