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
import { call, createScenario, tool, writeFile, type Scenario } from "../test-kit/scenario";

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
