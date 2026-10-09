/**
 * A complaint after you approved the slogans (walked through on 2026-10-04 at engine level 8). The
 * poster group's lead 设计师 laid the job out, 文案 wrote the slogans and you pressed 放行; then you
 * say 「第三句不好，换一句」. Read as a complaint, the line sends 02 back to rework itself (ADR 0070:
 * it used to ask on a card), and it also wakes the lead, as any line of yours in the group does. The
 * lead was not told — it could hand the fix to 文案 while 文案 was being told the same — and its
 * list of tickets still showed the folded opening ticket as 「搁置；设计师在做」 and the approved
 * slogans as 「已通过；文案在做」.
 */
import { afterEach, expect, test } from "bun:test";
import { confirmGroupLead } from "../store/group-leads";
import { call, createScenario, fileUnder, requestText, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("a complaint about approved work sends it back on your line, the lead is told so, and your words reach the maker", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [designer, writer] = h.createBots({ name: "设计师", duties: "海报和视觉；拆活、派活、审稿" }, { name: "文案", duties: "写宣传语" });
  const room = h.group("海报组", [designer!, writer!]);
  confirmGroupLead(h.store, room, designer!.id);
  const ticketId = (title: string) => h.store.db.query<{ id: string }, [string]>("SELECT id FROM tickets WHERE title = ?").get(title)?.id ?? null;
  const dirOf = (title: string) => h.store.db.query<{ dir: string }, [string]>("SELECT dir FROM tickets WHERE title = ?").get(title)!.dir;
  // The reader takes the line as an objection; every other line, as nothing in particular.
  h.judge("read_user_line").handle(({ payload }) => ({ control: "none", control_only: false, status_only: false,
    objections: JSON.stringify(payload ?? "").includes("第三句") ? ["第三句不好，换一句"] : [] }));
  // And where a line belongs (ADR 0057): about the poster job, the one there is.
  h.judge("read_filing").handle(fileUnder());
  const stop = call(tool("end_turn", { reason: "nothing_new" }));
  let laidOut = false;
  let reviewed = false;
  h.script(designer!).handle(({ turn, hop }) => {
    if (!laidOut && hop === 1) return call(tool("plan_items", { items: [{ title: "三句宣传语", owner: "文案", reviewer: "设计师" }, { title: "竖版海报", owner: "设计师", depends_on: ["三句宣传语"] }] }));
    if (!laidOut) {
      laidOut = true;
      return call(tool("delegate", { to: "文案", ask: "写三句宣传语", expects: "deliverable", ticket: ticketId("三句宣传语")! }));
    }
    if (turn?.ticket_id === ticketId("三句宣传语") && !reviewed && hop === 1) {
      reviewed = true;
      return call(tool("review", { outcome: "approve", verdicts: [], note: "三句都不超过 12 个字。" }));
    }
    return stop;
  });
  let writerTurns = 0;
  h.script(writer!).handle(({ hop }) => {
    if (hop === 1) writerTurns++;
    if (writerTurns > 2 || hop > 2) return stop;
    return hop === 1 ? call(writeFile(`${dirOf("三句宣传语")}/slogans.md`, writerTurns === 1 ? "1. 一杯好咖啡\n2. 新店开张\n3. 慢下来\n" : "1. 一杯好咖啡\n2. 新店开张\n3. 今天第一杯\n"))
      : call(tool("submit", { artifacts: [`${dirOf("三句宣传语")}/slogans.md`] }));
  });
  h.postUser(room, "做一张咖啡店开业海报，竖版，配三句宣传语");
  await h.waitIdle({ timeoutMs: 15_000 });
  h.engine.control(h.messages(room).find((message) => message.control?.kind === "review_item")!.id, { action: "approve" });
  await h.waitIdle({ timeoutMs: 15_000 });

  const complaint = h.postUser(room, "第三句不好，换一句");
  await h.waitIdle({ timeoutMs: 15_000 });

  // No card asks you: your line says it went back, with an undo.
  expect(h.messages(room).filter((message) => message.kind === "system" && message.control?.kind === "rework")).toEqual([]);
  expect(h.store.getMessage(complaint.id).control).toMatchObject({ kind: "rework", offer: ["undo"],
    result: "已转回返工：做一张咖啡店开业海报，竖版，配三句宣传语 的任务 02「三句宣传语」。" });
  // The lead took the line too, told it sent the slogans back, with the job's tickets as they are.
  const leadTurn = h.turns(designer!).find((turn) => turn.trigger_message_id === complaint.id)!;
  const seen = requestText(h.hops(designer!).find((hop) => hop.turnId === leadTurn.id && hop.hop === 1)!.request);
  expect(seen).toContain("（应用）叫醒这一轮的那句话读成了对已交出的 02「三句宣传语」的意见，已经转回返工：应用已带着这句话告诉做它的 Bot。别另派人改它。");
  expect(seen).toContain("- 02 三句宣传语（返工；文案在做；");
  expect(seen).not.toContain("01 做一张咖啡店开业海报");

  const rework = h.turns(writer!).at(-1)!;
  expect(h.store.getMessage(rework.trigger_message_id).body).toBe("（应用）用户把任务「三句宣传语」转回返工了，用户说：「第三句不好，换一句」。按这个改好再交。");
});
