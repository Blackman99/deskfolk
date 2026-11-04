/**
 * Steps of your own (ADR 0105): an engine carries rules you wrote, at the moments the app already
 * has, and what a "no" does comes from a fixed list. These pin each moment end to end on the app's
 * own loop: a rule refuses a call before it runs, a command after a write is heard beside its
 * result, a turn's end goes back until the send-backs are spent and then you are told, a step that
 * cannot judge lets things through, a hand-in is held back as a failed check would hold it, and an
 * approval is run past the steps after it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { CallRun, CustomStep } from "@real-bot/protocol";
import { call, createScenario, requestText, say, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function directOn(base: "plain" | "general", steps: CustomStep[]) {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "助手", duties: "帮忙" });
  const session = h.direct(bot!);
  const engine = h.store.createPlaybook({ from: base, name: "我的规矩" });
  h.store.savePlaybook(engine.id, { diff: { ...engine.diff, custom_steps: steps } });
  h.store.setSessionPlaybook(session, engine.id);
  return { h, bot: bot!, session };
}

const stepRuns = (h: Scenario): CallRun[] => h.store.db.query<{ id: string }, []>("SELECT id FROM call_runs WHERE role = 'custom_step' ORDER BY created_at, id").all()
  .map((row) => h.store.getCallRun(row.id)!);

/** Lines to you in a conversation that no Bot reads: what a step tells you. */
const toldYou = (h: Scenario, session: string): string[] => h.messages(session).filter((message) => message.kind === "system"
  && h.store.db.query<{ hidden_from_bots: number }, [string]>("SELECT hidden_from_bots FROM messages WHERE id = ?").get(message.id)?.hidden_from_bots === 1)
  .map((message) => message.body);

const noEnv: CustomStep = { id: "u_noenvfile01", name: "不许动 .env", on: true, at: "before_effect", match: { paths: ["**/.env", ".env"] }, run: { kind: "rule" }, then: "refuse" };

test("a rule of yours refuses a call before it runs, and the Bot hears why", async () => {
  const { h, bot, session } = await directOn("plain", [noEnv]);
  const heard: Array<{ ok: boolean; error?: { code: string; message: string } }> = [];
  h.script(bot, session).reply(call(writeFile(".env", "KEY=1"), writeFile("notes.md", "好")), ({ results }) => {
    heard.push(...results.map((result) => JSON.parse(result.content)));
    return say("没写 .env，规矩不让动");
  });
  h.postUser(session, "把 KEY 写进 .env，再记个笔记");
  await h.waitIdle();

  expect(heard[0]).toMatchObject({ ok: false, error: { code: "step_refused" } });
  expect(heard[0]!.error!.message).toContain("「不许动 .env」这一步拒掉了这次调用");
  expect(heard[1]).toMatchObject({ ok: true });
  expect(existsSync(join(h.root, ".env"))).toBe(false);
  expect(existsSync(join(h.root, "notes.md"))).toBe(true);
  // One record, for the call it looked at; the other call is no business of this step.
  expect(stepRuns(h).map((run) => [run.custom_step?.name, run.verdict])).toEqual([
    ["不许动 .env", { kind: "custom_step", run: "rule", outcome: "fail", then: "refuse", applied: true, reason: "碰到了「不许动 .env」管的 .env" }],
  ]);
  // A refusal by your rule is no tool that failed.
  expect(h.turns(bot).at(-1)).toMatchObject({ status: "completed" });
});

test("a command after a write reads what happened and is heard beside the call's result", async () => {
  const lint: CustomStep = { id: "u_lintafterwrite", name: "写完 TS 跑 lint", on: true, at: "after_effect", match: { tools: ["write_file"], paths: ["src/**/*.ts"] },
    run: { kind: "command", command: "printf 'paths=%s ' \"$DESKFOLK_PATHS\"; grep -o '\"tool\":\"[a-z_]*\"'; exit 1" }, then: "note" };
  const { h, bot, session } = await directOn("plain", [lint]);
  const heard: Array<{ ok: boolean; data?: { engine_steps?: string[] } }> = [];
  h.script(bot, session).reply(call(writeFile("src/a.ts", "export const a = 1\n"), writeFile("README.md", "# a\n")), ({ results }) => {
    heard.push(...results.map((result) => JSON.parse(result.content)));
    return say("写好了");
  });
  h.postUser(session, "写个 a.ts");
  await h.waitIdle();

  expect(heard[0]!.ok).toBe(true);
  expect(heard[0]!.data!.engine_steps).toHaveLength(1);
  expect(heard[0]!.data!.engine_steps![0]).toContain("「写完 TS 跑 lint」这一步看了这次调用，没过");
  expect(heard[0]!.data!.engine_steps![0]).toContain("paths=src/a.ts");
  expect(heard[0]!.data!.engine_steps![0]).toContain('"tool":"write_file"');
  // A file the step does not look at goes by untouched.
  expect(heard[1]!.data?.engine_steps).toBeUndefined();
  expect(stepRuns(h)).toHaveLength(1);
  expect(stepRuns(h)[0]!.verdict).toMatchObject({ outcome: "fail", then: "note", applied: true, exit_code: 1 });
});

test("a turn's end goes back while send-backs are left, then ends and you are told", async () => {
  const tests: CustomStep = { id: "u_teststhend01", name: "收尾前跑测试", on: true, at: "turn_end", run: { kind: "command", command: "echo 测试没过; exit 1" }, then: "send_back" };
  const { h, bot, session } = await directOn("plain", [tests]);
  // Each ending in words of its own: the same reply twice in a row is dropped as a repeat.
  h.script(bot, session).handle(({ hop }) => say(`第 ${hop} 次：做完了`));
  h.postUser(session, "把它做完");
  await h.waitIdle();

  const [turn, ...more] = h.turns(bot);
  expect(more).toEqual([]);
  expect(turn).toMatchObject({ status: "completed" });
  // Sent back twice, the contract's two per segment; the third ending stands.
  expect(h.hops(bot).filter((hop) => hop.turnId === turn!.id)).toHaveLength(3);
  expect(requestText(h.hops(bot)[1]!.request)).toContain("「收尾前跑测试」：测试没过");
  const rejected = h.store.listWorkEvents({}).filter((event) => event.kind === "end.rejected");
  expect(rejected.map((event) => (event.payload as { code: string }).code)).toEqual(["custom_step", "custom_step"]);
  // The words went out each time; you are told the last one did not pass, in a line no Bot reads.
  const said = h.messages(session);
  expect(said.filter((message) => message.kind === "bot").map((message) => message.body)).toEqual(["第 1 次：做完了", "第 2 次：做完了", "第 3 次：做完了"]);
  expect(toldYou(h, session)).toEqual(["「收尾前跑测试」还是没过：测试没过。这一段能退回的次数用完了，照常收尾。"]);
  expect(stepRuns(h).map((run) => (run.verdict as { applied: boolean }).applied)).toEqual([true, true, false]);
});

test("a step that cannot judge lets the call through, and says so on the flow", async () => {
  const slow: CustomStep = { id: "u_slowrule001", name: "慢的检查", on: true, at: "before_effect", run: { kind: "command", command: "sleep 3", timeout_s: 1 }, then: "refuse" };
  const { h, bot, session } = await directOn("plain", [slow]);
  h.script(bot, session).reply(call(writeFile("a.md", "a")), () => say("好了"));
  h.postUser(session, "写个文件");
  await h.waitIdle({ timeoutMs: 8_000 });

  expect(existsSync(join(h.root, "a.md"))).toBe(true);
  expect(stepRuns(h)[0]).toMatchObject({ outcome: "failed", fail_kind: "step_error",
    verdict: { kind: "custom_step", outcome: "error", applied: false, reason: "1 秒还没跑完" } });
}, 10_000);

test("a hand-in step holds a hand-over back as a failed check would, with no check bound to it", async () => {
  const budget: CustomStep = { id: "u_budgetcheck", name: "要有预算表", on: true, at: "handed_in", match: { paths: ["**/plan.md"] },
    run: { kind: "command", command: "echo 少了预算表; exit 1" }, then: "gate" };
  const { h, bot, session } = await directOn("general", [budget]);
  const ticket = () => h.store.db.query<{ id: string; dir: string }, []>("SELECT id, dir FROM tickets ORDER BY created_at LIMIT 1").get()!;
  let handedIn: { ok: boolean; error?: { code: string; message: string } } | null = null;
  h.script(bot).handle(({ hop, results }) => {
    if (hop === 1) return call(writeFile("notes.md", "三天"));
    if (hop === 2) return call(writeFile(`${ticket().dir}/plan.md`, "第一天：开业\n"));
    if (hop === 3) return call(tool("submit", { artifacts: [`${ticket().dir}/plan.md`] }));
    if (hop === 4) handedIn = JSON.parse(results[0]!.content);
    return call(tool("end_turn", { reason: "gave_up", note: "交不上" }));
  });
  h.postUser(session, "写一份开业方案，plan.md");
  await h.waitIdle({ timeoutMs: 15_000 });

  expect(handedIn).toMatchObject({ ok: false });
  expect(JSON.stringify(handedIn)).toContain("要有预算表");
  const [submission] = h.store.listSubmissions({ ticketId: ticket().id });
  expect(submission).toMatchObject({ state: "checks_failed" });
  expect(submission!.checks).toEqual([{ check_id: "u_budgetcheck", item: "要有预算表", gate: true, yours: false, outcome: "fail", detail: "少了预算表", step: true }]);
  expect(stepRuns(h)[0]).toMatchObject({ submission_id: submission!.id, custom_step: { id: "u_budgetcheck", at: "handed_in" } });
});

test("in an engine with no jobs a hand-in step never runs; one after an approval runs on the next tick and tells you", async () => {
  const deployed: CustomStep = { id: "u_afteraccept", name: "放行后部署", on: true, at: "accepted", run: { kind: "command", command: "echo 部署好了" }, then: "tell" };
  const { h, bot, session } = await directOn("general", [deployed]);
  // The first look starts from now.
  h.engine.settleSteps();
  const ticket = () => h.store.db.query<{ id: string; dir: string }, []>("SELECT id, dir FROM tickets ORDER BY created_at LIMIT 1").get()!;
  h.script(bot).handle(({ hop }) => {
    if (hop === 1) return call(writeFile("notes.md", "三天"));
    if (hop === 2) return call(writeFile(`${ticket().dir}/plan.md`, "第一天：开业\n"));
    if (hop === 3) return call(tool("submit", { artifacts: [`${ticket().dir}/plan.md`] }));
    return call(tool("end_turn", { reason: "done" }));
  });
  h.postUser(session, "写一份开业方案，plan.md");
  await h.waitIdle({ timeoutMs: 15_000 });
  // Made and handed in by one segment: the tick approves it, and the steps after it run.
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(h.store.listSubmissions({ ticketId: ticket().id })).toMatchObject([{ state: "approved" }]);
  h.tick(new Date(Date.now() + 120_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(toldYou(h, session)).toContain("「放行后部署」跑过了，没问题。");
  // Once: the look moved past it.
  h.tick(new Date(Date.now() + 180_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(stepRuns(h).filter((run) => run.custom_step?.at === "accepted")).toHaveLength(1);

  // Moved to an engine with no jobs, a hand-over's steps are set but not running.
  const plain = h.store.createPlaybook({ from: "plain", name: "自由加规矩" });
  h.store.savePlaybook(plain.id, { diff: { ...plain.diff, custom_steps: [deployed] } });
  expect(h.store.getPlaybook(plain.id).custom_steps).toMatchObject([{ id: "u_afteraccept", running: false }]);
});

test("a step that reads your words with a model asks it in its own frame, bills it, and acts on its answer", async () => {
  const rules: CustomStep = { id: "u_myrules0001", name: "照我的规矩看一遍", on: true, at: "turn_end", run: { kind: "model", prompt: "回复里要说清改了哪些文件。" }, then: "send_back" };
  const { h, bot, session } = await directOn("plain", [rules]);
  const asked: Array<Record<string, unknown>> = [];
  h.judge("custom_step").handle(({ payload }) => {
    asked.push(payload as Record<string, unknown>);
    return asked.length === 1 ? { pass: false, reason: "回复没说改了哪些文件" } : { pass: true, reason: "" };
  });
  h.script(bot, session).handle(({ hop }) => say(hop === 1 ? "改好了" : "改好了：src/a.ts 和 src/b.ts"));
  h.postUser(session, "把两个文件改一下");
  await h.waitIdle();

  // The model read your rule and the reply it judged; the first ending went back with its reason.
  expect(asked.map((one) => [one.rule, one.moment, one.reply])).toEqual([
    ["回复里要说清改了哪些文件。", "turn_end", "改好了"],
    ["回复里要说清改了哪些文件。", "turn_end", "改好了：src/a.ts 和 src/b.ts"],
  ]);
  expect(requestText(h.hops(bot)[1]!.request)).toContain("「照我的规矩看一遍」：回复没说改了哪些文件");
  expect(h.turns(bot).at(-1)).toMatchObject({ status: "completed" });
  // Each judgement is on the ledger as a step's, and recorded with the frame prompt it ran in.
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM spend WHERE purpose = 'step'").get()!.n).toBe(2);
  expect(stepRuns(h).map((run) => [run.prompt_id, run.outcome, (run.verdict as { outcome: string }).outcome, run.spend_id !== null])).toEqual([
    ["call.custom_step", "ok", "fail", true],
    ["call.custom_step", "ok", "pass", true],
  ]);
});
