/**
 * Submissions and reviews in the engine (ADR 0046, engine level 5): the implicit submission at a
 * segment's end, `submit` with its checks run at once, `review` and what it wakes, and the
 * supervisor's no-reviewer approval from the scheduler's tick.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, createScenario, say, tool, writeFile, type Scenario, type ToolOutcome } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options: Parameters<typeof createScenario>[0] = { submissions: true }) {
  const h = await createScenario(options);
  open.push(h);
  return h;
}

/** A plan in a group with a maker and a reviewer, and the ticket the maker is on. */
function job(h: Scenario) {
  const [maker, reviewer] = h.createBots("Maker", "Checker");
  const room = h.group("Studio", [maker!, reviewer!]);
  const plan = h.store.openTask({ sessionId: room, title: "EP01" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "Storyboard", status: "doing", worker: maker!.id });
  return { maker: maker!, reviewer: reviewer!, room, plan, ticket };
}

/** Your line asking the maker for the ticket's work, filed under it, and the maker's segment it starts. */
async function ask(h: Scenario, j: ReturnType<typeof job>, body = "@Maker 出分镜") {
  const line = h.store.postMessage(j.room, { body });
  h.store.fileMessage(line.id, { explicit: [{ taskId: j.plan.id, ticketId: j.ticket.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
}

const stageOf = (h: Scenario, ticketId: string) => h.store.db.query<{ stage: string | null; status: string }, [string]>(
  "SELECT stage, status FROM tickets WHERE id = ?").get(ticketId)!;

test("a closing reply that hands a file of the ticket over is an implicit submission; with no reviewer and no active gate, it waits on your approve/reject card", async () => {
  const h = await scenario();
  const j = job(h);
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "# 分镜\n1. 雪原")), say("分镜好了"));
  await ask(h, j);

  const [submission] = h.store.listSubmissions({ taskId: j.plan.id });
  expect(submission).toMatchObject({ origin: "implicit", state: "submitted", bot_id: j.maker.id,
    artifacts: [{ path: `${j.ticket.dir}/board.md` }] });
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "submitted", status: "review" });
  // Cited once: the closing reply is the line that carries it.
  const carrying = h.messages(j.room).filter((message) => message.attachments?.some((attachment) => attachment.workspace_relpath === `${j.ticket.dir}/board.md`));
  expect(carrying.map((message) => message.body)).toEqual([expect.stringContaining("分镜好了")]);
  // The work waits idle, not closed: a review could still send it back.
  expect(h.store.db.query("SELECT state FROM work_items WHERE bot_id = ? AND ticket_id = ?").get(j.maker.id, j.ticket.id)).toEqual({ state: "idle" });

  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  // Nothing active backs this hand-over, so it is never approved on nothing at all: the same card as an answer's or an organizer's, showing the files to open and look.
  expect(h.store.getSubmission(submission!.id)).toMatchObject({ state: "submitted", awaiting: { kind: "approval" } });
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "submitted", status: "review" });
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item")!;
  expect(card.control).toMatchObject({ offer: ["approve", "reject"] });
  // Its words name the file; the file itself is on the card, to open.
  expect(card.body).toContain("board.md");
  expect(card.attachments.map((attachment) => attachment.workspace_relpath)).toContain(`${j.ticket.dir}/board.md`);
  h.engine.control(card.id, { action: "approve" });
  await h.waitIdle();
  expect(h.store.getSubmission(submission!.id).state).toBe("approved");
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
  expect(h.store.getTask(j.plan.id)).toMatchObject({ stage: "delivered", status: "done" });
  // The same bytes handed over again are not a new submission.
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toHaveLength(1);
});

test("a file hand-over with no reviewer still auto-approves when an active gate backs it and it passes", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.createCheckByUser(j.plan.id, { item: "分镜文件存在", kind: "exists", path: `${j.ticket.dir}/board.md`, ticket_id: j.ticket.id });
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "# 分镜\n1. 雪原")), say("分镜好了"));
  await ask(h, j);
  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  const [submission] = h.store.listSubmissions({ taskId: j.plan.id });
  expect(submission).toMatchObject({ state: "approved" });
  expect(h.messages(j.room).some((message) => message.control?.kind === "review_item")).toBe(false);
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
});

test("end_turn(done) hands the new files over first, so the ticket is no longer the maker's obligation", async () => {
  const h = await scenario();
  const j = job(h);
  const results: ToolOutcome[] = [];
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "# 分镜")), call(tool("end_turn", { reason: "done" })), ({ results: got }) => {
    results.push(...got);
    return say("不该走到这里");
  });
  await ask(h, j);
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ origin: "implicit", state: "submitted" }]);
  expect(h.store.db.query("SELECT end_reason FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1").get(j.maker.id)).toEqual({ end_reason: "done" });
  expect(results).toEqual([]);
  // The file went out on one line of the maker's, not two.
  expect(h.messages(j.room).filter((message) => (message.attachments ?? []).length > 0)).toHaveLength(1);
});

test("submit runs the ticket's checks at once: a failing one comes back with its details and the ticket does not move", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.createCheckByUser(j.plan.id, { item: "分镜写到第 3 镜", kind: "contains", path: `${j.ticket.dir}/board.md`, pattern: "3. 灯", ticket_id: j.ticket.id });
  const results: ToolOutcome[] = [];
  h.script(j.maker).reply(
    call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原")),
    call(tool("submit", { artifacts: ["board.md"] })),
    ({ results: got }) => {
      results.push(...got);
      return call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原\n2. 塔\n3. 灯"));
    },
    call(tool("submit", { artifacts: ["board.md"] })),
    say("不该走到这里：交上去就结束了本段"),
  );
  await ask(h, j);
  expect(results.map(({ name, ok }) => ({ name, ok }))).toEqual([{ name: "submit", ok: false }]);
  expect(results[0]!.content).toContain("checks_failed");
  expect(results[0]!.content).toContain("分镜写到第 3 镜");
  // The passing submit ended the segment: no further hop, its work idle.
  expect(h.messages(j.room).some((message) => message.body.includes("不该走到这里"))).toBe(false);
  expect(h.store.db.query("SELECT end_reason FROM turns WHERE bot_id = ?").all(j.maker.id)).toEqual([{ end_reason: "done" }]);
  expect(h.store.listSubmissions({ taskId: j.plan.id }).map((row) => [row.origin, row.state])).toEqual([["submit", "submitted"], ["submit", "checks_failed"]]);
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "submitted", status: "review" });
});

test("a reviewer set on the ticket is woken to review; a rejection wakes the maker back to rework with its note", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.patchTicketByUser(j.ticket.id, { reviewerBotId: j.reviewer.id });
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原")), call(tool("submit", { artifacts: ["board.md"] })));
  let reviewerHeard = "";
  h.script(j.reviewer).reply(({ request }) => {
    reviewerHeard = request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    return call(tool("review", { outcome: "reject", note: "少了第 2、3 镜", verdicts: [] }));
  }, call(tool("end_turn", { reason: "done" })));
  let makerHeard = "";
  h.script(j.maker).reply(({ request }) => {
    makerHeard = request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    return call(tool("end_turn", { reason: "nothing_new" }));
  });
  await ask(h, j);

  expect(reviewerHeard).toContain("请审查任务 01「Storyboard」");
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ state: "rejected", reviews: [{ outcome: "reject", reviewer_bot_id: j.reviewer.id }] }]);
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "rework", status: "doing" });
  expect(makerHeard).toContain("少了第 2、3 镜");
  // Its situation names the stage, not the status it reads as.
  expect(makerHeard).toContain("本轮任务：01 Storyboard（返工）");
  expect(h.turns(j.maker)).toHaveLength(2);
});

test("a picture read with read_file is kept as the evidence a visual pass needs", async () => {
  const h = await scenario();
  const j = job(h);
  writeFileSync(join(h.root, "frame.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  h.script(j.maker).reply(call(tool("read_file", { path: "frame.png" })), call(tool("end_turn", { reason: "nothing_new" })));
  await ask(h, j);
  expect(h.store.db.query("SELECT json_extract(payload, '$.path') AS path FROM work_events WHERE kind = 'artifact.viewed'").all()).toEqual([{ path: "frame.png" }]);
  // Not a command it ran: a picture looked at proves no test.
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM turn_runs").get()).toEqual({ n: 0 });
});

test("below level 5 there are no submissions: a hand-over the app sees moves the status as before", async () => {
  const h = await scenario({ supervision: true });
  const j = job(h);
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原")), say("分镜好了"));
  await ask(h, j);
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toEqual([]);
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: null, status: "review" });
});

for (const outcome of ["reject", "none"] as const) {
  test(`the reviewer's notes in the ticket's folder are no hand-over (after ${outcome === "reject" ? "rejecting" : "saying so in words"})`, async () => {
    const h = await scenario();
    const j = job(h);
    h.store.patchTicketByUser(j.ticket.id, { reviewerBotId: j.reviewer.id });
    h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原")), call(tool("submit", { artifacts: ["board.md"] })));
    h.script(j.reviewer).reply(...(outcome === "reject"
      ? [call(tool("review", { outcome: "reject", note: "少了第 2、3 镜" })), call(writeFile(`${j.ticket.dir}/review-notes.md`, "第 2、3 镜缺失")),
        call(tool("end_turn", { reason: "done" }))]
      : [call(writeFile(`${j.ticket.dir}/review-notes.md`, "看过了，第 2、3 镜缺失")), say(`审查意见写在 ${j.ticket.dir}/review-notes.md`)]));
    h.script(j.maker).reply(call(tool("end_turn", { reason: "nothing_new" })), call(tool("end_turn", { reason: "nothing_new" })));
    await ask(h, j);
    h.tick(new Date(Date.now() + 20_000));
    await h.waitIdle();
    const submissions = h.store.listSubmissions({ taskId: j.plan.id });
    expect(submissions.map((row) => row.bot_id)).toEqual([j.maker.id]);
    expect(submissions[0]!.state).toBe(outcome === "reject" ? "rejected" : "in_review");
    expect(stageOf(h, j.ticket.id).stage).toBe(outcome === "reject" ? "rework" : "in_review");
  }, 30_000);
}

test("a closing reply whose hand-over fails its checks hears why, and the ticket does not move", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.createCheckByUser(j.plan.id, { item: "分镜写到第 3 镜", kind: "contains", path: `${j.ticket.dir}/board.md`, pattern: "3. 灯", ticket_id: j.ticket.id });
  let heard = "";
  // The closing check's one look comes first; the second closing reply hands the file over.
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原")), say("分镜好了"), say("分镜好了，先这样"), ({ request }) => {
    heard = String(request.messages.at(-1)?.content ?? "");
    return call(tool("end_turn", { reason: "blocked", needs_from_user: "第 3 镜写什么？" }));
  });
  await ask(h, j);
  expect(h.store.listSubmissions({ taskId: j.plan.id }).map((row) => row.state)).toEqual(["checks_failed"]);
  expect(stageOf(h, j.ticket.id).status).toBe("doing");
  expect(heard).toContain("你交出的东西没过检查");
  expect(heard).toContain("分镜写到第 3 镜");
});

test("a card's 确认 on the check runs it as a gate and takes the hand-over up again; its pass approves", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.patchTicketByUser(j.ticket.id, { reviewerBotId: j.reviewer.id });
  const line = h.store.postMessage(j.room, { body: "分镜要写到第 3 镜" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: j.plan.id }] });
  const quote = h.store.listQuotes({ messageId: line.id })[0]!;
  const entry = h.store.addRequirement({ scope: "plan", scopeId: j.plan.id, quote: "分镜要写到第 3 镜", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "scribe" });
  h.store.raiseRequirement(entry.id, { quoteId: quote.id, actor: "scribe" });
  // An unconfirmed check standing on those words, the way one from your words stands.
  const check = h.store.createCheckByUser(j.plan.id, { item: "写到第 3 镜", kind: "contains", path: `${j.ticket.dir}/board.md`, pattern: "3. 灯", ticket_id: j.ticket.id });
  h.store.db.run("UPDATE acceptance_checks SET origin = 'derived', derived_state = 'proposed', bind_kind = 'glob', quote_id = ? WHERE id = ?", [quote.id, check.id]);
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原\n2. 塔")), call(tool("submit", { artifacts: ["board.md"] })));
  h.script(j.reviewer).reply(call(tool("review", { outcome: "approve", verdicts: [{ requirement_id: entry.id, verdict: "pass", evidence: ["三镜都在"] }] })),
    call(tool("end_turn", { reason: "done" })));
  await ask(h, j);
  // Both Bots run on the scenario's one model, and the unconfirmed check measured a failure: the
  // approval waits on you, and the failure held nothing back.
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ state: "in_review", checks: [{ check_id: check.id, gate: false, outcome: "fail" }] }]);
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item");
  expect(card?.control).toMatchObject({ check_ids: [check.id] });
  // The file it measures is right by the time you confirm (you fixed it yourself).
  writeFileSync(join(h.root, j.ticket.dir, "board.md"), "1. 雪原\n2. 塔\n3. 灯");
  h.engine.control(card!.id, { action: "confirm_check" });
  await h.waitIdle();
  expect(h.store.getCheck(check.id)).toMatchObject({ derived_state: "active", last_run: { outcome: "pass" } });
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ state: "approved", awaiting: null, reviews: [{ same_model: true }] }]);
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
  expect(h.store.getMessage(card!.id).control).toMatchObject({ acted: ["confirm_check"] });
});

// A real answer, with real content rather than a status line.
const THREE_TOPICS = "三个选题：一是海洋保护纪录片，聚焦珊瑚礁退化和渔业冲突；二是城市夜生活，记录年轻人深夜故事；三是乡村留守老人日常生活。";

test("a ticket whose work is words closes at level 5 via end_turn(done, answer), waiting on your approve/reject card (no reviewer)", async () => {
  const h = await scenario();
  const j = job(h);
  h.script(j.maker).reply(call(tool("end_turn", { reason: "done", answer: THREE_TOPICS })));
  await ask(h, j, "@Maker 给三个选题");
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ origin: "answer", content: THREE_TOPICS, artifacts: [], state: "submitted" }]);
  expect(h.store.db.query("SELECT end_reason FROM turns WHERE bot_id = ?").all(j.maker.id)).toEqual([{ end_reason: "done" }]);
  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  // With no reviewer, an answer is never approved on the organizer's — or its own — word alone.
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "submitted", status: "review" });
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item");
  expect(card?.control).toMatchObject({ offer: ["approve", "reject"] });
  expect(card?.body).toContain(THREE_TOPICS);
  h.engine.control(card!.id, { action: "approve" });
  await h.waitIdle();
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
  expect(h.store.getTask(j.plan.id)).toMatchObject({ status: "done", stage: "delivered" });
});

test("a plain-text closing reply never hands words over, even one that reads like a real answer — only end_turn(done, answer) does", async () => {
  const h = await scenario();
  const j = job(h);
  h.script(j.maker).reply(say(THREE_TOPICS), call(tool("end_turn", { reason: "nothing_new" })));
  await ask(h, j, "@Maker 给三个选题");
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toEqual([]);
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: null, status: "doing" });
});

test("end_turn(done, answer) is refused when the words do not read as the deliverable — a bare ack, too short", async () => {
  const h = await scenario();
  const j = job(h);
  const results: ToolOutcome[] = [];
  h.script(j.maker).reply(call(tool("end_turn", { reason: "done", answer: "母带剪好了" })), ({ results: got }) => {
    results.push(...got);
    return call(tool("end_turn", { reason: "done", answer: THREE_TOPICS }));
  });
  await ask(h, j, "@Maker 给三个选题");
  expect(results).toMatchObject([{ name: "end_turn", ok: false, content: expect.stringContaining("not_an_answer") }]);
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ origin: "answer", content: THREE_TOPICS }]);
});

test("a non-producer's end_turn(done, answer) hears only the owner hands over words, not a bare unfinished_obligations", async () => {
  const h = await scenario();
  const j = job(h);
  const [other] = h.createBots("Other");
  h.store.addMember(j.room, other!.id);
  const results: ToolOutcome[] = [];
  h.script(other!).reply(call(tool("end_turn", { reason: "done", answer: THREE_TOPICS })), ({ results: got }) => {
    results.push(...got);
    return call(tool("end_turn", { reason: "nothing_new" }));
  });
  const line = h.store.postMessage(j.room, { body: "@Other 出选题" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: j.plan.id, ticketId: j.ticket.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  expect(results).toMatchObject([{ name: "end_turn", ok: false }]);
  expect(results[0]!.content).toContain("submit");
  expect(results[0]!.content).not.toContain("unfinished_obligations");
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toEqual([]);
});

test("a closing reply that is a question or a promise hands nothing over", async () => {
  const h = await scenario();
  const j = job(h);
  h.script(j.maker).reply(say("你要几个选题？"), call(tool("end_turn", { reason: "nothing_new" })));
  await ask(h, j, "@Maker 给选题");
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toEqual([]);
});

test("a master in the plan's deliverables/ can be handed over with submit", async () => {
  const h = await scenario();
  const j = job(h);
  const results: ToolOutcome[] = [];
  h.script(j.maker).reply(call(writeFile(`${j.plan.dir}/deliverables/EP01_MASTER.mp4`, "x")),
    call(tool("submit", { artifacts: [`${j.plan.dir}/deliverables/EP01_MASTER.mp4`] })), ({ results: got }) => {
      results.push(...got);
      return call(tool("end_turn", { reason: "nothing_new" }));
    });
  await ask(h, j, "@Maker 出母带");
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ origin: "submit", artifacts: [{ path: `${j.plan.dir}/deliverables/EP01_MASTER.mp4` }] }]);
});

test("a Bot that did an owned ticket's work is told once to hand it over with submit, and then can", async () => {
  const h = await scenario();
  const [lead, owner] = h.createBots("Lead", "Owner");
  const room = h.group("Studio", [lead!, owner!]);
  const plan = h.store.openTask({ sessionId: room, title: "EP01" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "Storyboard", status: "doing", worker: owner!.id });
  let heard = "";
  h.script(lead!).reply(call(writeFile(`${ticket.dir}/board.md`, "1. 雪原")), say(`分镜在 ${ticket.dir}/board.md`), ({ request }) => {
    heard = String(request.messages.at(-1)?.content ?? "");
    return call(tool("submit", { artifacts: [`${ticket.dir}/board.md`] }));
  });
  const line = h.store.postMessage(room, { body: "@Lead 出分镜" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  expect(heard).toContain("用 submit 交出去");
  expect(h.store.listSubmissions({ taskId: plan.id })).toMatchObject([{ origin: "submit", bot_id: lead!.id }]);
});

// A Bot reviewer's clean approve of words nobody made (an answer, or an organizer's reading) must not
// approve the ticket outright, empty verdicts and all.
const PADDED_CLAIM = "母带已经剪辑完毕并导出了，整体时长和节奏都符合你的要求，可以直接拿去使用了。";

test("a same-model reviewer's clean approve of an answer still waits on your card, with its verdict shown", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.patchTicketByUser(j.ticket.id, { reviewerBotId: j.reviewer.id });
  const results: ToolOutcome[] = [];
  h.script(j.reviewer).reply(call(tool("review", { outcome: "approve", verdicts: [] })), ({ results: got }) => {
    results.push(...got);
    return call(tool("end_turn", { reason: "done" }));
  });
  h.script(j.maker).reply(call(tool("end_turn", { reason: "done", answer: PADDED_CLAIM })));
  await ask(h, j, "@Maker 交母带");
  expect(results).toMatchObject([{ name: "review", ok: false }]);
  expect(results[0]!.content).toContain("awaiting_user");
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item");
  expect(card?.control).toMatchObject({ offer: ["approve", "reject"] });
  expect(card?.body).toContain(PADDED_CLAIM);
  expect(card?.body).toContain("Checker");
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "in_review", status: "review" });
  h.engine.control(card!.id, { action: "approve" });
  await h.waitIdle();
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
});

test("organizer done with a reviewer set — its clean approve, with nothing to look at, also waits on your card", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.patchTicketByUser(j.ticket.id, { reviewerBotId: j.reviewer.id });
  let heard = "";
  h.script(j.reviewer).reply(({ request }) => {
    heard = request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    return call(tool("review", { outcome: "approve", verdicts: [] }));
  }, call(tool("end_turn", { reason: "done" })));
  const spec = { kind: "x", goal: "EP01", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" as const };
  h.store.applyOrganizerResult({ sessionId: j.room, current: h.store.getTask(j.plan.id),
    result: { decision: "continue", resumePlanId: null, spec, tickets: [{ id: j.ticket.id, spec: "", status: "done" }], messageTicket: null },
    source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  expect(heard).toContain("请审查");
  // The doubled 。 bug: the organizer's own note already ends in one.
  expect(heard).toContain("整理跳认为这张任务做完了。先看");
  expect(heard).not.toContain("做完了。。");
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item");
  expect(card?.control).toMatchObject({ offer: ["approve", "reject"] });
  expect(card?.body).not.toContain("做完了。。");
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "in_review", status: "review" });
});

// Pressing 放行 while a gate has not run yet must not read the gate as failed, nor say 已放行 for
// what was sent back.
test("pressing 放行 while a gate has not run yet waits for it, then resolves — never 已放行 for what failed", async () => {
  const h = await scenario();
  const j = job(h);
  const answer = "三个选题：雪原上的孤灯、海底的旧城、云端的列车。第一个最有画面感，建议先做它。";
  h.script(j.maker).reply(call(tool("end_turn", { reason: "done", answer })));
  await ask(h, j, "@Maker 交选题");
  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item")!;
  expect(card.control).toMatchObject({ offer: ["approve", "reject"] });
  // A gate added only after the card already waits on you: not run yet when 放行 is pressed.
  h.store.createCheckByUser(j.plan.id, { item: "选题文件存在", kind: "exists", path: `${j.ticket.dir}/topics.md`, ticket_id: j.ticket.id });
  h.engine.control(card.id, { action: "approve" });
  await h.waitIdle();
  const after = h.store.getMessage(card.id).control;
  expect(after).toMatchObject({ acted: ["reject"] });
  expect((after as { result?: string }).result).toContain("检查没过");
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "rework", status: "doing" });
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ state: "checks_failed" }]);
});

// A claim refused as an answer must not get through as a file instead: a file hand-over with no
// reviewer and no checks behind it waits on your card too.
test("a claim refused as an answer, then written to a throwaway file with no checks, still waits on your card", async () => {
  const h = await scenario();
  const j = job(h);
  const results: ToolOutcome[] = [];
  h.script(j.maker).reply(call(tool("end_turn", { reason: "done", answer: "母带剪好了" })), ({ results: got }) => {
    results.push(...got);
    return call(writeFile(`${j.ticket.dir}/status.md`, "母带剪好了"));
  }, call(tool("submit", { artifacts: ["status.md"] })));
  await ask(h, j, "@Maker 把母带剪出来");
  expect(results).toMatchObject([{ name: "end_turn", ok: false }]);
  expect(results[0]!.content).toContain("not_an_answer");
  expect(results[0]!.content).not.toContain("submit 交");
  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ origin: "submit", state: "submitted" }]);
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item");
  expect(card?.control).toMatchObject({ offer: ["approve", "reject"] });
  expect(card?.body).toContain("status.md");
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "submitted", status: "review" });
});

test("放行 pressed while a gate runs, with a passing gate added meanwhile: the card says it waits, a second 放行 is refused, and the tick resolves it", async () => {
  const h = await scenario();
  const j = job(h);
  const answer = "三个选题：雪原上的孤灯、海底的旧城、云端的列车。第一个最有画面感，建议先做它。";
  h.script(j.maker).reply(call(tool("end_turn", { reason: "done", answer })));
  await ask(h, j, "@Maker 交选题");
  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  const card = h.messages(j.room).find((message) => message.control?.kind === "review_item")!;
  mkdirSync(join(h.root, j.ticket.dir), { recursive: true });
  writeFileSync(join(h.root, j.ticket.dir, "topics.md"), answer);
  h.store.createCheckByUser(j.plan.id, { item: "选题文件存在", kind: "exists", path: `${j.ticket.dir}/topics.md`, ticket_id: j.ticket.id });
  h.engine.control(card.id, { action: "approve" });
  // Waiting on the check: only 退回 is left, the card says why, and 放行 again is refused.
  expect(h.store.getMessage(card.id).control).toMatchObject({ offer: ["reject"], result: "等检查跑完再放行…" });
  expect(() => h.engine.control(card.id, { action: "approve" })).toThrow();
  // A second gate the press never saw, added while it waits.
  h.store.createCheckByUser(j.plan.id, { item: "选题写了三个", kind: "contains", path: `${j.ticket.dir}/topics.md`, pattern: "三个选题", ticket_id: j.ticket.id });
  await h.waitIdle();
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ state: "submitted", awaiting: { kind: "approval", pending: true } }]);
  // The tick runs the gate it has not seen run, and the next one resolves the press.
  h.tick(new Date(Date.now() + 40_000));
  await h.waitIdle();
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle();
  expect(h.store.listSubmissions({ taskId: j.plan.id })).toMatchObject([{ state: "approved", awaiting: null }]);
  expect(h.store.getMessage(card.id).control).toMatchObject({ offer: [], acted: ["approve"], result: "已放行。" });
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
});

test("a card a newer hand-over or your board edit took over says so, with no buttons left", async () => {
  const h = await scenario();
  const j = job(h);
  for (const version of ["v1", "v2"]) {
    h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/cut.md`, version)), call(tool("submit", { artifacts: ["cut.md"] })));
    await ask(h, j, `@Maker 交 ${version}`);
    h.tick(new Date(Date.now() + (version === "v1" ? 20_000 : 40_000)));
    await h.waitIdle();
  }
  const [first, second] = h.messages(j.room).filter((message) => message.control?.kind === "review_item");
  expect(first!.control).toMatchObject({ offer: [], acted: [], result: "已被新的交付取代。" });
  expect(second!.control).toMatchObject({ offer: ["approve", "reject"] });
  h.store.patchTicketByUser(j.ticket.id, { status: "doing" });
  expect(h.store.getMessage(second!.id).control).toMatchObject({ offer: [], acted: [], result: "你在看板上改了这张任务的状态，这份交付作废了。" });
  expect(h.store.listSubmissions({ taskId: j.plan.id }).map((submission) => submission.state)).toEqual(["superseded", "superseded"]);
});

test("your complaint about approved work asks first; sent back, the producer is woken, and the reviewer reads its calibration record next time", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.patchTicketByUser(j.ticket.id, { reviewerBotId: j.reviewer.id });
  h.script(j.reviewer).reply(call(tool("review", { outcome: "approve", verdicts: [] })), call(tool("end_turn", { reason: "done" })));
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原\n2. 塔")), call(tool("submit", { artifacts: ["board.md"] })));
  await ask(h, j);
  const approval = h.messages(j.room).find((message) => message.control?.kind === "review_item")!;
  h.engine.control(approval.id, { action: "approve" });
  await h.waitIdle();
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });

  // The complaint: the maker reworks and hands over again; the reviewer reads its record on the review.
  let heard = "";
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原\n2. 灯塔")), call(tool("submit", { artifacts: ["board.md"] })));
  h.script(j.reviewer).reply(({ request }) => {
    heard = request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    return call(tool("end_turn", { reason: "done" }));
  });
  const line = h.store.postMessage(j.room, { body: "分镜不对，第 2 镜反了" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: j.plan.id, ticketId: j.ticket.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  const card = h.messages(j.room).find((message) => message.control?.kind === "rework")!;
  expect(card.control).toMatchObject({ ticket_id: j.ticket.id, offer: ["rework", "dismiss"] });
  // Asked, not acted on: still approved until you press.
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
  h.engine.control(card.id, { action: "rework" });
  await h.waitIdle();
  expect(h.store.getMessage(card.id).control).toMatchObject({ offer: ["undo"] });
  expect(h.store.reviewMisses({ botId: j.reviewer.id, sessionId: j.room })).toMatchObject([{ quote: expect.stringContaining("第 2 镜反了") }]);
  expect(heard).toContain("你的校准记录");
  expect(heard).toContain("第 2 镜反了");
  expect(stageOf(h, j.ticket.id).stage).toBe("in_review");
  // The work moved on (a newer hand-over): the undo is refused.
  expect(() => h.engine.control(card.id, { action: "undo" })).toThrow();
});

test("undo on a rework card puts the approval back when nothing moved since", async () => {
  const h = await scenario();
  const j = job(h);
  h.store.createCheckByUser(j.plan.id, { item: "分镜文件存在", kind: "exists", path: `${j.ticket.dir}/board.md`, ticket_id: j.ticket.id });
  h.script(j.maker).reply(call(writeFile(`${j.ticket.dir}/board.md`, "1. 雪原")), say("分镜好了"));
  await ask(h, j);
  h.tick(new Date(Date.now() + 20_000));
  await h.waitIdle();
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
  h.script(j.maker).reply(call(tool("end_turn", { reason: "done" })));
  const line = h.store.postMessage(j.room, { body: "分镜太短了" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: j.plan.id, ticketId: j.ticket.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  const card = h.messages(j.room).find((message) => message.control?.kind === "rework")!;
  h.engine.control(card.id, { action: "rework" });
  await h.waitIdle();
  expect(stageOf(h, j.ticket.id).stage).toBe("rework");
  h.engine.control(card.id, { action: "undo" });
  expect(stageOf(h, j.ticket.id)).toEqual({ stage: "approved", status: "done" });
  expect(h.store.getMessage(card.id).control).toMatchObject({ acted: ["undo"] });
});
