import { afterEach, expect, test } from "bun:test";
import { runCollabTool, type ToolCtx } from "../collab-tools";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(level: number = ENGINE_LEVELS.learning) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const skill = store.createSkill({ bot_id: reviewer.bot.id, name: "镜头交界连贯性审查", description: "相邻两镜的首尾帧对机位、光线、人物位置",
    body: "1. 取前一镜尾帧和后一镜首帧\n2. 比对机位", uses: [] });
  const ctx = (botId: string, sessionId: string): ToolCtx => ({ store, botId, sessionId, turnId: "turn_1", parentId: null });
  return { store, reviewer, director, skill, ctx };
}

test("a skill you share is a copy every other Bot reads; a Bot's own skill of the name comes first", async () => {
  const f = fixture();
  expect(f.store.sharedSkillsFor(f.director.bot.id)).toEqual([]);
  const shared = f.store.shareSkill(f.skill.id);
  expect(shared).toMatchObject({ name: "镜头交界连贯性审查", source_bot_id: f.reviewer.bot.id, source_bot_name: "审片员", enabled: true, source_changed: false });
  expect(f.store.sharedSkillsFor(f.director.bot.id).map((skill) => skill.name)).toEqual(["镜头交界连贯性审查"]);
  // The owner reads its own, not the copy.
  expect(f.store.sharedSkillsFor(f.reviewer.bot.id)).toEqual([]);
  const read = await runCollabTool(f.ctx(f.director.bot.id, f.director.direct_session.id), "read_skill", { name: "镜头交界连贯性审查" });
  expect(read).toMatchObject({ ok: true, data: { body: "1. 取前一镜尾帧和后一镜首帧\n2. 比对机位", shared: true, from: "审片员" } });
  // Not the director's to change.
  const update = await runCollabTool(f.ctx(f.director.bot.id, f.director.direct_session.id), "update_skill", { name: "镜头交界连贯性审查", body: "x" });
  expect(update.ok).toBe(false);
  f.store.createSkill({ bot_id: f.director.bot.id, name: "镜头交界连贯性审查", description: "我自己的", body: "自己的做法", uses: [] });
  expect(f.store.sharedSkillsFor(f.director.bot.id)).toEqual([]);
});

test("the owner's later edits reach the others only when you share it again", () => {
  const f = fixture();
  const shared = f.store.shareSkill(f.skill.id);
  f.store.db.run("UPDATE skills SET body = '改过的做法', updated_at = ? WHERE id = ?", [new Date(Date.now() + 60_000).toISOString(), f.skill.id]);
  expect(f.store.getSharedSkill(shared.id)).toMatchObject({ body: "1. 取前一镜尾帧和后一镜首帧\n2. 比对机位", source_changed: true });
  const again = f.store.shareSkill(f.skill.id);
  expect(again).toMatchObject({ id: shared.id, body: "改过的做法" });
});

test("a project skill can be turned off, unshared, refused below level 8, and its name is the project's", () => {
  const f = fixture();
  const shared = f.store.shareSkill(f.skill.id);
  f.store.setSharedSkillEnabled(shared.id, false);
  expect(f.store.sharedSkillsFor(f.director.bot.id)).toEqual([]);
  f.store.setSharedSkillEnabled(shared.id, true);
  const other = f.store.createSkill({ bot_id: f.director.bot.id, name: "镜头交界连贯性审查", description: "同名", body: "另一份", uses: [] });
  expect(() => f.store.shareSkill(other.id)).toThrow("already shared");
  f.store.unshareSkill(shared.id);
  expect(f.store.listSharedSkills()).toEqual([]);
  expect(f.store.getSkill(f.skill.id).name).toBe("镜头交界连贯性审查");
  const low = fixture(ENGINE_LEVELS.routing);
  expect(() => low.store.shareSkill(low.skill.id)).toThrow("engine level 8");
});

test("a deleted owner's copy reads as from a deleted Bot, its skills cannot be shared, and a turned-off own skill does not hide the project's", () => {
  const f = fixture();
  const shared = f.store.shareSkill(f.skill.id);
  f.store.deleteBot(f.reviewer.bot.id);
  expect(f.store.getSharedSkill(shared.id)).toMatchObject({ source_bot_name: null, enabled: true });
  const other = fixture();
  other.store.deleteBot(other.reviewer.bot.id);
  expect(() => other.store.shareSkill(other.skill.id)).toThrow("skill not found");
  const g = fixture();
  g.store.shareSkill(g.skill.id);
  const own = g.store.createSkill({ bot_id: g.director.bot.id, name: "镜头交界连贯性审查", description: "我的", body: "我的", uses: [] });
  expect(g.store.sharedSkillsFor(g.director.bot.id)).toEqual([]);
  g.store.db.run("UPDATE skills SET enabled = 0 WHERE id = ?", [own.id]);
  expect(g.store.sharedSkillsFor(g.director.bot.id).map((skill) => skill.name)).toEqual(["镜头交界连贯性审查"]);
});

test("at most twenty project skills are on at once", () => {
  const f = fixture();
  for (let i = 0; i < 20; i += 1) {
    f.store.db.run(`INSERT INTO shared_skills (id, name, description, body, uses, enabled, confirmed_at, created_at, updated_at) VALUES (?, ?, 'd', 'b', '[]', 1, ?, ?, ?)`,
      [`s${i}`, `skill ${i}`, "2026-10-03", "2026-10-03", "2026-10-03"]);
  }
  expect(() => f.store.shareSkill(f.skill.id)).toThrow("at most 20");
  f.store.setSharedSkillEnabled("s0", false);
  const shared = f.store.shareSkill(f.skill.id);
  expect(() => f.store.setSharedSkillEnabled("s0", true)).toThrow("at most 20");
  expect(shared.enabled).toBe(true);
});
