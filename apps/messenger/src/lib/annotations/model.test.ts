import { expect, test } from "bun:test";
import type { Annotation } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, anAttachment } from "../test-fixtures.ts";
import {
  annotateGate,
  annotationsByMessage,
  annotationsForFile,
  contentShaFromEtag,
  deliveryFor,
  destinationLabel,
  draftsForView,
  filterAnnotations,
  groupByDestination,
  positionLabel,
  resolverName,
  staleLabel,
  statusLabel,
  targetFromMessage,
} from "./model.ts";

const t = copyFor("zh");

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "report.md",
    anchor_kind: "text_range",
    anchor: { start_line: 3, start_col: 1, end_line: 3, end_col: 16, quote: "first paragraph", prefix: "", suffix: "" },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "sess-1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "sess-1",
    message_id: "m2",
    body: "太长",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

test("filters by status, and lists a file's rows in reading order", () => {
  const rows = [
    row({ id: "later", created_at: "2026-09-23T00:00:02.000Z", anchor: { start_line: 9, start_col: 1, end_line: 9, end_col: 2, quote: "x", prefix: "", suffix: "" } }),
    row({ id: "draft", status: "draft", anchor: { start_line: 1, start_col: 1, end_line: 1, end_col: 2, quote: "#", prefix: "", suffix: "" } }),
    row({ id: "moved", stale: { kind: "moved", start_line: 5, start_col: 1, end_line: 5, end_col: 2 }, anchor: { start_line: 20, start_col: 1, end_line: 20, end_col: 2, quote: "y", prefix: "", suffix: "" } }),
    row({ id: "other", relpath: "cover.png", anchor_kind: "image_region", anchor: { x: 0, y: 0, w: 1, h: 1, natural_width: 1, natural_height: 1 } }),
  ];
  expect(filterAnnotations(rows, "draft").map((r) => r.id)).toEqual(["draft"]);
  expect(filterAnnotations(rows, "open").map((r) => r.id)).toEqual(["later", "moved", "other"]);
  expect(filterAnnotations(rows, "all")).toHaveLength(4);
  expect(annotationsForFile(rows, "report.md").map((r) => r.id)).toEqual(["draft", "moved", "later"]);
});

test("cards index by the message that carries them, drafts stay out", () => {
  const rows = [row({ id: "a", message_id: "m2" }), row({ id: "b", message_id: "m2", created_at: "2026-09-22T00:00:00.000Z" }), row({ id: "c", status: "draft", message_id: null })];
  const index = annotationsByMessage(rows);
  expect(index.get("m2")?.map((r) => r.id)).toEqual(["b", "a"]);
  expect(index.size).toBe(1);
});

test("the drafts a view can send are the ones on this session's deliveries, grouped by where they go", () => {
  const rows = [
    row({ id: "mine", status: "draft", message_id: null, target_session_id: "sess-1", session_id: "sess-1" }),
    row({ id: "botbot", status: "draft", message_id: null, target_session_id: "botbot-1", session_id: "direct-1", bot_id: "bot-2" }),
    row({ id: "sent", status: "open" }),
  ];
  expect(draftsForView(rows, "sess-1").map((r) => r.id)).toEqual(["mine"]);
  expect(draftsForView(rows, "botbot-1").map((r) => r.id)).toEqual(["botbot"]);
  expect(draftsForView(rows, null)).toEqual([]);
  const groups = groupByDestination(draftsForView(rows, "botbot-1"));
  expect(groups).toEqual([{ sessionId: "direct-1", botIds: ["bot-2"], drafts: [rows[1]] }]);
});

test("labels: status, stale, position, resolver, and the destination line", () => {
  expect(statusLabel(t, "draft")).toBe("草稿");
  expect(statusLabel(t, "open")).toBe("待处理");
  expect(statusLabel(t, "resolved")).toBe("已处理");
  expect(staleLabel(t, row(), "zh")).toBeNull();
  expect(staleLabel(t, row({ stale: { kind: "missing" } }), "zh")).toBe("文件不在了");
  expect(staleLabel(t, row({ stale: { kind: "changed" } }), "zh")).toBe("原文已变");
  expect(staleLabel(t, row({ stale: { kind: "moved", start_line: 5, start_col: 1, end_line: 6, end_col: 2 } }), "zh")).toBe("原文已变，现在在第 5–6 行");
  expect(positionLabel(row(), "en")).toBe("line 3");
  const bots = new Map([["bot-1", { name: "Writer" }]]);
  expect(resolverName(row(), bots, t)).toBeNull();
  expect(resolverName(row({ resolved_by: "user" }), bots, t)).toBe("你");
  expect(resolverName(row({ resolved_by: "bot-1" }), bots, t)).toBe("Writer");
  expect(resolverName(row({ resolved_by: "gone" }), bots, t)).toBe(t.top.deleted);
  expect(destinationLabel(t, "sess-1", "sess-1", bots, ["bot-1"], [])).toBeNull();
  expect(destinationLabel(t, "direct-1", "botbot-1", bots, ["bot-1"], [aDirect({ id: "direct-1" })])).toBe("将发到你和 Writer 的私聊");
});

test("the hash comes out of the ETag, or not at all", () => {
  expect(contentShaFromEtag(`"${"a".repeat(64)}"`)).toBe("a".repeat(64));
  expect(contentShaFromEtag(`W/"${"A".repeat(64)}"`)).toBe("a".repeat(64));
  expect(contentShaFromEtag('"short"')).toBeNull();
  expect(contentShaFromEtag(null)).toBeNull();
});

test("the target is the Bot message the preview was opened from, or the latest Bot message citing the path", () => {
  const bot = aBot();
  const delivery = aMessage({ id: "m-old", kind: "bot", author: bot.id, session_id: "sess-1", task_id: "task-1", created_at: "2026-09-23T00:00:00.000Z", attachments: [anAttachment({ message_id: "m-old", workspace_relpath: "report.md" })] });
  // A bare line is how a stored handoff cites a file; prose that merely names it does not.
  const newer = aMessage({ id: "m-new", kind: "bot", author: bot.id, session_id: "sess-1", task_id: "task-2", created_at: "2026-09-23T00:01:00.000Z", body: "改好了\n附件：report.md" });
  const mine = aMessage({ id: "m-me", kind: "user", session_id: "sess-1", created_at: "2026-09-23T00:02:00.000Z", body: "report.md" });
  const elsewhere = aMessage({ id: "m-else", kind: "bot", author: bot.id, session_id: "sess-2", created_at: "2026-09-23T00:03:00.000Z", body: "report.md" });
  expect(targetFromMessage(delivery)).toEqual({ messageId: "m-old", sessionId: "sess-1", turnId: null, botId: bot.id });
  expect(targetFromMessage(mine)).toBeNull();
  expect(targetFromMessage(null)).toBeNull();
  const messages = [delivery, newer, mine, elsewhere];
  expect(deliveryFor(messages, "report.md", { sessionId: "sess-1" })?.id).toBe("m-new");
  expect(deliveryFor(messages, "report.md", { sessionId: "sess-1", taskId: "task-1" })?.id).toBe("m-old");
  expect(deliveryFor(messages, "report.md", { sessionId: "sess-1", taskId: "task-9" })?.id).toBe("m-new");
  expect(deliveryFor(messages, "nowhere.md", { sessionId: "sess-1" })).toBeNull();
  expect(deliveryFor(messages, "report.md", { sessionId: null })).toBeNull();
});

test("the gate: text in source mode with a target and no unsaved edits", () => {
  const target = { messageId: "m1", sessionId: "s1", turnId: null, botId: "bot-1" };
  expect(annotateGate({ target, kind: "text", sourceMode: true, dirty: false })).toEqual({ ok: true });
  expect(annotateGate({ target, kind: "markdown", sourceMode: true, dirty: false })).toEqual({ ok: true });
  expect(annotateGate({ target, kind: "markdown", sourceMode: false, dirty: false })).toEqual({ ok: false, reason: "kind" });
  expect(annotateGate({ target, kind: "image", sourceMode: false, dirty: false })).toEqual({ ok: false, reason: "kind" });
  expect(annotateGate({ target: null, kind: "text", sourceMode: true, dirty: false })).toEqual({ ok: false, reason: "no-target" });
  expect(annotateGate({ target, kind: "text", sourceMode: true, dirty: true })).toEqual({ ok: false, reason: "dirty" });
});
