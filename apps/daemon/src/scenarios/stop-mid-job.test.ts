/**
 * A group job stopped half-way, and one left waiting on your 放行 (walked through on 2026-10-04 at
 * engine level 8). 设计师, the lead you confirmed in 海报组, lays the poster job out and hands the
 * three slogans to 文案, who works on them in its direct with 设计师.
 *
 * - You stop the group from its menu while 文案 is at it, and say what to change:
 *   「宣传语改成英文的，海报改横版」. The stop lifted on your line and the receipt had said the Bots go on
 *   from it, but the line woke only the lead: 文案, cut off in a conversation of its own, sat stopped
 *   and never heard the change, until the supervisor called it back three minutes later to "answer"
 *   the old request.
 * - 文案 hands the slogans in and 设计师 approves them; both run on the same model, so the approval
 *   waits on your 放行. While the card waited, the supervisor called 文案 back every three minutes:
 *   the request it had handed in for still read as one it owed, and it handed the same work in again
 *   each time — five hand-overs in twelve minutes.
 */
import { afterEach, expect, test } from "bun:test";
import { confirmGroupLead } from "../store/group-leads";
import { call, createScenario, requestText, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function posterTeam() {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const dirOf = (title: string) => h.store.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE title = ?").get(title)!.dir;
  return { h, designer: designer!, writer: writer!, room, ticketId, dirOf };
}

const stop = call(tool("end_turn", { reason: "nothing_new" }));

test("a group stopped mid-job goes on from the change you say next, the Bot cut off elsewhere included", async () => {
  const { h, designer, writer, room, ticketId, dirOf } = await posterTeam();
  let laidOut = false;
  h.script(designer).handle(({ hop }) => {
    if (laidOut) return stop;
    if (hop === 1) return call(tool("plan_items", { items: [
      { title: "三句宣传语", owner: "文案", reviewer: "设计师" },
      { title: "竖版海报", owner: "设计师", depends_on: ["三句宣传语"] },
    ] }));
    laidOut = true;
    return call(tool("delegate", { to: "文案", ask: "写三句咖啡店开业宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
  });
  // At work on the slogans when you stop the group: its hop answers only once the stop has landed.
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  let writerTurns = 0;
  h.script(writer).handle(async ({ hop }) => {
    if (hop === 1 && ++writerTurns === 1) {
      await stopped;
      return call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, "1. 一杯好咖啡，从今天开始\n"));
    }
    if (hop === 1) return call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, "1. A good cup starts today\n2. Grand opening, second cup half price\n3. Slow down, sip the sunshine\n"));
    if (hop === 2) return call(tool("submit", { artifacts: [`${dirOf("三句宣传语")}/slogans.md`] }));
    return stop;
  });

  h.postUser(room, "做一张咖啡店开业海报，竖版，配三句宣传语");
  await h.waitFor(() => writerTurns === 1, { timeoutMs: 5_000, what: "文案 at work on the slogans" });
  // The group's stop menu: a stop on the group your next line there lifts.
  const hold = h.engine.createHold({ scope: "session", scopeId: room, liftOnNextUserMessage: true, sessionId: room });
  release();
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(h.turns(writer).map((turn) => turn.status)).toEqual(["stopped"]);

  const change = h.postUser(room, "宣传语改成英文的，海报改横版");
  await h.waitIdle({ timeoutMs: 15_000 });

  expect(h.store.getHold(hold.id).lifted_message_id).toBe(change.id);
  // 文案 goes on at once — no supervisor's call-back — on its own slogans, and has your change as
  // a line of yours to answer for, word for word.
  const [, resumed] = h.turns(writer);
  expect(resumed).toMatchObject({ ticket_id: ticketId("三句宣传语") });
  expect(h.store.getMessage(resumed!.trigger_message_id).body).toStartWith("（应用提示）用户叫停了这件工作，现在解除了（原话：「宣传语改成英文的，海报改横版」）");
  const first = h.hops(writer).find((hop) => hop.turnId === resumed!.id && hop.hop === 1)!;
  expect(requestText(first.request)).toContain("在群「海报组」里] 宣传语改成英文的，海报改横版");
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM submissions").get()!.n).toBe(1);
  // The lead took the line in the group as before.
  expect(h.turns(designer).map((turn) => h.store.getMessage(turn.trigger_message_id).body)).toContain("宣传语改成英文的，海报改横版");
});

test("a line that names one Bot after a group's stop is for it alone: the work it does not reach stays stopped", async () => {
  const { h, designer, writer, room, ticketId } = await posterTeam();
  let laidOut = false;
  h.script(designer).handle(({ hop }) => {
    if (laidOut) return stop;
    if (hop === 1) return call(tool("plan_items", { items: [{ title: "三句宣传语", owner: "文案", reviewer: "设计师" }] }));
    laidOut = true;
    return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
  });
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  let writerTurns = 0;
  h.script(writer).handle(async () => {
    if (++writerTurns === 1) await stopped;
    return stop;
  });

  h.postUser(room, "写三句咖啡店开业宣传语");
  await h.waitFor(() => writerTurns === 1, { timeoutMs: 5_000, what: "文案 at work" });
  h.engine.createHold({ scope: "session", scopeId: room, liftOnNextUserMessage: true, sessionId: room });
  release();
  await h.waitIdle({ timeoutMs: 15_000 });

  h.postUser(room, "@设计师 海报改横版");
  await h.waitIdle({ timeoutMs: 15_000 });

  expect(h.turns(writer).map((turn) => turn.status)).toEqual(["stopped"]);
});

test("while your 放行 waits, nobody is called back to answer the request it answers", async () => {
  const { h, designer, writer, room, ticketId, dirOf } = await posterTeam();
  let laidOut = false;
  let reviewed = false;
  h.script(designer).handle(({ turn, hop }) => {
    if (!laidOut && hop === 1) return call(tool("plan_items", { items: [{ title: "三句宣传语", owner: "文案", reviewer: "设计师" }] }));
    if (!laidOut) {
      laidOut = true;
      return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
    }
    if (turn?.ticket_id === ticketId("三句宣传语") && !reviewed) {
      reviewed = true;
      return call(tool("review", { outcome: "approve", verdicts: [], note: "三句都不超过 12 个字。" }));
    }
    return stop;
  });
  // Each time it is called back it hands the slogans in again, as a Bot told it still owes them would.
  h.script(writer).handle(({ hop }) => hop === 1
    ? call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, "1. 一杯好咖啡，从今天开始\n"))
    : hop === 2 ? call(tool("submit", { artifacts: [`${dirOf("三句宣传语")}/slogans.md`] })) : stop);

  h.postUser(room, "写三句咖啡店开业宣传语");
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(h.messages(room).some((message) => message.control?.kind === "review_item")).toBe(true);

  // You leave the card for twelve minutes.
  for (const minutes of [3, 6, 9, 12]) {
    h.tick(new Date(Date.now() + minutes * 60_000));
    await h.waitIdle({ timeoutMs: 15_000 });
  }

  expect(h.turns(writer)).toHaveLength(1);
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM submissions").get()!.n).toBe(1);
  expect(h.store.db.query<{ status: string }, []>("SELECT status FROM delegations").get()!.status).toBe("open");
});

test("a lead woken at the job's level by your change can still hand its ticket in", async () => {
  // Real-model run, 2026-10-04: after the stop, 「宣传语改成英文的，海报改横版」 was filed to the whole job
  // and opened the lead's turn there. It made the landscape poster, then could not submit (no
  // ticket) nor work_on its ticket 01 (it had already acted), and gave up with the job undelivered.
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const opening = () => h.store.db.query<{ id: string; dir: string; task_id: string }, []>("SELECT id, dir, task_id FROM tickets ORDER BY created_at LIMIT 1").get()!;
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  let turns = 0;
  h.script(designer!).handle(async ({ hop, turn }) => {
    if (hop === 1) turns++;
    // Its first segment opens the job, then is at work when you stop the group.
    if (turns === 1) {
      if (hop === 1) return call(writeFile("work/notes.md", "竖版"));
      await stopped;
      return call(tool("end_turn", { reason: "nothing_new" }));
    }
    // Woken by your change, at the job's level: a draft in the job's folder (no ticket's), then the
    // ticket, then the poster in its folder, handed in.
    const planDir = () => opening().dir.replace(/\/[^/]+$/, "");
    if (hop === 1) return call(writeFile(`${planDir()}/draft.md`, "横版、英文"));
    if (hop === 2) return call(tool("submit", { artifacts: [`${planDir()}/draft.md`] }));
    if (hop === 3) return call(tool("work_on", { plan: turn!.task_id!, ticket: opening().id }));
    if (hop === 4) return call(writeFile(`${opening().dir}/poster.svg`, "<svg/>"));
    if (hop === 5) return call(tool("submit", { artifacts: [`${opening().dir}/poster.svg`] }));
    return stop;
  });
  h.script(writer!).reply(stop);

  h.postUser(room, "做一张咖啡店开业海报，竖版，配三句宣传语");
  await h.waitFor(() => turns === 1 && h.toolCalls(designer!, "write_file").length === 1, { timeoutMs: 5_000, what: "the lead at work" });
  h.engine.createHold({ scope: "session", scopeId: room, liftOnNextUserMessage: true, sessionId: room });
  release();
  await h.waitIdle({ timeoutMs: 15_000 });
  h.postUser(room, "宣传语改成英文的，海报改横版");
  await h.waitIdle({ timeoutMs: 15_000 });

  const changed = h.turns(designer!).at(-1)!;
  const calls = h.toolCalls(designer!).filter((c) => c.turnId === changed.id && c.name !== "end_turn");
  expect(calls.map((c) => [c.name, c.result?.ok])).toEqual([["write_file", true], ["submit", false], ["work_on", true], ["write_file", true], ["submit", true]]);
  expect(h.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM submissions WHERE ticket_id = ?").get(opening().id)!.n).toBe(1);
});
