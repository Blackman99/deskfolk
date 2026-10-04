/**
 * A whole job in a group, the way a lead runs it (walked through on 2026-10-03 at engine level 8).
 * You ask 海报组 for a poster with three slogans; 设计师, the lead you confirmed, lays the job out
 * with `plan_items` — the slogans for 文案, reviewed by itself; the poster its own, after the
 * slogans — and delegates the slogans. 文案 submits, 设计师 approves, and since both run on the same
 * model the approval waits on your 放行. What went wrong, end to end:
 *
 * - The desk's first effect opened the job with a ticket of its own name, 01 「做一张咖啡店开业海报，
 *   竖版，配三句宣传语」, owned by 设计师: next to the lead's two tickets it was a third nobody would
 *   ever hand in, which kept the job from being delivered.
 * - The delegation for the slogans stayed open after you approved them: 设计师 waited on it for good
 *   and was never told (the three deliverable delegations in the live database all ended only when
 *   their group was cleared).
 * - Woken at last by the supervisor 3½ minutes later, a segment bound to one ticket could not move
 *   to its own poster ticket: `work_on` refused any other ticket.
 */
import { afterEach, expect, test } from "bun:test";
import { confirmGroupLead } from "../store/group-leads";
import { call, createScenario, requestText, say, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("you approve the slogans, and the lead goes straight on to its poster", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const dirOf = (title: string) => h.store.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE title = ?").get(title)!.dir;

  let reviewed = false;
  let calls = 0;
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  h.script(designer!).handle(({ turn, hop }) => {
    const on = turn?.ticket_id ?? null;
    // Never more than a handful of steps a segment, nor in all: a refused step must not loop.
    if (hop > 4 || ++calls > 14) return stop;
    // Your request, at its desk: lay the job out, then hand the slogans over.
    if (hop === 1 && turn?.mode === "desk") {
      return call(tool("plan_items", { items: [
        { title: "三句宣传语", owner: "文案", reviewer: "设计师" },
        { title: "竖版海报", owner: "设计师", depends_on: ["三句宣传语"] },
      ] }));
    }
    if (hop === 2 && !reviewed && on !== ticketId("竖版海报")) {
      return call(tool("delegate", { to: "文案", ask: "写三句咖啡店开业宣传语，每句不超过 12 个字", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
    }
    // Asked to review the slogans: review, and that is this segment's work.
    if (on === ticketId("三句宣传语")) {
      if (reviewed) return stop;
      reviewed = true;
      return call(tool("review", { outcome: "approve", verdicts: [], note: "三句都不超过 12 个字。" }));
    }
    // Told the slogans are in: on to its own poster.
    if (on !== ticketId("竖版海报")) return call(tool("work_on", { plan: turn!.task_id!, ticket: ticketId("竖版海报")! }));
    if (hop <= 2) return call(writeFile(`${dirOf("竖版海报")}/poster.txt`, "海报：一杯好咖啡，从今天开始"));
    return call(tool("submit", { artifacts: [`${dirOf("竖版海报")}/poster.txt`] }));
  });
  h.script(writer!).handle(({ hop }) => hop > 2 ? stop : hop === 1
    ? call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, "1. 一杯好咖啡，从今天开始\n2. 新店开张，第二杯半价\n3. 慢下来，喝一口阳光\n"))
    : call(tool("submit", { artifacts: [`${dirOf("三句宣传语")}/slogans.md`] })));

  h.postUser(room, "做一张咖啡店开业海报，竖版，配三句宣传语");
  await h.waitIdle({ timeoutMs: 15_000 });

  // The job is laid out as the lead laid it out: no third ticket of the job's own name.
  const plan = h.store.db.query<{ id: string }, []>("SELECT id FROM tasks ORDER BY created_at LIMIT 1").get()!;
  const live = h.store.listTickets(plan.id).filter((ticket) => ticket.status !== "parked");
  expect(live.map((ticket) => ticket.title)).toEqual(["三句宣传语", "竖版海报"]);

  // The lead is told it leads, and what the others do (2026-10-04: real leads wrote the slogans themselves).
  const desk = requestText(h.hops(designer!).find((hop) => hop.hop === 1)!.request);
  expect(desk).toContain("各自做什么：@文案：写宣传语。");
  expect(desk).toContain("你是用户在这个群里确认的负责人：要别人做的部分，先用 plan_items 拆成任务");

  // Same model for both: the approval waits on your 放行.
  const card = h.messages(room).find((message) => message.control?.kind === "review_item")!;
  expect(card).toBeDefined();
  const delegation = h.store.db.query<{ status: string }, []>("SELECT status FROM delegations").get()!;
  expect(delegation.status).toBe("open");

  h.engine.control(card.id, { action: "approve" });
  await h.waitIdle({ timeoutMs: 15_000 });

  // The delegation is answered with the approved hand-over, and the lead goes on with its poster at once.
  expect(h.store.db.query<{ status: string }, []>("SELECT status FROM delegations").get()!.status).toBe("replied");
  expect(h.toolCalls(designer!, "work_on").map((c) => c.result?.ok)).toEqual([true]);
  const posterSubmissions = h.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM submissions WHERE ticket_id = ?").get(ticketId("竖版海报")!)!.n;
  expect(posterSubmissions).toBe(1);
  expect(h.store.db.query("SELECT 1 FROM work_items WHERE state = 'waiting'").all()).toEqual([]);
});

test("a delegated hand-over ends its segment: the delegation it answers is in review, not owed", async () => {
  // Walked through on 2026-10-03: 文案 submitted the slogans and was told "this work still has open
  // requests … carry on" — the delegation it had just handed in for counted as unfinished — so it
  // kept going, rewrote the file and handed it in again over the one under review.
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const dirOf = (title: string) => h.store.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE title = ?").get(title)!.dir;
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  h.script(designer!).handle(({ turn, hop }) => {
    if (hop === 1 && turn?.mode === "desk") return call(tool("plan_items", { items: [{ title: "三句宣传语", owner: "文案", reviewer: "设计师" }] }));
    if (hop === 2 && turn?.ticket_id !== ticketId("三句宣传语")) {
      return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
    }
    return stop;
  });
  // Were it told to carry on, it would write and hand in once more.
  h.script(writer!).handle(({ hop }) => hop === 1 || hop === 3
    ? call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, hop === 1 ? "1. 一杯好咖啡\n" : "1. 再改一版\n"))
    : hop === 2 || hop === 4 ? call(tool("submit", { artifacts: [`${dirOf("三句宣传语")}/slogans.md`] })) : stop);

  h.postUser(room, "写三句咖啡店开业宣传语");
  await h.waitIdle({ timeoutMs: 15_000 });

  const submits = h.toolCalls(writer!, "submit");
  expect(submits).toHaveLength(1);
  // Write, hand in, and the segment is over.
  expect(h.hops(writer!).map((hop) => hop.hop)).toEqual([1, 2]);
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM submissions").get()!.n).toBe(1);
  expect(h.store.db.query<{ status: string }, []>("SELECT status FROM delegations").get()!.status).toBe("open");
});

test("what was filed under the folded opening ticket goes up to the job: your line, and a requirement read from it", async () => {
  // Walked through on 2026-10-04: after the lead laid the job out, your opening line still sat under
  // the dropped ticket of the job's own name in its 归到哪件事, and anything the scribe read from it
  // held for that ticket, which nobody works on.
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  h.judge("scribe", { session: room }).reply({ adds: [{ quote: "每句不超过 12 个字", category: "字数", scope_hint: "ticket" }], raises: [], supersedes: [] });
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  h.script(designer!).handle(async ({ turn, hop }) => {
    // A note first, which opens the job under a ticket of its own name and files your line there.
    if (hop === 1) return call(writeFile("work/notes.md", "海报：竖版；宣传语三句"));
    if (hop === 2) {
      await h.waitFor(() => h.store.db.query("SELECT 1 FROM requirements").get() !== null, { what: "the scribe read the line" });
      return call(tool("plan_items", { items: [{ title: "三句宣传语", owner: "文案" }, { title: "竖版海报", owner: "设计师" }] }));
    }
    return turn ? stop : stop;
  });
  h.script(writer!).reply(stop);

  const line = h.postUser(room, "做一张咖啡店开业海报，竖版，配三句宣传语，每句不超过 12 个字");
  await h.waitIdle({ timeoutMs: 15_000 });

  const plan = h.store.db.query<{ id: string }, []>("SELECT id FROM tasks ORDER BY created_at LIMIT 1").get()!;
  const folded = h.store.db.query<{ id: string; status: string }, [string]>("SELECT id, status FROM tickets WHERE task_id = ? AND title LIKE '做一张%'").get(plan.id)!;
  expect(folded.status).toBe("parked");
  expect(h.store.db.query("SELECT task_id, ticket_id FROM message_filings WHERE message_id = ?").all(line.id)).toEqual([{ task_id: plan.id, ticket_id: null }]);
  expect(h.store.getMessage(line.id).ticket_id).toBeNull();
  expect(h.store.db.query("SELECT ticket_id FROM user_quotes WHERE message_id = ?").all(line.id)).toEqual([{ ticket_id: null }]);
  expect(h.store.db.query("SELECT scope, scope_id FROM requirements").all()).toEqual([{ scope: "plan", scope_id: plan.id }]);
});

test("a lead's request for a piece of its own ticket is refused until the piece has a ticket of its own", async () => {
  // Real-model run on 2026-10-04: the lead sent the slogans straight to 文案 on the job's one
  // ticket, and 文案's slogans went to you to approve as the whole job — 放行 would have delivered
  // it with no poster.
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  h.script(designer!).handle(({ hop, results }) => {
    // Straight to 文案, on its own ticket (the one the request opened).
    if (hop === 1) return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable" }));
    if (hop === 2 && results[0]?.ok === false) return call(tool("plan_items", { items: [{ title: "三句宣传语", owner: "文案", reviewer: "设计师" }] }));
    if (hop === 3) return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
    return stop;
  });
  h.script(writer!).reply(stop);

  h.postUser(room, "做一张咖啡店开业海报，竖版，配三句宣传语");
  await h.waitIdle({ timeoutMs: 15_000 });

  const [refused, laidOut, sent] = h.toolCalls(designer!).filter((c) => c.name !== "end_turn");
  expect(refused!.result).toMatchObject({ ok: false });
  // What it is told: why, and the two ways on.
  const told = requestText(h.hops(designer!).find((hop) => hop.hop === 2)!.request);
  expect(told).toContain("this ticket is your own");
  expect(told).toContain("plan_items");
  expect(laidOut!.result?.ok).toBe(true);
  expect(sent!.result?.ok).toBe(true);
  expect(h.store.db.query("SELECT ticket_id FROM delegations").all()).toEqual([{ ticket_id: ticketId("三句宣传语") }]);
});

test("a lead woken at the job's level that draws in its own ticket's folder hands that ticket in", async () => {
  // Real-model run, 2026-10-04: woken by 文案's approved slogans at the job's level, the lead drew the
  // poster in 03's folder and ended with nothing_new — no ticket bound, so nothing was handed over.
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const dirOf = (title: string) => h.store.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE title = ?").get(title)!.dir;
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  let laidOut = false, reviewed = false, drew = false;
  h.script(designer!).handle(({ turn, hop }) => {
    if (!laidOut && hop === 1) return call(tool("plan_items", { items: [
      { title: "三句宣传语", owner: "文案", reviewer: "设计师" }, { title: "竖版海报", owner: "设计师", depends_on: ["三句宣传语"] }] }));
    if (!laidOut) { laidOut = true; return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! })); }
    if (turn?.ticket_id === ticketId("三句宣传语")) {
      if (reviewed) return stop;
      reviewed = true;
      return call(tool("review", { outcome: "approve", verdicts: [], note: "好" }));
    }
    // Told the slogans are in, at the job's level: draws in its ticket's folder, says nothing, ends.
    if (!drew && hop === 1) { drew = true; return call(writeFile(`${dirOf("竖版海报")}/poster.svg`, "<svg/>")); }
    return stop;
  });
  h.script(writer!).handle(({ hop }) => hop === 1 ? call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, "1. 一杯好咖啡\n"))
    : hop === 2 ? call(tool("submit", { artifacts: [`${dirOf("三句宣传语")}/slogans.md`] })) : stop);

  h.postUser(room, "做一张咖啡店开业海报，竖版，配三句宣传语");
  await h.waitIdle({ timeoutMs: 15_000 });
  h.engine.control(h.messages(room).find((message) => message.control?.kind === "review_item")!.id, { action: "approve" });
  await h.waitIdle({ timeoutMs: 15_000 });

  const drawing = h.turns(designer!).at(-1)!;
  expect(drawing.ticket_id).toBe(ticketId("竖版海报"));
  expect(h.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM submissions WHERE ticket_id = ?").get(ticketId("竖版海报")!)!.n).toBe(1);
});

test("changing a delivered ticket's files after a complaint hands that ticket over again", async () => {
  // Real-model run, 2026-10-04: after 「第二句不够有画面感，换一句」 the lead redrew the approved poster
  // at the job's level; the job stayed delivered with the old poster approved, and no card came.
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const dirOf = (title: string) => h.store.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE title = ?").get(title)!.dir;
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  let complained = false;
  let laidOut = false;
  h.script(designer!).handle(({ hop }) => {
    if (!laidOut && hop === 1) { return call(tool("plan_items", { items: [{ title: "竖版海报", owner: "设计师" }] })); }
    if (!laidOut && hop === 2) return call(tool("work_on", { plan: h.store.db.query<{ id: string }, []>("SELECT id FROM tasks").get()!.id, ticket: ticketId("竖版海报")! }));
    if (!laidOut && hop === 3) return call(writeFile(`${dirOf("竖版海报")}/poster.svg`, "<svg>v1</svg>"));
    if (!laidOut && hop === 4) { laidOut = true; return call(tool("submit", { artifacts: [`${dirOf("竖版海报")}/poster.svg`] })); }
    // Your complaint after delivery, at the job's level: redraw the approved poster and end — told
    // the change is not in front of you, hand it over.
    if (complained && hop === 1) return call(writeFile(`${dirOf("竖版海报")}/poster.svg`, "<svg>v2</svg>"));
    // It ends in words, as the real lead did: its closing reply carries the new poster.
    if (complained && hop === 2) return say("亮一点了，海报已更新。");
    if (complained && hop === 3) return call(tool("submit", { artifacts: [`${dirOf("竖版海报")}/poster.svg`] }));
    return stop;
  });
  h.script(writer!).reply(stop);

  h.postUser(room, "做一张竖版咖啡店开业海报");
  await h.waitIdle({ timeoutMs: 15_000 });
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  h.engine.control(h.messages(room).find((message) => message.control?.kind === "review_item")!.id, { action: "approve" });
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(h.store.db.query<{ status: string }, []>("SELECT status FROM tasks").get()!.status).toBe("done");

  complained = true;
  h.postUser(room, "海报的颜色太暗了，换亮一点");
  await h.waitIdle({ timeoutMs: 15_000 });

  const handed = h.store.db.query<{ state: string }, [string]>("SELECT state FROM submissions WHERE ticket_id = ? ORDER BY created_at").all(ticketId("竖版海报")!);
  const told = requestText(h.hops(designer!).filter((hop) => hop.hop === 3).at(-1)!.request);
  expect(told).toContain("in the folder of a ticket the user already approved, and did not hand it over");
  expect(handed.map((row) => row.state)).toEqual(["approved", "submitted"]);
  expect(h.store.db.query<{ status: string }, []>("SELECT status FROM tasks").get()!.status).toBe("active");

  // You approve the change: the job is delivered again, done as it was the first time.
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  const again = h.messages(room).filter((message) => message.control?.kind === "review_item").at(-1)!;
  h.engine.control(again.id, { action: "approve" });
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(h.store.db.query<{ status: string; stage: string }, []>("SELECT status, stage FROM tasks").get()).toEqual({ status: "done", stage: "delivered" });
});
