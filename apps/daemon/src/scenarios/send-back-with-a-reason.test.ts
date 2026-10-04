/**
 * 退回 on a hand-over's card, saying what to change (2026-10-04). 文案 hands the slogans in, 设计师
 * approves them, and since both run on the same model the approval waits on your 放行. You press
 * 退回 instead. The card's 退回 said nothing more: 文案 was woken with only 「用户把交付 … 退回重做了」
 * and had to guess what was wrong; what you would have said came, if at all, as a line in the
 * group that woke the lead.
 */
import { afterEach, expect, test } from "bun:test";
import { confirmGroupLead } from "../store/group-leads";
import { call, createScenario, requestText, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function cardWaitingOnYou() {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const dirOf = (title: string) => h.store.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE title = ?").get(title)!.dir;
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  let laidOut = false;
  let reviews = 0;
  h.script(designer!).handle(({ turn, hop }) => {
    if (!laidOut && hop === 1) return call(tool("plan_items", { items: [{ title: "三句宣传语", owner: "文案", reviewer: "设计师" }] }));
    if (!laidOut) {
      laidOut = true;
      return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
    }
    if (turn?.ticket_id === ticketId("三句宣传语") && hop === 1 && reviews++ === 0) {
      return call(tool("review", { outcome: "approve", verdicts: [], note: "三句都不超过 12 个字。" }));
    }
    return stop;
  });
  let writerTurns = 0;
  h.script(writer!).handle(({ hop }) => {
    if (hop === 1) writerTurns++;
    if (writerTurns > 1) return stop;
    return hop === 1 ? call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, "1. 一杯好咖啡\n2. 新店开张\n3. 慢下来，喝一口阳光，再来一杯\n"))
      : hop === 2 ? call(tool("submit", { artifacts: [`${dirOf("三句宣传语")}/slogans.md`] })) : stop;
  });
  h.postUser(room, "写三句咖啡店开业宣传语");
  await h.waitIdle({ timeoutMs: 15_000 });
  const card = h.messages(room).find((message) => message.control?.kind === "review_item")!;
  expect(card.control).toMatchObject({ offer: ["approve", "reject"] });
  return { h, writer: writer!, card };
}

test("what you say with 退回 reaches the Bot that made it, word for word, and the card says it", async () => {
  const { h, writer, card } = await cardWaitingOnYou();

  h.engine.control(card.id, { action: "reject", note: "第三句太长，改到 8 个字以内" });
  await h.waitIdle({ timeoutMs: 15_000 });

  const [, rework] = h.turns(writer);
  expect(rework).toBeDefined();
  const first = h.hops(writer).find((hop) => hop.turnId === rework!.id && hop.hop === 1)!;
  expect(requestText(first.request)).toContain("要改的地方，原话：「第三句太长，改到 8 个字以内」");
  expect(h.store.getMessage(card.id).control).toMatchObject({ acted: ["reject"], result: "已退回：「第三句太长，改到 8 个字以内」" });
});

test("退回 alone still sends it back; a note goes with 退回 on a hand-over's card and nothing else", async () => {
  const { h, writer, card } = await cardWaitingOnYou();
  expect(() => h.engine.control(card.id, { action: "approve", note: "不错" })).toThrow("only 退回 on a hand-over's card takes a note");

  h.engine.control(card.id, { action: "reject", note: "   " });
  await h.waitIdle({ timeoutMs: 15_000 });

  expect(h.turns(writer)).toHaveLength(2);
  const control = h.store.getMessage(card.id).control as { result?: string };
  expect(control.result).toBeUndefined();
});

test("what you say with 退回 is your word on the job: the ledger reads it, and the Bot's later turns see it", async () => {
  // 2026-10-04, live: 「一集时长20分钟，不是这么短的视频，而且要有剧情走向」 sent back with the
  // 《一拳超人》 hand-over reached the director once, as its rework note, and nothing else: no
  // quote of yours, no requirement, no check — it reworked to a 27.5-second cut of a 20-minute script.
  const { h, card } = await cardWaitingOnYou();
  const read: string[] = [];
  h.judge("scribe").handle(({ payload }) => {
    read.push(JSON.stringify(payload));
    return { adds: [], raises: [], supersedes: [] };
  });

  h.engine.control(card.id, { action: "reject", note: "每句都要提到店名「巷口」" });
  await h.waitIdle({ timeoutMs: 15_000 });

  expect(h.store.db.query("SELECT via, body FROM user_quotes WHERE message_id = ?").all(card.id)).toEqual([{ via: "ask_answer", body: "每句都要提到店名「巷口」" }]);
  expect(read.some((payload) => payload.includes("每句都要提到店名「巷口」"))).toBe(true);
});
