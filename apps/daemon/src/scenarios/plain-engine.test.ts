/**
 * An engine with no jobs (ADR 0103): you can choose not to use the way of working the app ships. The
 * built-in 自由 (plain) leaves out the whole job kernel, and what is left is what no engine gives up:
 * your lines in order, a stop that is a stop, your approvals and the spend ledger. These pin both
 * halves: a conversation on it never opens a job, whatever is said in it, and the floor still holds.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { mayWake } from "../engine/control";
import { savePromptText } from "../prompts/book";
import { call, checkBack, createScenario, endTurn, say, sendMessage, shell, tool, writeFile, type Scenario, type ScriptedCall } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function plainDirect() {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "助手", duties: "帮忙" });
  const session = h.direct(bot!);
  h.store.setSessionPlaybook(session, "plain");
  return { h, bot: bot!, session };
}

const rows = (h: Scenario, table: string) => (h.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const offered = (request: { tools?: unknown[] }) => (request.tools ?? []).map((entry) => (entry as { function: { name: string } }).function.name);
const JOB_TOOLS = ["work_on", "delegate", "submit", "review", "plan_items"];

test("a line opens no job: nothing files it, the file lands where it was asked, and the reply ends the segment", async () => {
  const { h, bot, session } = await plainDirect();
  const printed: string[] = [];
  h.script(bot, session).reply(call(writeFile("notes/hello.md", "你好"), shell("pwd")), ({ results }) => {
    printed.push((JSON.parse(results[1]!.content) as { data: { stdout: string } }).data.stdout.trim());
    return say("写好了：notes/hello.md");
  });

  const line = h.postUser(session, "写一个打招呼的文件，然后交给我");
  await h.waitIdle();

  // What the app would have read about it, and every step that stands on a job.
  expect(h.judgeCalls().map((row) => row.kind)).toEqual(["read_user_line"]);
  for (const table of ["tasks", "tickets", "submissions", "delegations"]) expect(rows(h, table)).toBe(0);
  expect(h.store.listWorkEvents({}).filter((event) => event.kind === "end.rejected" || event.kind === "plan.opened")).toEqual([]);

  const [turn, ...more] = h.turns(bot);
  expect(more).toEqual([]);
  expect(turn).toMatchObject({ status: "completed", mode: "desk", task_id: null, ticket_id: null, end_reason: "answered" });
  expect(h.store.db.query("SELECT state FROM work_items WHERE id = ?").get(turn!.work_item_id!)).toEqual({ state: "closed" });
  expect(h.store.getMessage(line.id)).toMatchObject({ task_id: null, ticket_id: null });

  expect(readFileSync(join(h.root, "notes/hello.md"), "utf8")).toBe("你好");
  expect(printed).toEqual([realpathSync(h.root)]);
  const reply = h.messages(session).find((message) => message.kind === "bot");
  expect(reply?.body).toContain("写好了");
  expect(reply?.attachments.map((attachment) => attachment.workspace_relpath)).toEqual(["notes/hello.md"]);

  // Nothing is left for the supervisor, however long it stays quiet.
  expect(h.store.supervisorTick({ now: new Date(Date.now() + 60 * 60_000).toISOString() }).wakes).toEqual([]);
  expect(h.unscripted()).toEqual([]);
});

test("a Bot is told nothing of jobs and offered none of their tools; the same Bot under 通用 is", async () => {
  const { h, bot, session } = await plainDirect();
  h.script(bot).handle(() => say("好"));
  h.postUser(session, "你好");
  await h.waitIdle();
  const here = h.hops(bot).at(-1)!.request;
  for (const name of JOB_TOOLS) expect(offered(here)).not.toContain(name);
  expect(offered(here)).toEqual(expect.arrayContaining(["read_file", "write_file", "shell", "send_message", "ask_user", "check_back", "end_turn", "remember"]));
  const said = here.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  expect(said).not.toMatch(/work_on|plan_items|delegate|任务目录|规划目录|map\.md|ticket\.md|桌面段/);
  // The one thing a Bot needs to place its work: the root it starts in.
  expect(said).toContain(`工作区根在这台机器上是`);

  h.store.setSessionPlaybook(session, "general");
  h.postUser(session, "再说一句");
  await h.waitIdle();
  const there = h.hops(bot).at(-1)!.request;
  for (const name of JOB_TOOLS) expect(offered(there)).toContain(name);
});

test("your edit of the System section is for the jobs it was written for, and stays out of here", async () => {
  const { h, bot, session } = await plainDirect();
  savePromptText(h.store, { id: "turn.system", locale: "zh", text: "我改过的：用 plan_items 拆任务。", actor: "user" });
  h.script(bot).handle(() => say("好"));
  h.postUser(session, "你好");
  await h.waitIdle();
  const system = h.hops(bot).at(-1)!.request.messages[0]!.content as string;
  expect(system).not.toContain("我改过的");
  expect(system).toContain("壳默认在工作区根");
});

test("a job's tool named from memory of an older turn does nothing here", async () => {
  const { h, bot, session } = await plainDirect();
  const refused: Array<string | null> = [];
  h.script(bot, session).reply(call(tool("work_on", { plan: { new: { title: "x" } } }), tool("submit", {})), ({ results }) => {
    refused.push(...results.map((result) => result.error));
    return say("直接做了");
  });
  h.postUser(session, "做一件事");
  await h.waitIdle();
  expect(refused).toEqual(["not_offered", "not_offered"]);
  expect(rows(h, "tasks")).toBe(0);
});

test("a stop you say still stops: nothing more runs, and your next line goes on", async () => {
  const { h, bot, session } = await plainDirect();
  let release!: () => void;
  const out = new Promise<void>((resolve) => { release = resolve; });
  const first = writeFile("first.md", "x");
  h.script(bot, session).reply(async () => {
    await out;
    return call(first);
  });
  h.postUser(session, "写一个文件");
  await h.waitFor(() => h.turns(bot).length > 0);
  h.postUser(session, "停下");
  await h.waitFor(() => h.store.holdsCovering({ botId: bot.id, sessionId: session }).length > 0, { what: "the stop read" });
  release();
  await h.waitIdle();
  expect(existsSync(join(h.root, "first.md"))).toBe(false);
  expect(h.turns(bot)[0]!.status).not.toBe("running");
  expect(h.judgeCalls("read_user_line").length).toBeGreaterThan(0);
  expect(rows(h, "tasks")).toBe(0);

  h.script(bot, session).reply(say("好，接着来"));
  h.postUser(session, "继续");
  await h.waitIdle();
  expect(h.store.holdsCovering({ botId: bot.id, sessionId: session })).toEqual([]);
  expect(h.messages(session).filter((message) => message.kind === "bot").map((message) => message.body)).toContain("好，接着来");
});

test("the Stop button stops a turn too, and a built-in stop is no job's", async () => {
  const { h, bot, session } = await plainDirect();
  let release!: () => void;
  const out = new Promise<void>((resolve) => { release = resolve; });
  h.script(bot, session).reply(async () => {
    await out;
    return call(writeFile("late.md", "x"));
  });
  h.postUser(session, "写一个文件");
  await h.waitFor(() => h.turns(bot).length > 0 && h.hops(bot).length === 0);
  h.engine.stop(h.turns(bot)[0]!.id, { button: true });
  release();
  await h.waitIdle();
  expect(existsSync(join(h.root, "late.md"))).toBe(false);
  expect(h.turns(bot)[0]!.status).toBe("stopped");
});

test("with the reader off too, a typed stop is just a line, as in a project session", async () => {
  const { h, bot, session } = await plainDirect();
  const engine = h.store.createPlaybook({ from: "plain", name: "只认按钮" });
  h.store.savePlaybook(engine.id, { diff: { v: 1, steps: { reader: { on: false } } } });
  h.store.setSessionPlaybook(session, engine.id);
  h.script(bot, session).reply(say("收到，这句我听见了"));
  h.postUser(session, "停下");
  await h.waitIdle();
  expect(h.judgeCalls("read_user_line")).toEqual([]);
  expect(h.store.holdsCovering({ botId: bot.id, sessionId: session })).toEqual([]);
  expect(h.messages(session).filter((message) => message.kind === "bot").map((message) => message.body)).toEqual(["收到，这句我听见了"]);
});

test("ask first still puts up a card before a write", async () => {
  const { h, bot, session } = await plainDirect();
  h.store.patchBot(bot.id, { permission_mode: "ask_first" });
  h.script(bot, session).reply(call(writeFile("asked.md", "x")), say("写了"));
  h.postUser(session, "写一个文件");
  await h.waitFor(() => h.store.listApprovals("pending").length === 1, { what: "the approval card" });
  expect(existsSync(join(h.root, "asked.md"))).toBe(false);
  h.engine.resolveApproval(h.store.listApprovals("pending")[0]!.id, "allow_once");
  await h.waitIdle();
  expect(existsSync(join(h.root, "asked.md"))).toBe(true);
  expect(rows(h, "tasks")).toBe(0);
});

test("your line left without a word goes back once, then you are told; an ending with something said is taken as it is", async () => {
  const { h, bot, session } = await plainDirect();
  const heard: Array<string | null> = [];
  h.script(bot, session).reply(call(endTurn()), ({ results }) => {
    heard.push(results[0]!.error);
    return call(endTurn());
  });
  h.postUser(session, "你在吗");
  await h.waitIdle();
  expect(heard).toEqual(["said_nothing"]);
  const told = h.messages(session).filter((message) => message.kind === "system");
  expect(told.map((message) => message.body).join("")).toContain("助手");
  expect(h.turns(bot)[0]!.status).toBe("completed");

  // No reason asked for, and no count of progress lines: four go out, then the reply ends it.
  const progress: ScriptedCall[] = ["一", "二", "三", "四"].map((word) => sendMessage(word));
  h.script(bot, session).reply(...progress.map((step) => call(step)), say("好了"));
  h.postUser(session, "讲四句");
  await h.waitIdle();
  const said = h.messages(session).filter((message) => message.kind === "bot").map((message) => message.body);
  expect(said).toEqual(expect.arrayContaining(["一", "二", "三", "四", "好了"]));
  expect(h.toolCalls(bot, "send_message").map((row) => row.result?.error)).toEqual([null, null, null, null]);
});

test("an answer that only says there is nothing to do goes out as written: no reading stands between", async () => {
  const { h, bot, session } = await plainDirect();
  h.script(bot, session).reply(say("没有新的事，本轮结束。"));
  h.postUser(session, "还有事吗");
  await h.waitIdle();
  expect(h.messages(session).filter((message) => message.kind === "bot").map((message) => message.body)).toEqual(["没有新的事，本轮结束。"]);
  expect(h.judgeCalls("read_bot_line")).toEqual([]);
});

test("a routine fires as a turn like any other, with no standing plan", async () => {
  const { h, bot, session } = await plainDirect();
  const routine = h.store.createRoutine({ bot_id: bot.id, title: "每日简报", instruction: "写今天的简报", schedule: { kind: "daily", time: "01:00" } });
  h.store.db.run("UPDATE routines SET created_at = ? WHERE id = ?", [new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), routine.id]);
  h.script(bot, session).reply(call(writeFile("brief.md", "今天")), say("简报写好了：brief.md"));
  const fired = h.engine.fireRoutine(routine.id);
  expect(fired).toMatchObject({ mode: "desk", task_id: null, routine_id: routine.id });
  await h.waitIdle();
  expect(rows(h, "tasks")).toBe(0);
  expect(rows(h, "tickets")).toBe(0);
  expect(existsSync(join(h.root, "brief.md"))).toBe(true);
  expect(h.turns(bot)[0]!.status).toBe("completed");
});

test("a Bot's own check-back rings at its desk", async () => {
  const { h, bot, session } = await plainDirect();
  h.script(bot, session).reply(call(checkBack(30, "看看跑完没")), say("半小时后再看"), say("看过了，跑完了"));
  h.postUser(session, "跑个长任务");
  await h.waitIdle();
  expect(h.toolCalls(bot, "check_back").map((row) => row.result?.ok)).toEqual([true]);
  h.advance(31 * 60_000);
  await h.waitIdle();
  const turns = h.turns(bot);
  expect(turns).toHaveLength(2);
  expect(turns[1]).toMatchObject({ mode: "desk", task_id: null, status: "completed" });
  expect(rows(h, "tasks")).toBe(0);
});

test("in a group a line naming nobody is still judged, and with the judgement off everyone takes it", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [a, b] = h.createBots("甲", "乙");
  const group = h.group("小组", [a!, b!]);
  h.store.setSessionPlaybook(group, "plain");
  h.judge("judgement").handle(({ bot }) => (bot?.name === "甲" ? "join" : "pass"));
  h.script(a!, group).reply(say("我来"));
  h.postUser(group, "谁来看看");
  await h.waitIdle();
  expect(h.judgeCalls("judgement")).toHaveLength(2);
  expect(h.turns(a!)).toHaveLength(1);
  expect(h.turns(b!)).toEqual([]);
  expect(h.turns(a!)[0]).toMatchObject({ mode: "desk", task_id: null });

  // Named, only the one named, as ever.
  h.script(b!, group).reply(say("我也来"));
  h.postUser(group, "@乙 你呢");
  await h.waitIdle();
  expect(h.turns(b!)).toHaveLength(1);
  expect(h.judgeCalls("judgement")).toHaveLength(2);

  const none = h.store.createPlaybook({ from: "plain", name: "不判断" });
  h.store.savePlaybook(none.id, { diff: { v: 1, steps: { judgement: { on: false } } } });
  h.store.setSessionPlaybook(group, none.id);
  h.script(a!, group).reply(say("甲说"));
  h.script(b!, group).reply(say("乙说"));
  h.postUser(group, "都说说");
  await h.waitIdle();
  expect(h.judgeCalls("judgement")).toHaveLength(2);
  expect(h.turns(a!)).toHaveLength(2);
  expect(h.turns(b!)).toHaveLength(2);
  expect(h.store.listJudgements(group).filter((row) => row.reason === "engine: join-all")).toHaveLength(2);
  expect(rows(h, "tasks")).toBe(0);
});

test("moving a conversation off jobs stops its open job where it is, and moving back goes on from there", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "助手", duties: "帮忙" });
  const session = h.direct(bot!);
  const plan = h.store.openTask({ sessionId: session, title: "旧事", brief: "做一件旧事", kind: "旧事", spec: { kind: "旧事", goal: "旧事", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" } });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "第一件", spec: "做", status: "todo", worker: bot!.id });
  const later = () => new Date(Date.now() + 2 * 60 * 60_000).toISOString();

  h.store.setSessionPlaybook(session, "plain");
  expect(h.store.supervisorTick({ now: later() }).wakes).toEqual([]);
  expect(h.store.listWorkEvents({}).filter((event) => event.kind.startsWith("supervisor."))).toEqual([]);

  // A line in the conversation is about no job now: it opens no turn on the old one.
  h.script(bot!, session).reply(say("好"));
  const line = h.postUser(session, "顺便问一句");
  await h.waitIdle();
  expect(h.store.getMessage(line.id)).toMatchObject({ task_id: null, filing_state: "none" });
  expect(h.turns(bot!)[0]).toMatchObject({ task_id: null, mode: "desk" });

  // A wake about it is turned away, and the work log says why.
  expect(mayWake(h.store, { cause: "check_back", botId: bot!.id, sessionId: session, taskId: plan.id, ticketId: ticket.id })).toBe(false);
  expect(h.suppressedWakes(bot!).map((event) => (event.payload as { reason?: string }).reason)).toEqual(["no_jobs"]);

  // Moving back, it is called again, with nothing lost.
  h.store.setSessionPlaybook(session, "general");
  expect(h.store.supervisorTick({ now: later() }).wakes.map((wake) => wake.ticketId)).toEqual([ticket.id]);
});

test("an appointment on a job that stopped this way stays due, and rings once its conversation moves back", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "助手", duties: "帮忙" });
  const session = h.direct(bot!);
  const plan = h.store.openTask({ sessionId: session, title: "旧事", brief: "做一件旧事", kind: "旧事", spec: { kind: "旧事", goal: "旧事", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" } });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "第一件", spec: "做", status: "todo", worker: bot!.id });
  h.store.setSessionPlaybook(session, "plain");
  h.store.db.run(`INSERT INTO check_backs (id, bot_id, session_id, task_id, ticket_id, note, due_at, created_at) VALUES ('cb1', ?, ?, ?, ?, '看看', ?, ?)`,
    [bot!.id, session, plan.id, ticket.id, new Date(Date.now() - 1000).toISOString(), new Date().toISOString()]);

  h.tick();
  await h.waitIdle();
  expect(h.turns(bot!)).toEqual([]);
  expect(h.suppressedWakes(bot!)).toEqual([]);
  expect(h.store.db.query("SELECT fired_at, voided_at, suspended_at FROM check_backs WHERE id = 'cb1'").get()).toEqual({ fired_at: null, voided_at: null, suspended_at: null });

  h.store.setSessionPlaybook(session, "general");
  h.script(bot!, session).reply(say("回来接着做"));
  h.tick();
  await h.waitIdle();
  expect(h.turns(bot!)[0]).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
});

test("a line elsewhere that cites a job whose conversation has no jobs now is not filed under it, and is answered", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "助手", duties: "帮忙" });
  const here = h.direct(bot!);
  const [other] = h.createBots({ name: "别的", duties: "别的" });
  const there = h.direct(other!);
  const plan = h.store.openTask({ sessionId: here, title: "旧事", brief: "做一件旧事", kind: "旧事", spec: { kind: "旧事", goal: "旧事", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" } });
  h.store.setSessionPlaybook(here, "plain");
  h.script(other!, there).reply(say("看了"));
  const line = h.postUser(there, `看看 ${plan.dir}/notes.md`);
  await h.waitIdle();
  expect(h.store.getMessage(line.id).task_id).toBeNull();
  expect(h.turns(other!)[0]).toMatchObject({ status: "completed", task_id: null });
  expect(h.suppressedWakes(other!)).toEqual([]);
});

test("what moving to an engine with no jobs would leave standing is counted", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [a, b] = h.createBots("甲", "乙");
  const one = h.direct(a!);
  const two = h.direct(b!);
  h.store.setSessionPlaybook(two, "video");
  h.store.openTask({ sessionId: one, title: "在做", brief: "在做", kind: "在做", spec: { kind: "在做", goal: "在做", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" } });
  // Only what follows the default moves with it, and only where you are: not the file drop, not a project session.
  expect(h.store.playbookImpact()).toEqual({ sessions: 1, open_jobs: 1 });
  expect(h.store.playbookImpact({ sessionId: two })).toEqual({ sessions: 1, open_jobs: 0 });
  expect(h.store.playbookImpact({ sessionId: one })).toEqual({ sessions: 1, open_jobs: 1 });
});
