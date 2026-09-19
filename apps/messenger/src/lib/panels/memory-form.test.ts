import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aGroup, aMemory } from "../test-fixtures.ts";
import {
  mapMemoryError,
  memoryAgeLabel,
  memoryDraftDirty,
  planMemory,
  reconcileMemoryDraft,
  resolveMemoryOrigin,
} from "./memory-form.ts";

const t = copyFor("zh");
const bots = new Map([
  ["bot-1", aBot({ id: "bot-1", name: "Writer" })],
  ["bot-2", aBot({ id: "bot-2", name: "Researcher" })],
]);

test("a plan trims and refuses empty fields", () => {
  expect(planMemory({ subject: "  用户的时区 ", body: " UTC+8 " }, t)).toEqual({
    ok: true,
    body: { subject: "用户的时区", body: "UTC+8" },
  });
  const empty = planMemory({ subject: "  ", body: "" }, t);
  expect(empty.ok).toBe(false);
  if (empty.ok) return;
  expect(empty.errors.subject).toBe(t.sidebar.memorySubjectEmpty);
  expect(empty.errors.body).toBe(t.sidebar.memoryBodyEmpty);
});

test("a subject clash lands on the subject field", () => {
  expect(mapMemoryError(409, t).subject).toBe(t.sidebar.memorySubjectConflict);
  expect(mapMemoryError(500, t)).toEqual({});
});

/** The Bot can rewrite a memory while you are editing it. */
test("a live update replaces a clean draft but never a dirty one", () => {
  const baseline = { subject: "a", body: "b" };
  const incoming = aMemory({ subject: "a2", body: "b2" });

  const clean = reconcileMemoryDraft({ subject: "a", body: "b" }, baseline, incoming);
  expect(clean.draft).toEqual({ subject: "a2", body: "b2" });

  const dirty = reconcileMemoryDraft({ subject: "mine", body: "b" }, baseline, incoming);
  expect(dirty.draft).toEqual({ subject: "mine", body: "b" });
  expect(dirty.baseline).toEqual({ subject: "a2", body: "b2" });
  expect(memoryDraftDirty(dirty.draft, dirty.baseline)).toBe(true);
});

test("age falls into the same buckets the prompt uses", () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const at = (iso: string) => memoryAgeLabel(iso, t, now);
  expect(at("2026-09-20T00:00:00.000Z")).toBe(t.sidebar.memoryAgeToday);
  expect(at("2026-09-17T00:00:00.000Z")).toBe(t.sidebar.memoryAgeThisWeek);
  expect(at("2026-09-06T00:00:00.000Z")).toBe(t.sidebar.memoryAgeWeeks(2));
  expect(at("2026-05-20T00:00:00.000Z")).toBe(t.sidebar.memoryAgeMonths(4));
});

test("a memory with no source, or one whose session is gone, reads as missing", () => {
  const byId = new Map();
  expect(resolveMemoryOrigin(aMemory({ source_session_id: null }), byId, bots, t).kind).toBe("missing");
  expect(resolveMemoryOrigin(aMemory({ source_session_id: "gone" }), byId, bots, t).kind).toBe("missing");
});

test("a Bot to Bot source is labelled as one, so you can tell you were not there", () => {
  const group = aGroup({ id: "sess-1", name: "视频组" });
  const direct = aBotDirect({ id: "botbot-1" });
  const byId = new Map([
    [group.id, group],
    [direct.id, direct],
  ]);

  const fromGroup = resolveMemoryOrigin(aMemory({ source_session_id: "sess-1" }), byId, bots, t);
  expect(fromGroup.kind).toBe("session");
  if (fromGroup.kind !== "session") return;
  expect(fromGroup.label).toBe("视频组");

  const fromDirect = resolveMemoryOrigin(aMemory({ source_session_id: "botbot-1" }), byId, bots, t);
  if (fromDirect.kind !== "session") return;
  expect(fromDirect.label).toContain(t.sidebar.botBot);
});
