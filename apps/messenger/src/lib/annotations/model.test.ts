import { expect, test } from "bun:test";
import type { Annotation } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, anAttachment } from "../test-fixtures.ts";
import {
  annotateGate,
  annotationsByMessage,
  annotationsForFile,
  canonicalRelpath,
  contentShaFromEtag,
  deliveryFor,
  destinationLabel,
  draftsForView,
  drawnAnnotations,
  filterAnnotations,
  groupByDestination,
  mergeAnnotationRows,
  positionLabel,
  resolverName,
  staleLabel,
  statusLabel,
  targetFor,
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

test("the file draws open rows and drafts; a resolved one only when asked back or being gone to", () => {
  const rows = [row({ id: "open" }), row({ id: "draft", status: "draft" }), row({ id: "done", status: "resolved" }), row({ id: "done-2", status: "resolved" })];
  const ids = (list: Annotation[]) => list.map((r) => r.id);
  expect(ids(drawnAnnotations(rows, { showResolved: false, revealedId: null }))).toEqual(["open", "draft"]);
  // Going to a resolved row from the list draws that one row, not its neighbours.
  expect(ids(drawnAnnotations(rows, { showResolved: false, revealedId: "done" }))).toEqual(["open", "draft", "done"]);
  // Going to an open row changes nothing.
  expect(ids(drawnAnnotations(rows, { showResolved: false, revealedId: "open" }))).toEqual(["open", "draft"]);
  expect(ids(drawnAnnotations(rows, { showResolved: true, revealedId: null }))).toEqual(["open", "draft", "done", "done-2"]);
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

test("the message the preview was opened from is the target only for a path it handed over itself", () => {
  // Bot B delivered review.md; Bot A delivered draft.md earlier in the same job; you uploaded data.csv.
  const byA = aMessage({ id: "m-a", kind: "bot", author: "bot-a", session_id: "sess-1", task_id: "task-1", created_at: "2026-09-23T00:00:00.000Z", body: "初稿\n附件：work/draft.md" });
  const upload = aMessage({ id: "m-me", kind: "user", session_id: "sess-1", task_id: "task-1", created_at: "2026-09-23T00:01:00.000Z", attachments: [anAttachment({ message_id: "m-me", workspace_relpath: "work/data.csv" })] });
  const byB = aMessage({ id: "m-b", kind: "bot", author: "bot-b", session_id: "sess-1", task_id: "task-1", created_at: "2026-09-23T00:02:00.000Z", attachments: [anAttachment({ message_id: "m-b", workspace_relpath: "work/review.md" })] });
  const messages = [byA, upload, byB];
  const scope = { sessionId: "sess-1", taskId: "task-1" };
  expect(targetFor(messages, "work/review.md", byB, scope)?.messageId).toBe("m-b");
  // Walked to draft.md in the tree while the preview still hangs on B's message: it goes to A.
  expect(targetFor(messages, "work/draft.md", byB, scope)).toEqual({ messageId: "m-a", sessionId: "sess-1", turnId: null, botId: "bot-a" });
  // Your own upload was handed over by no Bot: nothing to hang it on.
  expect(targetFor(messages, "work/data.csv", byB, scope)).toBeNull();
  expect(targetFor(messages, "work/data.csv", upload, scope)).toBeNull();
  // No message it was opened from (the workspace explorer): the latest delivery.
  expect(targetFor(messages, "work/review.md", undefined, scope)?.messageId).toBe("m-b");
});

test("the gate picks the adapter for the view, needs a target, and refuses unsaved text", () => {
  const target = { messageId: "m1", sessionId: "s1", turnId: null, botId: "bot-1" };
  expect(annotateGate({ target, kind: "text", sourceMode: true, dirty: false })).toEqual({ ok: true, adapter: "text" });
  expect(annotateGate({ target, kind: "markdown", sourceMode: true, dirty: false })).toEqual({ ok: true, adapter: "text" });
  expect(annotateGate({ target, kind: "markdown", sourceMode: false, dirty: false })).toEqual({ ok: true, adapter: "markdown" });
  expect(annotateGate({ target, kind: "html", sourceMode: false, dirty: false })).toEqual({ ok: true, adapter: "html" });
  expect(annotateGate({ target, kind: "image", sourceMode: false, dirty: false })).toEqual({ ok: true, adapter: "image" });
  expect(annotateGate({ target, kind: "svg", sourceMode: false, dirty: false })).toEqual({ ok: true, adapter: "image" });
  expect(annotateGate({ target, kind: "pdf", sourceMode: false, dirty: false })).toEqual({ ok: true, adapter: "pdf" });
  expect(annotateGate({ target, kind: "video", sourceMode: false, dirty: false })).toEqual({ ok: true, adapter: "media" });
  expect(annotateGate({ target, kind: "directory", sourceMode: false, dirty: false })).toEqual({ ok: false, reason: "kind" });
  expect(annotateGate({ target: null, kind: "text", sourceMode: true, dirty: false })).toEqual({ ok: false, reason: "no-target" });
  expect(annotateGate({ target, kind: "text", sourceMode: true, dirty: true })).toEqual({ ok: false, reason: "dirty" });
  expect(annotateGate({ target, kind: "markdown", sourceMode: false, dirty: true })).toEqual({ ok: false, reason: "dirty" });
  // An image has no editor to be dirty in.
  expect(annotateGate({ target, kind: "image", sourceMode: false, dirty: true })).toEqual({ ok: true, adapter: "image" });
});

test("a reply that lands after newer events does not paint over them; a fresh read wins a tie", () => {
  const sent = row({ id: "a", status: "open", updated_at: "2026-09-23T00:00:01.000Z" });
  const resolved = row({ id: "a", status: "resolved", resolved_by: "bot-1", updated_at: "2026-09-23T00:00:02.000Z" });
  const other = row({ id: "b" });
  expect(mergeAnnotationRows([resolved, other], [sent]).find((r) => r.id === "a")?.status).toBe("resolved");
  expect(mergeAnnotationRows([sent, other], [resolved]).find((r) => r.id === "a")?.status).toBe("resolved");
  // Same instant: a write's own reply is the event's twin, a read carries the freshly computed stale.
  const twin = { ...resolved, status: "open" as const };
  expect(mergeAnnotationRows([resolved], [twin])[0]!.status).toBe("resolved");
  const reread = { ...resolved, stale: { kind: "changed" as const } };
  expect(mergeAnnotationRows([resolved], [reread], "replace")[0]!.stale).toEqual({ kind: "changed" });
  // New rows are added; nothing is dropped.
  expect(mergeAnnotationRows([other], [sent]).map((r) => r.id).sort()).toEqual(["a", "b"]);
});

test("a file's rows are found however the preview spelled its path", () => {
  expect(canonicalRelpath("./deliveries//pick.ts")).toBe("deliveries/pick.ts");
  expect(canonicalRelpath("deliveries/./pick.ts/")).toBe("deliveries/pick.ts");
  expect(canonicalRelpath("/Users/you/ws/deliveries/pick.ts", "/Users/you/ws/")).toBe("deliveries/pick.ts");
  expect(canonicalRelpath("/Users/you/wsx/pick.ts", "/Users/you/ws")).toBe("Users/you/wsx/pick.ts");
  const rows = [row({ id: "a", relpath: "deliveries/pick.ts" }), row({ id: "b", relpath: "other.ts" })];
  expect(annotationsForFile(rows, "./deliveries//pick.ts").map((r) => r.id)).toEqual(["a"]);
  expect(annotationsForFile(rows, "/Users/you/ws/deliveries/pick.ts", "/Users/you/ws").map((r) => r.id)).toEqual(["a"]);
});

test("a preview shows the rows on its own spelling and, by the resolved file, those on any other", () => {
  const rows = [
    row({ id: "own", relpath: "docs/r.ts", file_key: "docs/r.ts" }),
    row({ id: "link", relpath: "linked/r.ts", file_key: "docs/r.ts" }),
    row({ id: "other", relpath: "docs/other.ts", file_key: "docs/other.ts" }),
    row({ id: "dots", relpath: "linked/../r.ts", file_key: "x/r.ts" }),
  ];
  expect(annotationsForFile(rows, "docs/r.ts").map((r) => r.id).sort()).toEqual(["link", "own"]);
  // The key the daemon named for this path also works when this spelling has no rows of its own.
  expect(annotationsForFile(rows, "~/ws/docs/r.ts", null, "docs/r.ts").map((r) => r.id).sort()).toEqual(["link", "own"]);
  // `..` is not folded here: through a link it can name another file.
  expect(canonicalRelpath("linked/../r.ts")).toBe("linked/../r.ts");
  expect(annotationsForFile(rows, "r.ts").map((r) => r.id)).toEqual([]);
});
