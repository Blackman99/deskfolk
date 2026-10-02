/**
 * Engine levels 2–4 (ADR 0040 P4b, ADR 0044, ADR 0045) as an audit of them found them before the
 * user's own database could go above level 1. Each block is one defect the audit named (D1–D13):
 * a line of yours lost or filed where it does not belong, work left with nobody moving it, a Bot
 * woken for nothing, a notice in the wrong language. D0, a stray table that failed every filing, is
 * in store/migrate.test.ts. Where a defect showed at more than one level, its test runs at each.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { completionFailBody } from "../prompts";
import { confirmGroupLead } from "../store/group-leads";
import {
  call,
  createScenario,
  failed,
  requestText,
  say,
  tool,
  writeFile,
  type HopContext,
  type Scenario,
  type ScenarioOptions,
} from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options: ScenarioOptions): Promise<Scenario> {
  const h = await createScenario(options);
  open.push(h);
  return h;
}

const LEVELS = [
  { name: "level 2", options: { workItems: true } },
  { name: "level 4", options: { supervision: true } },
] as const;

/** The labels of your lines a hop read (`U12`); ULIDs never hold a `U`, so nothing else matches. */
function yourLabels(request: HopContext["request"]): string[] {
  return [...new Set([...requestText(request).matchAll(/\bU\d+\b/g)].map((match) => match[0]))];
}

/** Ends the segment saying it answered every line of yours it read. */
function answerAll({ request }: HopContext) {
  return call(tool("end_turn", { reason: "answered", inbox: yourLabels(request).map((id) => ({ id, disposition: "answered" })) }));
}

/** A Bot's line that opened the job's ticket, for your lines to quote. */
function seedLine(h: Scenario, sessionId: string, botId: string, taskId: string, ticketId: string | null, body: string) {
  const line = h.store.insertMessage({ sessionId, kind: "bot", author: botId, body });
  h.store.db.run("UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?", [taskId, ticketId, line.id]);
  return h.store.getMessage(line.id);
}

function workState(h: Scenario, taskId: string): string[] {
  return h.store.db.query<{ state: string }, [string]>("SELECT state FROM work_items WHERE task_id = ? ORDER BY created_at").all(taskId).map((row) => row.state);
}

describe("D1: a second line on no job, while the Bot's desk segment there is open", () => {
  for (const level of LEVELS) {
    for (const entry of ["mention", "lead", "everyone", "focused", "direct fork"] as const) {
      test(`${level.name}, ${entry}: is heard in that segment, not lost to a second one on the same work`, async () => {
        const h = await scenario(level.options);
        const [alpha, beta] = h.createBots("Alpha", "Beta");
        const room = entry === "direct fork" ? h.direct(alpha!) : h.group("Studio", [alpha!, beta!]);
        if (entry !== "direct fork") {
          // Two plans, so neither line is filed: each is for a desk segment.
          h.store.openTask({ sessionId: room, title: "Film" });
          h.store.openTask({ sessionId: room, title: "Poster" });
        }
        if (entry === "lead") confirmGroupLead(h.store, room, alpha!.id);
        const gate = Promise.withResolvers<void>();
        const waiting = new Set<string>();
        for (const bot of [alpha!, beta!]) {
          h.script(bot).handle(async (ctx) => {
            if (ctx.hop === 1 && !waiting.has(bot.id)) {
              waiting.add(bot.id);
              await gate.promise;
              return call(tool("list_dir", { path: "." }));
            }
            return answerAll(ctx);
          });
        }
        h.judge("judgement", { bot: alpha! }).handle(() => "join");
        h.judge("judgement", { bot: beta! }).handle(() => "pass");
        const prefix = entry === "mention" ? "@Alpha " : entry === "everyone" ? "@everyone " : "";
        h.postUser(room, `${prefix}看一下配色`);
        await h.waitFor(() => waiting.has(alpha!.id), { what: "Alpha's desk segment to be mid-hop" });

        const second = h.postUser(room, `${prefix}字体也换一下`, entry === "direct fork" ? { fork: true } : {});
        await h.routed();
        gate.resolve();
        await h.waitIdle();

        const turns = h.turns(alpha!);
        expect(turns.map((turn) => turn.mode)).toEqual(["desk"]);
        expect(h.store.db.query("SELECT state, delivered_turn_id FROM inbox_items WHERE message_id = ? AND bot_id = ?").all(second.id, alpha!.id))
          .toEqual([{ state: "answered", delivered_turn_id: turns[0]!.id }]);
      });
    }
  }
});

describe("D1: a line the open desk segment ended without reading", () => {
  for (const level of LEVELS) {
    test(`${level.name}: opens the next desk segment, which reads it as its trigger, and is not left queued`, async () => {
      const h = await scenario(level.options);
      const [alpha, beta] = h.createBots("Alpha", "Beta");
      const room = h.group("Studio", [alpha!, beta!]);
      h.store.openTask({ sessionId: room, title: "Film" });
      h.store.openTask({ sessionId: room, title: "Poster" });
      const gate = Promise.withResolvers<void>();
      let reached = false;
      const triggers: string[] = [];
      h.script(alpha!).handle(async (ctx) => {
        if (!reached) {
          reached = true;
          await gate.promise;
        }
        triggers.push(h.store.getMessage(ctx.turn!.trigger_message_id).body);
        return answerAll(ctx);
      });
      h.postUser(room, "@Alpha 看一下配色");
      await h.waitFor(() => reached, { what: "Alpha's desk segment to be mid-hop" });
      const second = h.postUser(room, "@Alpha 字体也换一下");
      await h.routed();
      gate.resolve();
      await h.waitIdle();
      expect(h.turns(alpha!).map((turn) => turn.mode)).toEqual(["desk", "desk"]);
      expect(triggers).toEqual(["@Alpha 看一下配色", "@Alpha 字体也换一下"]);
      // Read again by the next segment of the same work (level 2), or taken up as its trigger where
      // the ended desk's work closed with it (level 4): either way not queued for nobody.
      const [row] = h.store.db.query<{ state: string }, [string]>("SELECT state FROM inbox_items WHERE message_id = ?").all(second.id);
      expect([level.name === "level 2" ? "answered" : "superseded"]).toEqual([row!.state]);
    });
  }
});

describe("D2: a line of yours that only might mean a stop or a go on", () => {
  for (const level of LEVELS) {
    test(`${level.name}: is filed like any line, its quote followed, and heard by the segment at work on that job`, async () => {
      const h = await scenario(level.options);
      const [bot] = h.createBots("Writer");
      const dm = h.direct(bot!);
      const plan = h.store.openTask({ sessionId: dm, title: "Report" });
      const ticket = h.store.createTicket({ taskId: plan.id, title: "Draft", worker: bot!.id });
      const seed = seedLine(h, dm, bot!.id, plan.id, ticket.id, "草稿目录建好了");
      const gate = Promise.withResolvers<void>();
      let working = false;
      h.script(bot!).handle(async (ctx) => {
        if (ctx.hop === 1 && !working) {
          working = true;
          await gate.promise;
          return call(tool("list_dir", { path: "." }));
        }
        return answerAll(ctx);
      });
      h.postUser(dm, "写报告第一版", { parentId: seed.id });
      await h.waitFor(() => working, { what: "the segment on the report to be mid-hop" });

      const plain = h.postUser(dm, "继续优化标题");
      const quoting = h.postUser(dm, "还没好吗，接着写", { parentId: seed.id });
      await h.routed();
      gate.resolve();
      await h.waitIdle();

      for (const line of [plain, quoting]) {
        expect(h.store.getMessage(line.id)).toMatchObject({ control: { kind: "possible_control" }, filing_state: "filed", task_id: plan.id });
      }
      // Its quote of the ticket's line is followed (ADR 0040 §8.2 signal 3), not dropped.
      expect(h.store.getMessage(quoting.id).ticket_id).toBe(ticket.id);
      // No desk segment opens for them: the segment on the report reads both (at level 2 the old
      // plan call-back may open one more on the report afterwards, which is not about these lines).
      const turns = h.turns(bot!);
      expect(turns.every((turn) => turn.mode === "work" && turn.task_id === plan.id)).toBe(true);
      expect(h.store.db.query("SELECT DISTINCT delivered_turn_id FROM inbox_items WHERE message_id IN (?, ?)").all(plain.id, quoting.id))
        .toEqual([{ delivered_turn_id: turns[0]!.id }]);
    });
  }
});

describe("D3: continuing one job while the Bot works on another in the same conversation", () => {
  /** Alpha's segment stays out until `release`; Beta's first segment fails, leaving its failure line to continue from. */
  async function failedBeside(h: Scenario) {
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    const [alpha, beta] = ["Alpha", "Beta"].map((title) => h.store.openTask({ sessionId: dm, title }));
    const seeds = [alpha!, beta!].map((plan) => seedLine(h, dm, bot!.id, plan.id, null, `${plan.title} 初稿`));
    const release = Promise.withResolvers<void>();
    const state = { alphaOut: false, betaFailed: false, betaResumed: false };
    h.script(bot!).handle(async (ctx) => {
      if (ctx.turn?.task_id === alpha!.id && !state.alphaOut) {
        state.alphaOut = true;
        await release.promise;
        return answerAll(ctx);
      }
      if (ctx.turn?.task_id === beta!.id && !state.betaFailed) {
        state.betaFailed = true;
        return failed("endpoint_error");
      }
      if (ctx.turn?.task_id === beta!.id) state.betaResumed = true;
      return answerAll(ctx);
    });
    h.postUser(dm, "Alpha 改", { parentId: seeds[0]!.id });
    await h.routed();
    h.postUser(dm, "Beta 改", { parentId: seeds[1]!.id });
    await h.routed();
    await h.waitFor(() => h.turns(bot!).some((turn) => turn.task_id === beta!.id && turn.status !== "running"), { what: "Beta's segment to fail" });
    const failure = h.messages(dm).find((message) => message.kind === "system" && message.body === completionFailBody("zh", "endpoint_error"))!;
    return { bot: bot!, dm, alpha: alpha!, beta: beta!, release, state, failure };
  }

  for (const level of LEVELS) {
    test(`${level.name}: your Continue on the failed job goes on beside the other one`, async () => {
      const h = await scenario(level.options);
      const t = await failedBeside(h);
      expect(() => h.engine.continueFromInterrupt(t.failure.id)).not.toThrow();
      await h.waitFor(() => t.state.betaResumed, { what: "Beta to go on" });
      expect(h.store.listLiveTurns({ botId: t.bot.id }).some((turn) => turn.task_id === t.alpha.id)).toBe(true);
      t.release.resolve();
      await h.waitIdle();
    });
  }

  test("level 4: the supervisor picks the failed job up beside the other, with no refusal and no budget spent on one", async () => {
    const h = await scenario({ supervision: true });
    const t = await failedBeside(h);
    h.tick(new Date(Date.now() + 15_000));
    await h.waitFor(() => t.state.betaResumed, { what: "the supervisor to pick Beta up" });
    expect(h.store.listLiveTurns({ botId: t.bot.id }).some((turn) => turn.task_id === t.alpha.id)).toBe(true);
    t.release.resolve();
    await h.waitIdle();
    expect(h.store.listWorkEvents({ kind: "supervisor.pickup_refused" })).toEqual([]);
    expect(h.messages(t.dm).filter((message) => message.control?.kind === "supervisor")).toEqual([]);
  });

  test("level 4: a pick-up the engine cannot continue from its line is recorded as refused and voided", async () => {
    const h = await scenario({ supervision: true });
    const t = await failedBeside(h);
    t.release.resolve();
    await h.waitIdle();
    // Its conversation archived meanwhile: the failure line can no longer be continued.
    h.store.archiveSession(t.dm);
    h.tick(new Date(Date.now() + 15_000));
    await h.waitIdle();
    const [refused] = h.store.listWorkEvents({ kind: "supervisor.pickup_refused" });
    expect(refused?.payload).toMatchObject({ note_id: t.failure.id, code: "invalid_args" });
    expect(h.store.getCheckBack(refused!.payload.check_back_id as string)).toMatchObject({ voided_at: expect.any(String) });
    expect(t.state.betaResumed).toBe(false);
  });

  test("level 4: a pick-up the engine refuses is voided, counts toward no budget, and the next goes by a queued wake", async () => {
    const h = await scenario({ supervision: true });
    const t = await failedBeside(h);
    const now = Date.now() + 15_000;
    // The store's tick alone, so the engine does not carry it out: what it would have continued.
    const first = h.store.supervisorTick({ now: new Date(now).toISOString() }).wakes;
    expect(first).toMatchObject([{ noteId: t.failure.id, cause: "needs_attention" }]);
    h.store.refuseSupervisorPickup({ checkBackId: first[0]!.checkBackId, code: "already_working", now: new Date(now).toISOString() });
    expect(h.store.getCheckBack(first[0]!.checkBackId)).toMatchObject({ voided_at: expect.any(String) });
    expect(h.store.listWorkEvents({ kind: "supervisor.pickup_refused" }).map((event) => event.payload))
      .toMatchObject([{ note_id: t.failure.id, check_back_id: first[0]!.checkBackId, code: "already_working" }]);
    const next = h.store.supervisorTick({ now: new Date(now + 15_000).toISOString() }).wakes;
    expect(next).toMatchObject([{ noteId: null, inboxSeq: expect.any(Number), cause: "needs_attention" }]);
    const spec = JSON.parse(h.store.getCheckBack(next[0]!.checkBackId)!.wait_spec!) as { attempt: number };
    expect(spec.attempt).toBe(1);
    t.release.resolve();
    await h.waitIdle();
  });
});

describe("D4: a line of yours filed under a job after it arrived reaches the scribe", () => {
  function countScribe(h: Scenario): string[] {
    const quotes: string[] = [];
    h.judge("scribe").handle(({ payload }) => {
      quotes.push(JSON.stringify(payload));
      return { adds: [], raises: [], supersedes: [] };
    });
    return quotes;
  }

  for (const level of LEVELS) {
    test(`${level.name}: a desk segment opening a job for it`, async () => {
      const h = await scenario(level.options);
      const [bot] = h.createBots("Writer");
      const dm = h.direct(bot!);
      const quotes = countScribe(h);
      h.script(bot!).reply(call(writeFile("report.md", "draft")), answerAll);
      const line = h.postUser(dm, "帮我写一份季度报告，要简洁");
      await h.waitIdle();
      expect(h.store.getMessage(line.id).task_id).not.toBeNull();
      expect(quotes).toHaveLength(1);
      expect(quotes[0]).toContain("帮我写一份季度报告，要简洁");
    });
  }

  test("level 4: the desk segment choosing its job with work_on", async () => {
    const h = await scenario({ supervision: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    h.store.openTask({ sessionId: dm, title: "Report" });
    const site = h.store.openTask({ sessionId: dm, title: "Website" });
    const quotes = countScribe(h);
    h.script(bot!).reply(call(tool("work_on", { plan: site.id })), answerAll);
    const line = h.postUser(dm, "首页配色统一用深蓝");
    await h.waitIdle();
    expect(h.store.getMessage(line.id).task_id).toBe(site.id);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toContain("首页配色统一用深蓝");
  });

  test("level 4: filed when it arrived and again by work_on, it is read once", async () => {
    const h = await scenario({ supervision: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: dm, title: "Report" });
    const quotes = countScribe(h);
    h.script(bot!).reply(call(tool("work_on", { plan: plan.id })), answerAll);
    const line = h.postUser(dm, "标题再短一点");
    await h.waitIdle();
    expect(h.store.getMessage(line.id).task_id).toBe(plan.id);
    expect(quotes).toHaveLength(1);
  });

  test("level 4: your correction of a line on no job", async () => {
    const h = await scenario({ supervision: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    h.store.openTask({ sessionId: dm, title: "Report" });
    const site = h.store.openTask({ sessionId: dm, title: "Website" });
    const quotes = countScribe(h);
    h.script(bot!).reply(say("先问一下：是哪一件？"));
    const line = h.postUser(dm, "配色统一用深蓝");
    await h.waitIdle();
    expect(h.store.getMessage(line.id).task_id).toBeNull();
    expect(quotes).toEqual([]);
    h.store.refileMessage(line.id, { filings: [{ taskId: site.id }], userActionId: "audit-d4" });
    h.engine.noteFiled(line.id);
    await h.waitIdle();
    expect(quotes).toHaveLength(1);
    // Noted again, it is not read again.
    h.engine.noteFiled(line.id);
    await h.waitIdle();
    expect(quotes).toHaveLength(1);
  });
});

describe("D5: a line in your direct with a Bot and a group plan it never worked on", () => {
  for (const level of LEVELS) {
    test(`${level.name}: the line is not filed there, and the Bot's own job opens for it`, async () => {
      const h = await scenario(level.options);
      const [writer, helper] = h.createBots("Writer", "Helper");
      const group = h.group("Studio", [writer!, helper!]);
      const groupPlan = h.store.openTask({ sessionId: group, title: "宣传片" });
      const dm = h.direct(writer!);
      h.script(writer!).reply(call(writeFile("poem.md", "诗")), answerAll);
      const line = h.postUser(dm, "帮我写首关于秋天的诗");
      await h.waitIdle();
      expect(h.store.planCandidates({ sessionId: dm, botId: writer!.id }).some((candidate) => candidate.id === groupPlan.id)).toBe(false);
      const filed = h.store.getMessage(line.id).task_id;
      expect(filed).not.toBeNull();
      expect(filed).not.toBe(groupPlan.id);
      expect(h.turns(writer!).map((turn) => turn.task_id)).toEqual([filed]);
    });
  }
});

describe("D6: a job stopped with Stop and let go with the button", () => {
  test("level 4: is called back once quiet, rather than left running with nobody to move it", async () => {
    const h = await scenario({ supervision: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: dm, title: "Report" });
    const ticket = h.store.createTicket({ taskId: plan.id, title: "Draft", worker: bot!.id });
    const seed = seedLine(h, dm, bot!.id, plan.id, ticket.id, "草稿目录建好了");
    const gate = Promise.withResolvers<void>();
    let reached = false;
    h.script(bot!).reply(async () => {
      reached = true;
      await gate.promise;
      return call(writeFile(`${ticket.dir}/x.md`, "after stop"));
    });
    h.script(bot!).handle(answerAll);
    h.postUser(dm, "开始写", { parentId: seed.id });
    await h.waitFor(() => reached, { what: "the segment to be mid-hop" });
    const [segment] = h.turns(bot!);
    h.engine.stop(segment!.id, { button: true });
    gate.resolve();
    await h.waitIdle();
    for (const hold of h.store.listHolds({ inForce: true })) h.engine.liftHold(hold.id);
    await h.waitIdle();
    expect(workState(h, plan.id)).toEqual(["idle"]);
    h.tick(new Date(Date.now() + 3 * 60_000));
    await h.waitIdle();
    expect(h.turns(bot!).map((turn) => turn.status)).toEqual(["stopped", "completed"]);
    expect(h.store.db.query("SELECT json_extract(wait_spec, '$.reason') AS reason FROM check_backs WHERE kind = 'supervisor'").all())
      .toEqual([{ reason: "orphan" }]);
  });

  test("level 4: the supervisor settles running work whose segment ended unseen, leaving held work alone", async () => {
    const h = await scenario({ supervision: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    const plans = ["Stopped", "Held", "Failed"].map((title) => h.store.openTask({ sessionId: dm, title }));
    const segments = plans.map((plan) => {
      const line = h.store.postMessage(dm, { body: `${plan.title} 开始` });
      return h.store.createTurn({ sessionId: dm, botId: bot!.id, triggerMessageId: line.id, taskId: plan.id });
    });
    // Each ended without the engine settling its work (an older build, a crash between writes).
    h.store.db.run("UPDATE turns SET status = 'stopped', end_reason = 'stopped' WHERE id IN (?, ?)", [segments[0]!.id, segments[1]!.id]);
    h.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'completed' WHERE id = ?", [segments[2]!.id]);
    h.store.insertMessage({ sessionId: dm, turnId: segments[2]!.id, kind: "system", author: bot!.id, body: completionFailBody("zh", "endpoint_error") });
    h.engine.createHold({ scope: "plan", scopeId: plans[1]!.id });
    expect(plans.map((plan) => workState(h, plan.id))).toEqual([["running"], ["running"], ["running"]]);
    const tick = h.store.supervisorTick({ now: new Date(Date.now() + 1_000).toISOString() });
    expect(plans.map((plan) => workState(h, plan.id))).toEqual([["idle"], ["running"], ["needs_attention"]]);
    expect(tick.repaired.map((row) => row.reason).sort()).toEqual(["lost_segment", "segment_ended"]);
  });
});

describe("D7: a reply in words to the line of yours it read mid-segment", () => {
  test("level 4: ends the segment, the line answered by it, with no bounce and nothing to pick up", async () => {
    const h = await scenario({ supervision: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: dm, title: "Report" });
    const release = Promise.withResolvers<void>();
    let reached = false;
    h.script(bot!).reply(async () => {
      reached = true;
      await release.promise;
      return call(writeFile(`${plan.dir}/a.md`, "x"));
    }, say("好的，标题已改"), say("标题已改好"), say("标题改好了"));
    h.postUser(dm, "写报告");
    await h.waitFor(() => reached, { what: "the segment to be mid-hop" });
    const line = h.postUser(dm, "标题改成《季报》");
    await h.routed();
    release.resolve();
    await h.waitIdle();
    expect(h.turns(bot!).map((turn) => [turn.status, turn.end_reason])).toEqual([["completed", "done"]]);
    expect(h.hops(bot!)).toHaveLength(2);
    expect(h.store.listWorkEvents({ kind: "end.rejected" })).toEqual([]);
    expect(h.store.db.query("SELECT state FROM inbox_items WHERE message_id = ?").all(line.id)).toEqual([{ state: "answered" }]);
    expect(workState(h, plan.id)).toEqual(["idle"]);
    h.tick(new Date(Date.now() + 5_000));
    await h.waitIdle();
    expect(h.turns(bot!)).toHaveLength(1);
  });
});

describe("D8: at level 2, the work a segment ran stops saying running when the segment ends", () => {
  test("completed, stopped, a desk's, and what a crash left", async () => {
    const h = await scenario({ workItems: true, durable: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    const [report, site] = ["Report", "Website"].map((title) => h.store.openTask({ sessionId: dm, title }));
    const [toReport, toSite] = [report!, site!].map((plan) => seedLine(h, dm, bot!.id, plan.id, null, `${plan.title} 初稿`));
    h.script(bot!).reply(answerAll);
    h.postUser(dm, "Report 再改改", { parentId: toReport!.id });
    await h.waitIdle();
    expect(workState(h, report!.id)).toEqual(["idle"]);

    // A desk segment's work, on no job, is closed.
    h.script(bot!).reply(say("哪一件？"));
    h.postUser(dm, "顺便看看错别字");
    await h.waitIdle();
    expect(h.store.db.query("SELECT state FROM work_items WHERE task_id IS NULL").all()).toEqual([{ state: "closed" }]);

    // Stopped mid-hop.
    const gate = Promise.withResolvers<void>();
    let reached = false;
    h.script(bot!).reply(async () => {
      reached = true;
      await gate.promise;
      return say("改好了");
    });
    h.postUser(dm, "Website 也改改", { parentId: toSite!.id });
    await h.waitFor(() => reached, { what: "the segment on the website" });
    h.engine.stop(h.turns(bot!).at(-1)!.id, { button: true });
    gate.resolve();
    await h.waitIdle();
    expect(workState(h, site!.id)).toEqual(["idle"]);

    // Cut off by a crash: the boot after it settles what the dead process ran.
    let out = false;
    h.script(bot!).reply(() => {
      out = true;
      return new Promise(() => {});
    });
    h.postUser(dm, "Report 第三版", { parentId: toReport!.id });
    await h.waitFor(() => out, { what: "a segment in flight" });
    await h.restart({ clean: false });
    await h.waitIdle();
    expect(workState(h, report!.id)).toEqual(["idle"]);
    expect(h.store.db.query("SELECT COUNT(*) AS n FROM work_items WHERE state = 'running'").get()).toEqual({ n: 0 });
  });
});

describe("D8: the boot after a run that left segments live", () => {
  for (const level of LEVELS) {
    test(`${level.name}: settles the work they ran, leaving a job at the supervisor's level to the supervisor`, async () => {
      const h = await scenario(level.options);
      const [bot] = h.createBots("Writer");
      const dm = h.direct(bot!);
      const plan = h.store.openTask({ sessionId: dm, title: "Report" });
      // Rows only, as a process that died mid-segment left them: nothing in this process runs them.
      const onPlan = h.store.createTurn({ sessionId: dm, botId: bot!.id, triggerMessageId: h.store.postMessage(dm, { body: "Report 改" }).id, taskId: plan.id });
      const [helper] = h.createBots("Helper");
      const otherDm = h.direct(helper!);
      const desk = h.store.createTurn({ sessionId: otherDm, botId: helper!.id, triggerMessageId: h.store.postMessage(otherDm, { body: "随便问问" }).id });
      expect([onPlan.mode, desk.mode]).toEqual(["work", "desk"]);
      h.store.recoverInterruptedTurns();
      expect(workState(h, plan.id)).toEqual([level.name === "level 2" ? "idle" : "needs_attention"]);
      expect(h.store.db.query("SELECT state FROM work_items WHERE id = ?").get(desk.work_item_id!)).toEqual({ state: "closed" });
    });
  }
});

describe("D9: plans nobody is on any more stop being where your lines land", () => {
  test("level 2: a new job opened in a conversation puts its older idle jobs to sleep", async () => {
    const h = await scenario({ workItems: true });
    const [bot] = h.createBots("Writer");
    const dm = h.direct(bot!);
    const old = h.store.openTask({ sessionId: dm, title: "旧报告" });
    const recent = h.store.openTask({ sessionId: dm, title: "最近的事" });
    const long = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    h.store.db.run("UPDATE tasks SET created_at = ? WHERE id IN (?, ?)", [long, old.id, recent.id]);
    h.store.db.run(`INSERT INTO user_quotes (id, session_id, task_id, via, body, created_at) VALUES ('recent-quote', ?, ?, 'message', '再改改', ?)`,
      [dm, recent.id, new Date().toISOString()]);
    const line = h.postUser(dm, "另外帮我写首诗");
    h.script(bot!).reply(() => call(tool("work_on", { plan: { new: { title: "诗", quote_message_id: line.id } } })), answerAll);
    await h.waitIdle();
    expect(h.store.getTask(old.id).dormant_since).not.toBeNull();
    expect(h.store.getTask(recent.id).dormant_since).toBeNull();
    expect(h.store.listWorkEvents({ kind: "plan.dormant" }).map((event) => [event.task_id, event.payload.cause])).toEqual([[old.id, "new_plan"]]);
  });
});

describe("D10: typing a line while the Bot waits on your answer to its question", () => {
  for (const level of LEVELS) {
    test(`${level.name}: the line is the answer, and the segment goes on with it`, async () => {
      const h = await scenario(level.options);
      const [bot] = h.createBots("Writer");
      const dm = h.direct(bot!);
      h.store.openTask({ sessionId: dm, title: "Report" });
      let heard = "";
      h.script(bot!).reply(call(tool("ask_user", { question: "给谁看？", options: ["老板", "客户"] })), (ctx) => {
        heard = requestText(ctx.request);
        return answerAll(ctx);
      });
      h.postUser(dm, "写报告");
      await h.waitFor(() => h.turns(bot!)[0]?.status === "waiting_ask", { what: "the question" });
      const typed = h.postUser(dm, "给外部客户看，语气正式");
      await h.waitIdle();
      const ask = h.messages(dm).find((message) => message.kind === "ask")!;
      expect(ask.ask_answer).toMatchObject({ custom: "给外部客户看，语气正式" });
      expect(heard).toContain("给外部客户看，语气正式");
      expect(h.turns(bot!).map((turn) => turn.status)).toEqual(["completed"]);
      expect(h.store.db.query("SELECT state FROM inbox_items WHERE message_id = ?").all(typed.id)).toEqual([]);
    });
  }
});

describe("D11: two Bots naming each other with nods in a group", () => {
  for (const level of LEVELS) {
    test(`${level.name}: the nod to a nod wakes nobody`, async () => {
      const h = await scenario(level.options);
      const [alpha, beta] = h.createBots("Alpha", "Beta");
      const group = h.group("Studio", [alpha!, beta!]);
      h.store.openTask({ sessionId: group, title: "Film" });
      // Bounded, so that without the brake the test fails on the count instead of running for ever.
      let turns = 0;
      const nod = (name: string) => (ctx: HopContext) => (++turns > 8 ? answerAll(ctx) : say(`@${name} 收到，已对齐`));
      h.script(alpha!).handle(nod("Beta"));
      h.script(beta!).handle(nod("Alpha"));
      h.judge("judgement").handle(() => "pass");
      h.postUser(group, "@Alpha 和 Beta 对一下分工");
      await h.waitIdle();
      expect(h.turns(alpha!)).toHaveLength(1);
      expect(h.turns(beta!)).toHaveLength(1);
      expect(h.messages(group).filter((message) => message.kind === "bot").map((message) => message.body))
        .toEqual(["@Beta 收到，已对齐", "@Alpha 收到，已对齐"]);
    });
  }
});

describe("D12: two endings without progress, with work still open", () => {
  for (const locale of ["zh", "en"] as const) {
    test(`level 4, ${locale}: the notice is in your language and names the job`, async () => {
      const h = await scenario({ supervision: true, locale });
      const [bot] = h.createBots("Writer");
      const dm = h.direct(bot!);
      const plan = h.store.openTask({ sessionId: dm, title: "Report" });
      const ticket = h.store.createTicket({ taskId: plan.id, title: "Draft", worker: bot!.id });
      const seed = seedLine(h, dm, bot!.id, plan.id, ticket.id, "草稿目录建好了");
      h.script(bot!).handle(({ request }) => call(tool("end_turn", {
        reason: "nothing_new", inbox: yourLabels(request).map((id) => ({ id, disposition: "deferred" })),
      })));
      h.postUser(dm, "开始写", { parentId: seed.id });
      await h.waitIdle();
      h.postUser(dm, "第二段写得更具体些", { parentId: seed.id });
      await h.waitIdle();
      expect(workState(h, plan.id)).toEqual(["blocked"]);
      const notices = h.messages(dm).filter((message) => message.kind === "system").map((message) => message.body);
      expect(notices).toEqual([locale === "en"
        ? `ticket 01 "Draft": Writer ended twice in a row without progress and there is still work open on it, so it waits for you. Say how to go on, or @ Writer.`
        : "任务 01《Draft》：Writer连续两次结束都没有进展，还有没做完的事，先停下等你。说一句接下来怎么做，或者 @ Writer。"]);
    });
  }
});

describe("D13: a job opened from a line that names a Bot", () => {
  test("level 4: is titled without the name", async () => {
    const h = await scenario({ supervision: true });
    const [alpha, beta] = h.createBots("Alpha", "Beta");
    const group = h.group("Studio", [alpha!, beta!]);
    h.script(alpha!).reply(call(writeFile("logo.md", "logo")), answerAll);
    h.postUser(group, "@Alpha 做一个 logo");
    await h.waitIdle();
    expect(h.store.db.query("SELECT title FROM tasks WHERE session_id = ?").all(group)).toEqual([{ title: "做一个 logo" }]);
  });
});
