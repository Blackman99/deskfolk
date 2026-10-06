import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoNow, ulid } from "../ids";
import { Store } from ".";
import { parseRetrospective, RETRO_QUIET_MS, type RetrospectiveOutcome } from "./retrospectives";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const minutes = (n: number, from: string = isoNow()) => new Date(Date.parse(from) + n * 60_000).toISOString();

/**
 * A short film the user sent back twice before accepting it: the director handed over three times,
 * the user's notes on the first two are on the record, and the plan was delivered an hour ago.
 */
function fixture(level: number = ENGINE_LEVELS.learning) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const maker = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" }).bot;
  const other = store.createBot({ name: "编剧", duties: "写剧本", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "Studio", members: [maker.id, other.id] });
  const plan = store.openTask({ sessionId: room.id, title: "选举篇短片" });
  const ticket = store.createTicket({ taskId: plan.id, title: "选举篇治愈小杰短片", worker: maker.id });
  const start = minutes(-180);
  const quote = (body: string, at: string, via = "message") => store.db.run(
    "INSERT INTO user_quotes (id, message_id, session_id, task_id, ticket_id, via, body, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
    [ulid(), room.id, plan.id, ticket.id, via, body, at]);
  quote("做一段奇犽带亚路嘉治愈小杰的短片", start);
  const handOver = (id: string, at: string, state: string, note: string) => store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id,
    part_keys, bot_id, model, turn_id, origin, artifacts, content, claims, note, state, reviews, created_at, updated_at)
    VALUES (?, NULL, ?, ?, '[]', ?, 'grk', NULL, 'submit', '[]', NULL, '[]', ?, ?, '[]', ?, ?)`, [id, plan.id, ticket.id, maker.id, note, state, at, at]);
  const sendBack = (submission: string, note: string, at: string) => {
    store.recordWorkEvent({ kind: "review.recorded", actor: "user", taskId: plan.id, ticketId: ticket.id,
      payload: { submission_id: submission, outcome: "reject", by: "user", note } });
    quote(note, at, "ask_answer");
  };
  handOver("sub-1", minutes(-150), "rejected", "真人风格成片");
  sendBack("sub-1", "动画不是真人", minutes(-140));
  handOver("sub-2", minutes(-120), "rejected", "日式动画版，中文配音");
  sendBack("sub-2", "配音用日文，而且要带感情", minutes(-110));
  handOver("sub-3", minutes(-90), "approved", "日语配音、按角色选声");
  const requirement = store.addRequirement({ scope: "plan", scopeId: plan.id, quote: "配音用日文", sourceKind: "ask_answer", addedBy: "scribe" });
  store.db.run("UPDATE requirements SET times_raised = 2 WHERE id = ?", [requirement.id]);
  // What went wrong happened before the delivery, as it does: the events are dated with the hand-overs, not with this test's clock.
  store.db.run("UPDATE quality_events SET created_at = ?", [minutes(-100)]);
  const deliveredAt = minutes(-60);
  store.db.run("UPDATE tasks SET stage = 'delivered', delivered_at = ?, status = 'done' WHERE id = ?", [deliveredAt, plan.id]);
  return { store, maker, other, room, plan, ticket, deliveredAt };
}

function outcome(over: Partial<RetrospectiveOutcome> = {}): RetrospectiveOutcome {
  return { summary: "改编片先定画风和配音语言", pitfalls: [], rework_causes: [], keep: [], earlier: [], memory: [], skills: [], ...over };
}

test("a delivered plan is looked back on by the Bot that made it once it stayed delivered half an hour, from the job's record", () => {
  const f = fixture();
  // Too soon: a complaint right after an approval reopens a plan first.
  expect(f.store.claimDueRetrospective(minutes(29, f.deliveredAt))).toBeNull();
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM retrospectives").get()).toEqual({ n: 0 });
  const due = f.store.claimDueRetrospective(minutes(RETRO_QUIET_MS / 60_000 + 1, f.deliveredAt))!;
  expect(due).toMatchObject({ botId: f.maker.id, botName: "视频导演", taskId: f.plan.id, deliveredAt: f.deliveredAt, sessionId: f.room.id });
  // The ledger entry first said in a send-back counts too: the request was not clear before the hand-over.
  expect(due.signals).toEqual(["requirement_after_delivery×1", "user_rejected×2", "handed_over_again×1"]);
  expect(due.yourWords.map((line) => line.text)).toEqual(["做一段奇犽带亚路嘉治愈小杰的短片", "动画不是真人", "配音用日文，而且要带感情"]);
  expect(due.handOvers.map((row) => [row.by, row.state, row.note, row.user_note])).toEqual([
    ["you", "rejected", "真人风格成片", "动画不是真人"],
    ["you", "rejected", "日式动画版，中文配音", "配音用日文，而且要带感情"],
    ["you", "approved", "日语配音、按角色选声", null],
  ]);
  expect(due.requirements).toEqual([expect.objectContaining({ quote: "配音用日文", times_said: 2, first_said_after_a_hand_over: true })]);
  expect(due.tickets).toEqual([{ title: "选举篇治愈小杰短片", stage: "todo", yours: true, hand_overs: 3 }]);
  expect(due.trouble.quality).toEqual({ requirement_after_delivery: 1, user_rejected: 2 });
  expect(due.memoryRoom).toBe(20);
  // Claimed: the next tick does not run it again, and the Bot that handed nothing over has nothing to look back on.
  expect(f.store.claimDueRetrospective(minutes(40, f.deliveredAt))).toBeNull();
  expect(f.store.db.query("SELECT bot_id, state FROM retrospectives").all()).toEqual([{ bot_id: f.maker.id, state: "pending" }]);
});

test("a job where nothing went wrong is set aside without a call; a routine's plan, a reopened plan and a level below 8 are not looked at", () => {
  const smooth = fixture();
  smooth.store.db.run("DELETE FROM quality_events");
  smooth.store.db.run("DELETE FROM submissions WHERE id IN ('sub-1', 'sub-2')");
  expect(smooth.store.claimDueRetrospective()).toBeNull();
  expect(smooth.store.db.query("SELECT state, note FROM retrospectives").all()).toEqual([{ state: "skipped", note: "nothing_to_learn" }]);

  const reopened = fixture();
  reopened.store.db.run("UPDATE tasks SET stage = 'active', delivered_at = NULL WHERE id = ?", [reopened.plan.id]);
  expect(reopened.store.claimDueRetrospective()).toBeNull();

  const routine = fixture();
  const job = routine.store.createRoutine({ bot_id: routine.maker.id, title: "日报", instruction: "写日报", schedule: { kind: "daily", time: "09:00" } });
  routine.store.db.run("UPDATE tasks SET routine_id = ? WHERE id = ?", [job.id, routine.plan.id]);
  expect(routine.store.claimDueRetrospective()).toBeNull();

  const low = fixture(ENGINE_LEVELS.routing);
  expect(low.store.claimDueRetrospective()).toBeNull();
  expect(low.store.taskDetail(low.plan.id, () => true).retrospectives).toBeUndefined();
});

test("under a stop it waits for the lift; a deleted Bot is set aside; the day's cap in money or in count stops it", () => {
  const held = fixture();
  const hold = held.store.createHold({ scope: "bot", scopeId: held.maker.id, source: "user_button" });
  expect(held.store.claimDueRetrospective()).toBeNull();
  expect(held.store.db.query("SELECT COUNT(*) AS n FROM retrospectives").get()).toEqual({ n: 0 });
  held.store.liftHold(hold.id, { by: "user_button" });
  expect(held.store.claimDueRetrospective()).not.toBeNull();

  const gone = fixture();
  gone.store.db.run("UPDATE bots SET deleted_at = ? WHERE id = ?", [isoNow(), gone.maker.id]);
  expect(gone.store.claimDueRetrospective()).toBeNull();
  expect(gone.store.db.query("SELECT state, note FROM retrospectives").all()).toEqual([{ state: "skipped", note: "gone" }]);

  const spent = fixture();
  spent.store.db.run(`INSERT INTO spend (id, session_id, bot_id, kind, purpose, model, cost_usd_ticks, created_at)
    VALUES ('sp', ?, ?, 'organize', 'retrospect', 'grk', 20000000000, ?)`, [spent.room.id, spent.maker.id, isoNow()]);
  expect(spent.store.claimDueRetrospective()).toBeNull();
});

test("a claim a restart left pending is failed after ten minutes, and the delivery is not looked back on twice", () => {
  const f = fixture();
  const due = f.store.claimDueRetrospective()!;
  expect(f.store.claimDueRetrospective(minutes(11))).toBeNull();
  expect(f.store.getRetrospective(due.id)).toMatchObject({ state: "failed", note: "interrupted" });
});

test("only one whole JSON object is an answer: a cut-off one is none, and fields it got wrong are dropped one by one", () => {
  const whole = parseRetrospective(`好的：${JSON.stringify({
    summary: "先定画风",
    pitfalls: ["默认真人风格", 3, ""],
    rework_causes: ["配音语言没先问"],
    keep: ["交付前回听配音"],
    earlier: [{ conclusion: "全盘 grep 会超时", verdict: "held" }, { conclusion: "x", verdict: "maybe" }],
    memory: [{ op: "remember", subject: "改编片的配音语言", body: "改编日本动漫时默认用原作语言配音并带情绪。", replaces: ["配音偏好"], why: "被退回两次" },
      { op: "forget", subject: "旧偏好" }, { op: "rename", subject: "x" }, { op: "remember", subject: "", body: "空的" }],
    skills: [{ op: "edit", name: "关键帧出片", edits: [{ old: "先算账", new: "先定画风和配音语言，再算账" }, { after: "出关键帧", add: "带参考图。" }, { add: "交付前回听配音。" }, { after: "x" }] },
      { op: "create", name: "配音", description: "", body: "x" }],
  })} 以上`)!;
  expect(whole.summary).toBe("先定画风");
  expect(whole.pitfalls).toEqual(["默认真人风格"]);
  expect(whole.earlier).toEqual([{ conclusion: "全盘 grep 会超时", verdict: "held" }]);
  expect(whole.memory).toEqual([
    { op: "remember", subject: "改编片的配音语言", body: "改编日本动漫时默认用原作语言配音并带情绪。", replaces: ["配音偏好"], why: "被退回两次" },
    { op: "forget", subject: "旧偏好", why: "" },
  ]);
  expect(whole.skills).toEqual([{ op: "edit", name: "关键帧出片", description: null, why: "", edits: [
    { kind: "replace", old: "先算账", text: "先定画风和配音语言，再算账" },
    { kind: "insert", after: "出关键帧", text: "带参考图。" },
    { kind: "append", text: "交付前回听配音。" },
  ] }]);
  const cut = '{"summary":"先定画风","memory":[{"op":"remember","subject":"a","body":"b"}';
  expect(parseRetrospective(cut)).toBeNull();
  expect(parseRetrospective("想不出来")).toBeNull();
  expect(parseRetrospective('{"verdict":"ok"}')).toBeNull();
  expect(parseRetrospective('{"summary":"一切顺利","memory":[],"skills":[]}')).toMatchObject({ summary: "一切顺利", memory: [], skills: [] });
});

test("memories: a new conclusion, a sharper one under an existing subject, a merge, a forget — each kept with what it replaced; a refusal stops only itself", () => {
  const f = fixture();
  f.store.rememberMemory({ bot_id: f.maker.id, subject: "配音", body: "用中文配音。" });
  f.store.rememberMemory({ bot_id: f.maker.id, subject: "配音偏好", body: "配音要有感情。" });
  f.store.rememberMemory({ bot_id: f.maker.id, subject: "旧习惯", body: "先出真人风格样片。" });
  const off = f.store.rememberMemory({ bot_id: f.maker.id, subject: "用户关掉的", body: "不要再写回来。" });
  f.store.patchMemory(off.id, { enabled: false });
  const due = f.store.claimDueRetrospective()!;
  const result = f.store.recordRetrospective(due, outcome({
    pitfalls: ["改编片默认做成真人"],
    memory: [
      { op: "remember", subject: "配音", body: "改编日本动漫默认用日语配音，按角色性别和情绪选声。", replaces: ["配音偏好", "不存在的"], why: "两次被退回" },
      { op: "remember", subject: "改编片画风", body: "改编动漫默认做成动画，不做真人。", replaces: [], why: "第一次被退回" },
      { op: "remember", subject: "用户关掉的", body: "改写它", replaces: [], why: "" },
      { op: "remember", subject: "太长", body: "长".repeat(161), replaces: [], why: "" },
      { op: "forget", subject: "旧习惯", why: "这次证明是错的" },
    ],
  }), { model: "grk" });
  expect(result).toMatchObject({ state: "done", model: "grk", summary: "改编片先定画风和配音语言", pitfalls: ["改编片默认做成真人"], note: null });
  expect(result.changes.map((change) => [change.op, change.label, change.status, change.reason ?? null])).toEqual([
    ["forget", "旧习惯", "applied", null],
    ["remember", "配音", "applied", null],
    ["forget", "配音偏好", "applied", null],
    ["remember", "改编片画风", "applied", null],
    // Over the cap of three remembers: neither the one you turned off nor the one too long is written.
    ["remember", "用户关掉的", "not_applied", "off"],
    ["remember", "太长", "not_applied", "over_cap"],
  ]);
  expect(result.changes[1]!.before).toEqual({ subject: "配音", body: "用中文配音。" });
  expect(result.changes[2]!.why).toBe('merged into "配音"');
  const memories = f.store.listMemories(f.maker.id).map((memory) => [memory.subject, memory.body, memory.enabled]);
  expect(memories).toEqual([
    ["改编片画风", "改编动漫默认做成动画，不做真人。", true],
    ["用户关掉的", "不要再写回来。", false],
    ["配音", "改编日本动漫默认用日语配音，按角色性别和情绪选声。", true],
  ]);
  // The card says which retrospective wrote it, on which plan; a turn rewriting it takes that away.
  const written = f.store.readSnapshot().memories.find((memory) => memory.subject === "配音")!;
  expect(written.retrospective).toEqual({ id: due.id, task_id: f.plan.id, plan_title: "选举篇短片" });
  f.store.rememberMemory({ bot_id: f.maker.id, subject: "配音", body: "按角色选声。" });
  expect(f.store.readSnapshot().memories.find((memory) => memory.subject === "配音")!.retrospective).toBeUndefined();
});

test("a memory too long, a skill too long to read and one you turned off are refused with a code the window words", () => {
  const f = fixture();
  const off = f.store.rememberMemory({ bot_id: f.maker.id, subject: "关掉的", body: "x" });
  f.store.patchMemory(off.id, { enabled: false });
  f.store.createSkill({ bot_id: f.maker.id, name: "长技能", description: "很长", body: "步骤。".repeat(6000) });
  const due = f.store.claimDueRetrospective()!;
  // Past the reading budget: the call gets its name, not its body.
  expect(due.skills).toEqual([{ name: "长技能", description: "很长", body: null }]);
  const result = f.store.recordRetrospective(due, outcome({
    memory: [{ op: "remember", subject: "太长", body: "长".repeat(161), replaces: [], why: "" }, { op: "forget", subject: "关掉的", why: "" }],
    skills: [{ op: "edit", name: "长技能", description: null, edits: [{ kind: "insert", after: "步骤。", text: "再核对。" }], why: "" }],
  }));
  expect(result.changes.map((change) => change.reason)).toEqual(["off", "too_long:body", "edit_unread:1"]);
});

test("a full memory takes a new conclusion only when a merge frees the room", () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.store.rememberMemory({ bot_id: f.maker.id, subject: `记忆${i}`, body: `第${i}条` });
  const due = f.store.claimDueRetrospective()!;
  expect(due.memoryRoom).toBe(0);
  const result = f.store.recordRetrospective(due, outcome({ memory: [
    { op: "remember", subject: "新结论", body: "满了写不进", replaces: [], why: "" },
    { op: "remember", subject: "合并的结论", body: "合并掉两条腾出位置", replaces: ["记忆1", "记忆2"], why: "" },
  ] }));
  expect(result.changes.map((change) => [change.op, change.label, change.status, change.reason ?? null])).toEqual([
    ["remember", "新结论", "not_applied", "full"],
    ["remember", "合并的结论", "applied", null],
    ["forget", "记忆1", "applied", null],
    ["forget", "记忆2", "applied", null],
  ]);
  expect(f.store.listMemories(f.maker.id)).toHaveLength(19);
});

test("skills: an edit adds after a passage found exactly once, corrects one sentence, appends — and refuses otherwise without touching the skill", () => {
  const f = fixture();
  const skill = f.store.createSkill({ bot_id: f.maker.id, name: "关键帧出片", description: "做短片时用", body: "1. 先算账\n2. 出关键帧\n3. 出关键帧的视频" });
  const due = f.store.claimDueRetrospective()!;
  const result = f.store.recordRetrospective(due, outcome({ skills: [
    { op: "edit", name: "关键帧出片", description: null, why: "两次被退回", edits: [
      { kind: "replace", old: "1. 先算账", text: "1. 先定画风和配音语言，再算账" },
      { kind: "insert", after: "3. 出关键帧的视频", text: "，每镜带参考图" },
      { kind: "append", text: "交付前回听每一句配音。" },
    ] },
    { op: "edit", name: "关键帧出片", description: null, edits: [{ kind: "insert", after: "出关键帧", text: "（先出首帧）" }], why: "" },
  ] }));
  expect(result.changes.map((change) => [change.op, change.status, change.reason ?? null])).toEqual([
    ["edit", "applied", null],
    ["edit", "not_applied", "edit_repeated:1:2"],
  ]);
  const body = "1. 先定画风和配音语言，再算账\n2. 出关键帧\n3. 出关键帧的视频，每镜带参考图\n\n交付前回听每一句配音。";
  expect(f.store.getSkill(skill.id).body).toBe(body);
  expect(result.changes[0]).toMatchObject({ target_id: skill.id, before: { name: "关键帧出片", body: "1. 先算账\n2. 出关键帧\n3. 出关键帧的视频" }, after: { body } });
  expect(f.store.readSnapshot().skills.find((row) => row.id === skill.id)!.retrospective).toMatchObject({ id: due.id });
});

test("a rewritten passage that drops a command, a file or a name in backticks is refused whole; one that carries them over lands", () => {
  const f = fixture();
  const step = "4. **配音。** 按 bible/voices.json 的语言和声音，一句台词一个文件。在 edl.json 的 `voice` 里给每句写 `shot` 和 `offset`。";
  const skill = f.store.createSkill({ bot_id: f.maker.id, name: "关键帧出片", description: "做短片时用", body: `3. 出视频\n${step}\n5. 剪辑` });
  const due = f.store.claimDueRetrospective()!;
  const result = f.store.recordRetrospective(due, outcome({ skills: [
    { op: "edit", name: "关键帧出片", description: null, edits: [{ kind: "replace", old: "在 edl.json 的 `voice` 里给每句写 `shot` 和 `offset`。", text: "在 edl.json 里给每句写镜头和偏移。" }], why: "" },
    { op: "edit", name: "关键帧出片", description: null, edits: [{ kind: "insert", after: "一句台词一个文件。", text: "按角色性别和情绪选声。" }, { kind: "append", text: "音轨要有环境音和动作音效。" }], why: "" },
  ] }));
  expect(result.changes.map((change) => [change.status, change.reason ?? null])).toEqual([
    ["not_applied", "drops:`voice` `shot` `offset`"],
    ["applied", null],
  ]);
  expect(f.store.getSkill(skill.id).body).toBe(`3. 出视频\n${step.replace("一句台词一个文件。", "一句台词一个文件。按角色性别和情绪选声。")}\n5. 剪辑\n\n音轨要有环境音和动作音效。`);
  // A whole step rewritten, rather than one sentence corrected, is refused before it can lose anything.
  const g = fixture();
  g.store.createSkill({ bot_id: g.maker.id, name: "关键帧出片", description: "做短片时用", body: `3. 出视频\n${step}\n5. 剪辑` });
  const rewritten = g.store.recordRetrospective(g.store.claimDueRetrospective()!, outcome({ skills: [
    { op: "edit", name: "关键帧出片", description: null, edits: [{ kind: "replace", old: step, text: "4. **配音与音效。** 按角色性别和情绪配音。" }], why: "" },
  ] }));
  expect(rewritten.changes.map((change) => change.reason)).toEqual(["edit_not_one_sentence:1"]);
});

test("skills: another Bot's shared skill, one turned off, a missing text and a cap are refused; a new skill is made once", () => {
  const f = fixture();
  const theirs = f.store.createSkill({ bot_id: f.other.id, name: "剧本格式", description: "写剧本时用", body: "场景、人物、对白" });
  f.store.shareSkill(theirs.id);
  const off = f.store.createSkill({ bot_id: f.maker.id, name: "旧流程", description: "x", body: "旧的", enabled: false });
  f.store.createSkill({ bot_id: f.maker.id, name: "配音", description: "配音时用", body: "用 TTS" });
  const due = f.store.claimDueRetrospective()!;
  const result = f.store.recordRetrospective(due, outcome({ skills: [
    { op: "edit", name: "剧本格式", description: null, edits: [{ kind: "append", text: "加旁白" }], why: "" },
    { op: "edit", name: "旧流程", description: null, edits: [{ kind: "append", text: "加一步" }], why: "" },
    { op: "edit", name: "配音", description: null, edits: [{ kind: "replace", old: "用 ElevenLabs", text: "x" }], why: "" },
  ] }));
  expect(result.changes.map((change) => change.reason)).toEqual(["project_skill", "off", "over_cap"]);
  expect(f.store.getSkill(off.id).body).toBe("旧的");

  const g = fixture();
  g.store.createSkill({ bot_id: g.maker.id, name: "配音", description: "配音时用", body: "用 TTS" });
  const second = g.store.claimDueRetrospective()!;
  const made = g.store.recordRetrospective(second, outcome({ skills: [
    { op: "edit", name: "配音", description: null, edits: [{ kind: "replace", old: "用 ElevenLabs", text: "x" }], why: "" },
    { op: "create", name: "改编片开工前核对", description: "改编已有作品时用", body: "1. 画风\n2. 配音语言\n3. 角色性别", why: "" },
  ] }));
  expect(made.changes.map((change) => [change.op, change.status, change.reason ?? null])).toEqual([
    ["edit", "not_applied", "edit_missing:1"],
    ["create", "applied", null],
  ]);
  expect(g.store.listSkills(g.maker.id).map((row) => row.name)).toEqual(["改编片开工前核对", "配音"]);
});

test("a failed call writes nothing and says so; a delivery with nothing changed is done with a note", () => {
  const f = fixture();
  const due = f.store.claimDueRetrospective()!;
  expect(f.store.recordRetrospective(due, null, { note: "truncated", raw: '{"summary":' })).toMatchObject({ state: "failed", note: "truncated", changes: [] });
  const g = fixture();
  const second = g.store.claimDueRetrospective()!;
  expect(g.store.recordRetrospective(second, outcome())).toMatchObject({ state: "done", note: "nothing_changed" });
  expect(g.store.taskDetail(g.plan.id, () => true).retrospectives).toEqual([expect.objectContaining({ id: second.id, state: "done" })]);
});

test("each change can be taken back while it is still as it was written; one changed since is not undone behind that change", () => {
  const f = fixture();
  f.store.rememberMemory({ bot_id: f.maker.id, subject: "配音", body: "用中文配音。" });
  f.store.rememberMemory({ bot_id: f.maker.id, subject: "旧习惯", body: "先出真人风格样片。" });
  const skill = f.store.createSkill({ bot_id: f.maker.id, name: "关键帧出片", description: "做短片时用", body: "1. 先算账" });
  const due = f.store.claimDueRetrospective()!;
  const result = f.store.recordRetrospective(due, outcome({
    memory: [
      { op: "forget", subject: "旧习惯", why: "" },
      { op: "remember", subject: "配音", body: "用日语配音。", replaces: [], why: "" },
      { op: "remember", subject: "画风", body: "做动画。", replaces: [], why: "" },
    ],
    skills: [
      { op: "edit", name: "关键帧出片", description: null, edits: [{ kind: "append", text: "2. 回听配音" }], why: "" },
      { op: "create", name: "开工核对", description: "开工前用", body: "画风、语言", why: "" },
    ],
  }));
  const at = (op: string, label: string) => result.changes.findIndex((change) => change.op === op && change.label === label);
  const subjects = () => f.store.listMemories(f.maker.id).map((memory) => `${memory.subject}:${memory.body}`);
  expect(subjects()).toEqual(["画风:做动画。", "配音:用日语配音。"]);

  f.store.undoRetrospectiveChange(due.id, at("forget", "旧习惯"));
  f.store.undoRetrospectiveChange(due.id, at("remember", "配音"));
  f.store.undoRetrospectiveChange(due.id, at("remember", "画风"));
  expect(subjects()).toEqual(["旧习惯:先出真人风格样片。", "配音:用中文配音。"]);
  f.store.undoRetrospectiveChange(due.id, at("edit", "关键帧出片"));
  expect(f.store.getSkill(skill.id).body).toBe("1. 先算账");
  // The new skill was edited since: it is yours now, and stays.
  const made = f.store.listSkills(f.maker.id).find((row) => row.name === "开工核对")!;
  f.store.patchSkill(made.id, { body: "画风、语言、角色性别" });
  expect(() => f.store.undoRetrospectiveChange(due.id, at("create", "开工核对"))).toThrow("changed since");
  expect(() => f.store.undoRetrospectiveChange(due.id, at("remember", "配音"))).toThrow("already undone");
  expect(() => f.store.undoRetrospectiveChange(due.id, 99)).toThrow("no such change");
  expect(f.store.getRetrospective(due.id).changes.map((change) => change.status)).toEqual(["undone", "undone", "undone", "undone", "applied"]);
  const undone = f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'retrospective.undone'").get()!.n;
  expect(undone).toBe(4);
});

test("a plan reopened and delivered again is looked back on again, from what went wrong since, with the earlier retrospective as input", () => {
  const f = fixture();
  const first = f.store.claimDueRetrospective()!;
  f.store.recordRetrospective(first, outcome({ memory: [{ op: "remember", subject: "画风", body: "改编动漫做动画。", replaces: [], why: "" }] }));
  // Delivered again with nothing new gone wrong: nothing to learn the second time.
  const again = minutes(-40);
  f.store.db.run("UPDATE tasks SET delivered_at = ? WHERE id = ?", [again, f.plan.id]);
  expect(f.store.claimDueRetrospective()).toBeNull();
  expect(f.store.db.query("SELECT state, note FROM retrospectives ORDER BY created_at, rowid").all()).toEqual([
    { state: "done", note: null }, { state: "skipped", note: "nothing_to_learn" }]);
  // A complaint after the first delivery, then a third: the earlier conclusion comes with it.
  f.store.recordWorkEvent({ kind: "complaint.rework", actor: "user", taskId: f.plan.id, ticketId: f.ticket.id, payload: { producer: f.maker.id, parts: [] } });
  f.store.db.run("UPDATE quality_events SET created_at = ? WHERE kind = 'complaint'", [minutes(-38)]);
  f.store.db.run("UPDATE tasks SET delivered_at = ? WHERE id = ?", [minutes(-35), f.plan.id]);
  const third = f.store.claimDueRetrospective()!;
  expect(third.signals).toEqual(["complaint×1"]);
  expect(third.earlier).toEqual([{ at: expect.any(String), plan: "选举篇短片", summary: "改编片先定画风和配音语言",
    changes: [{ what: "memory remember", label: "画风", status: "kept" }] }]);
});

test("a ledger from before retrospectives is widened to bill them, its rows kept", () => {
  const filename = join(mkdtempSync(join(tmpdir(), "retro-spend-")), "state.sqlite");
  const first = new Store({ filename });
  first.db.run(`INSERT INTO spend (id, session_id, bot_id, kind, purpose, model, cost_usd_ticks, created_at) VALUES ('old', 's', NULL, 'organize', 'reader', 'm', 1, ?)`, [isoNow()]);
  // The ledger as the last release left it: no 'retrospect' in its CHECK.
  const table = first.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spend'").get()!.sql;
  const older = table.replace("'reader', 'retrospect'", "'reader'").replace(/^CREATE TABLE\s+(?:"spend"|spend\b)/i, "CREATE TABLE spend_old");
  expect(older).not.toContain("'retrospect'");
  first.db.run("PRAGMA legacy_alter_table = ON");
  first.db.transaction(() => {
    first.db.run(older);
    first.db.run("INSERT INTO spend_old SELECT * FROM spend");
    first.db.run("DROP TABLE spend");
    first.db.run("ALTER TABLE spend_old RENAME TO spend");
  })();
  expect(() => first.db.run(`INSERT INTO spend (id, session_id, kind, purpose, model, created_at) VALUES ('new', 's', 'organize', 'retrospect', 'm', ?)`, [isoNow()])).toThrow();
  first.close();
  const reopened = new Store({ filename });
  stores.push(reopened);
  reopened.db.run(`INSERT INTO spend (id, session_id, kind, purpose, model, created_at) VALUES ('new', 's', 'organize', 'retrospect', 'm', ?)`, [isoNow()]);
  expect(reopened.db.query("SELECT id, purpose FROM spend ORDER BY id").all()).toEqual([{ id: "new", purpose: "retrospect" }, { id: "old", purpose: "reader" }]);
  expect(reopened.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spend'").get()!.sql).toContain("'retrospect'");
});
