import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(level: number = ENGINE_LEVELS.learning) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const bot = store.createBot({ name: "Maker", duties: "make", boundaries: "none" });
  const trigger = store.insertMessage({ sessionId: bot.direct_session.id, kind: "system", author: bot.bot.id, body: "工作" });
  // Each its own turn, the one before it over.
  const turn = (_n: number) => {
    const id = store.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: trigger.id }).id;
    store.setTurnStatus(id, "completed");
    return id;
  };
  return { store, botId: bot.bot.id, turn };
}

const timeout = { workspace: "/ws", signature: "grep -r@home", head: "grep -r", place: "home", seconds: 600 };

test("a lesson you retire stops holding calls back; it can come back unless another took its place", () => {
  const f = fixture();
  const first = f.turn(0);
  const lesson = f.store.noteShellTimeout({ turnId: first, botId: f.botId, ...timeout, overriding: null })!;
  expect(lesson).toMatchObject({ action: "warn", status: "active", text: expect.stringContaining("整个家目录") });
  const next = f.turn(1);
  expect(f.store.checkShellLesson({ turnId: next, botId: f.botId, workspace: timeout.workspace, signature: timeout.signature }).refuse).toContain(`lesson ${lesson.id}`);
  f.store.updateLesson(lesson.id, { status: "retired" });
  expect(f.store.checkShellLesson({ turnId: f.turn(2), botId: f.botId, workspace: timeout.workspace, signature: timeout.signature })).toEqual({ refuse: null, overriding: null });
  // Learned again while retired: a new lesson, and the old one cannot come back beside it.
  const again = f.store.noteShellTimeout({ turnId: f.turn(3), botId: f.botId, ...timeout, overriding: null })!;
  expect(again.id).not.toBe(lesson.id);
  expect(() => f.store.updateLesson(lesson.id, { status: "active" })).toThrow("already active");
  f.store.updateLesson(again.id, { action: "block", text: "  不许在家目录递归搜索。 " });
  expect(f.store.getLesson(again.id)).toMatchObject({ action: "block", text: "不许在家目录递归搜索。" });
  expect(() => f.store.updateLesson("missing", { status: "retired" })).toThrow("lesson not found");
});

test("a warning counts as prevented until the Bot insists; a block counts every refusal", () => {
  const f = fixture();
  const lesson = f.store.noteShellTimeout({ turnId: f.turn(0), botId: f.botId, ...timeout, overriding: null })!;
  const turn = f.turn(1);
  f.store.checkShellLesson({ turnId: turn, botId: f.botId, workspace: timeout.workspace, signature: timeout.signature });
  expect(f.store.getLesson(lesson.id)).toMatchObject({ hits: 1, prevented: 1, recurrences: 0 });
  expect(f.store.checkShellLesson({ turnId: turn, botId: f.botId, workspace: timeout.workspace, signature: timeout.signature })).toEqual({ refuse: null, overriding: lesson.id });
  expect(f.store.getLesson(lesson.id)).toMatchObject({ hits: 1, prevented: 0 });
  // Timing out on a call it was not insisting on leaves the lesson as it is.
  f.store.noteShellTimeout({ turnId: turn, botId: f.botId, ...timeout, overriding: null });
  expect(f.store.getLesson(lesson.id)).toMatchObject({ action: "warn", recurrences: 0 });
  f.store.noteShellTimeout({ turnId: turn, botId: f.botId, ...timeout, overriding: lesson.id });
  expect(f.store.getLesson(lesson.id)).toMatchObject({ action: "block", recurrences: 1 });
  expect(f.store.checkShellLesson({ turnId: turn, botId: f.botId, workspace: timeout.workspace, signature: timeout.signature }).refuse).toContain("will not run as it is");
  expect(f.store.getLesson(lesson.id)).toMatchObject({ hits: 2, prevented: 1 });
});

test("below level 8 no lesson is learned or checked", () => {
  const f = fixture(ENGINE_LEVELS.routing);
  expect(f.store.noteShellTimeout({ turnId: f.turn(0), botId: f.botId, ...timeout, overriding: null })).toBeNull();
  expect(f.store.checkShellLesson({ turnId: f.turn(1), botId: f.botId, workspace: timeout.workspace, signature: timeout.signature })).toEqual({ refuse: null, overriding: null });
  expect(f.store.listLessons()).toEqual([]);
});

test("a lesson counts each turn once: a turn that insisted takes back its own warning only, and retries against a block count once", () => {
  const f = fixture();
  const lesson = f.store.noteShellTimeout({ turnId: f.turn(0), botId: f.botId, ...timeout, overriding: null })!;
  const check = (turn: string) => f.store.checkShellLesson({ turnId: turn, botId: f.botId, workspace: timeout.workspace, signature: timeout.signature });
  const a = f.turn(1);
  const b = f.turn(2);
  check(a);
  check(b);
  expect(f.store.getLesson(lesson.id)).toMatchObject({ hits: 2, prevented: 2 });
  for (let i = 0; i < 3; i += 1) expect(check(a).refuse).toBeNull();
  expect(f.store.getLesson(lesson.id)).toMatchObject({ hits: 2, prevented: 1 });
  f.store.updateLesson(lesson.id, { action: "block" });
  const c = f.turn(3);
  for (let i = 0; i < 3; i += 1) expect(check(c).refuse).toContain("will not run");
  expect(f.store.getLesson(lesson.id)).toMatchObject({ hits: 3, prevented: 2 });
});

test("a lesson is the workspace's: another workspace path learns its own", () => {
  const f = fixture();
  f.store.noteShellTimeout({ turnId: f.turn(0), botId: f.botId, ...timeout, overriding: null });
  expect(f.store.checkShellLesson({ turnId: f.turn(1), botId: f.botId, workspace: "/other", signature: timeout.signature })).toEqual({ refuse: null, overriding: null });
  expect(f.store.listLessons()).toMatchObject([{ scope: "project", scope_id: "/ws" }]);
});
