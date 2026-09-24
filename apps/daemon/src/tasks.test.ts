import { describe, expect, test } from "bun:test";
import { INTERRUPT_NOTE_BODY } from "@real-bot/protocol";
import { Store } from "./store";
import { isReservedTaskPath, TASK_QUIET_MS, taskDirName } from "./store/tasks";

function fixture() {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  return { store, bot: writer.bot, session: writer.direct_session };
}

/** Ages a work dir and everything that has touched it, so the next turn sees a quiet one. */
function backdate(store: Store, taskId: string, ms: number): void {
  const then = new Date(Date.now() - ms).toISOString();
  store.db.run(`UPDATE tasks SET created_at = ? WHERE id = ?`, [then, taskId]);
  store.db.run(`UPDATE turns SET last_activity_at = ? WHERE task_id = ?`, [then, taskId]);
}

describe("work dir naming", () => {
  const at = new Date(2026, 8, 21, 14, 30);

  test("dates the folder, keeps CJK, and ends with the id suffix", () => {
    const dir = taskDirName({ title: "导出季度报表", id: "01K5XQ7F3KZZZZZZZZZZZZ7F3K", at });
    expect(dir).toBe("work/2026-09-21-导出季度报表-7f3k");
  });

  test("collapses whitespace, drops what a path cannot hold, and clips to the budget", () => {
    // The budget is 12 code points, which is a sentence in Chinese and about two words in English.
    const dir = taskDirName({ title: "fix  the a/b?c test", id: "0000000000000000000000ABCD", at });
    expect(dir).toBe("work/2026-09-21-fix-the-a-b-abcd");
  });

  test("never produces a hidden or traversing segment", () => {
    const dir = taskDirName({ title: "../../etc/passwd", id: "0000000000000000000000ABCD", at });
    expect(dir).toBe("work/2026-09-21-etc-passwd-abcd");
  });

  test("an empty title still yields a usable folder", () => {
    const dir = taskDirName({ title: "   ", id: "0000000000000000000000ABCD", at });
    expect(dir).toBe("work/2026-09-21-abcd");
  });
});

describe("reserved subdirs", () => {
  const dir = "work/2026-09-21-x-7f3k";

  test("the daemon's spill and the Bot's scratch are never artifacts", () => {
    expect(isReservedTaskPath(dir, `${dir}/tool-results/01J.json`)).toBe(true);
    expect(isReservedTaskPath(dir, `${dir}/scratch/probe.py`)).toBe(true);
  });

  test("everything else in the work dir still is", () => {
    expect(isReservedTaskPath(dir, `${dir}/report.md`)).toBe(false);
    expect(isReservedTaskPath(dir, `${dir}/charts/q3.png`)).toBe(false);
    // A same-named folder that is not this work dir's is somebody else's file.
    expect(isReservedTaskPath(dir, "scratch/notes.md")).toBe(false);
    expect(isReservedTaskPath(dir, `${dir}-other/scratch/notes.md`)).toBe(false);
  });
});

describe("work dirs", () => {
  test("a user message opens one, and its trigger carries the anchor", () => {
    const { store, bot, session } = fixture();
    const trigger = store.postMessage(session.id, { body: "导出季度报表，数据在 inbox 里" });
    const turn = store.createTurn({
      sessionId: session.id,
      botId: bot.id,
      triggerMessageId: trigger.id,
    });
    expect(turn.task_id).toBeString();
    const task = store.getTask(turn.task_id!);
    expect(task.dir.startsWith("work/")).toBe(true);
    expect(task.dir).toContain("导出季度报表");
    expect(task.title).toBe("导出季度报表，数据在 inbox 里");
    expect(task.closed_at).toBeNull();
    // The user's own message belongs to the job it opened, so the entry has an anchor there too.
    expect(store.getMessage(trigger.id).task_id).toBe(turn.task_id!);
    store.close();
  });

  test("a follow-up joins the open one", () => {
    const { store, bot, session } = fixture();
    const first = store.postMessage(session.id, { body: "导出季度报表" });
    const one = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });
    const second = store.postMessage(session.id, { body: "第三季度那张图再大一点" });
    const two = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: second.id });
    expect(two.task_id).toBe(one.task_id!);
    store.close();
  });

  test("a quiet gap opens a new one and closes the old", () => {
    const { store, bot, session } = fixture();
    const first = store.postMessage(session.id, { body: "导出季度报表" });
    const one = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });
    backdate(store, one.task_id!, TASK_QUIET_MS + 60_000);

    const second = store.postMessage(session.id, { body: "帮我订个会议室" });
    const two = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: second.id });
    expect(two.task_id).not.toBe(one.task_id!);
    expect(store.getTask(one.task_id!).closed_at).toBeString();
    expect(store.getTask(two.task_id!).closed_at).toBeNull();
    store.close();
  });

  test("a session holds at most one open work dir", () => {
    const { store, session } = fixture();
    store.openTask({ sessionId: session.id, title: "第一件事" });
    store.openTask({ sessionId: session.id, title: "第二件事" });
    const open = store.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM tasks WHERE session_id = ? AND closed_at IS NULL`,
      )
      .get(session.id);
    expect(open?.n).toBe(1);
    store.close();
  });

  test("two same-day jobs with the same opening words get different folders", () => {
    const { store, session } = fixture();
    const one = store.openTask({ sessionId: session.id, title: "导出季度报表" });
    const two = store.openTask({ sessionId: session.id, title: "导出季度报表" });
    expect(two.dir).not.toBe(one.dir);
    store.close();
  });
});

describe("work dirs follow the work", () => {
  test("a handoff inherits the waking turn's dir, across sessions", () => {
    const { store, bot, session } = fixture();
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });

    const trigger = store.postMessage(session.id, { body: "导出季度报表" });
    const first = store.createTurn({
      sessionId: session.id,
      botId: bot.id,
      triggerMessageId: trigger.id,
    });

    // What a handoff actually looks like: a message some turn produced, landing where the next
    // Bot will be woken. The dir rides on the message's turn, not on the session.
    const handoff = store.insertMessage({
      sessionId: reviewer.direct_session.id,
      turnId: first.id,
      kind: "bot",
      author: bot.id,
      body: "@Reviewer 初稿在 work/... 里了",
    });
    expect(handoff.task_id).toBe(first.task_id!);

    const second = store.createTurn({
      sessionId: reviewer.direct_session.id,
      botId: reviewer.bot.id,
      triggerMessageId: handoff.id,
    });
    expect(second.task_id).toBe(first.task_id!);
    store.close();
  });

  test("a routine fire opens a new dir even inside the quiet window", () => {
    const { store, bot, session } = fixture();
    const first = store.postMessage(session.id, { body: "导出季度报表" });
    const one = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });

    const fired = store.insertMessage({
      sessionId: session.id,
      kind: "user",
      author: "user",
      body: "每天早上把昨天的数据汇总一次",
    });
    const two = store.createTurn({
      sessionId: session.id,
      botId: bot.id,
      triggerMessageId: fired.id,
      newTask: true,
    });
    expect(two.task_id).not.toBe(one.task_id!);
    store.close();
  });

  test("deleting a group drops its own dirs and unhooks the one a handoff carried away", () => {
    const { store, bot, session } = fixture();
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
    const group = store.createGroup({ name: "Brief", members: [bot.id, reviewer.bot.id] });

    const ownTrigger = store.postMessage(group.id, { body: "只在群里做完的一件事" });
    const own = store.createTurn({
      sessionId: group.id,
      botId: bot.id,
      triggerMessageId: ownTrigger.id,
    });

    // A second job in the same group, this one handed off into the you↔Reviewer direct.
    const secondTrigger = store.postMessage(group.id, { body: "另一件事，做完交给 Reviewer" });
    const carrier = store.createTurn({
      sessionId: group.id,
      botId: bot.id,
      triggerMessageId: secondTrigger.id,
      newTask: true,
    });
    expect(carrier.task_id).not.toBe(own.task_id!);
    const handoff = store.insertMessage({
      sessionId: reviewer.direct_session.id,
      turnId: carrier.id,
      kind: "bot",
      author: bot.id,
      body: "接着看一下",
    });
    const elsewhere = store.createTurn({
      sessionId: reviewer.direct_session.id,
      botId: reviewer.bot.id,
      triggerMessageId: handoff.id,
    });
    expect(elsewhere.task_id).toBe(carrier.task_id!);

    store.deleteSession(group.id);
    expect(() => store.getTask(own.task_id!)).toThrow();
    expect(store.getTask(carrier.task_id!).session_id).toBeNull();
    store.close();
  });

  test("clearing history closes the dirs that session held", () => {
    const { store, bot, session } = fixture();
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
    const trigger = store.postMessage(session.id, { body: "导出季度报表" });
    const turn = store.createTurn({
      sessionId: session.id,
      botId: bot.id,
      triggerMessageId: trigger.id,
    });
    // Something outside survives the clear, so the row stays and only its state changes.
    store.insertMessage({
      sessionId: reviewer.direct_session.id,
      turnId: turn.id,
      kind: "bot",
      author: bot.id,
      body: "初稿好了",
    });

    store.clearSessionMessages(session.id);
    expect(store.getTask(turn.task_id!).closed_at).toBeString();
    store.close();
  });

  test("continuing an interrupted turn stays in the same dir", () => {
    const { store, bot, session } = fixture();
    const trigger = store.postMessage(session.id, { body: "导出季度报表" });
    const cut = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id });
    store.interruptRunningTurns();

    const note = store
      .listMainMessages(session.id, 40)
      .find((m) => m.kind === "system" && m.body === INTERRUPT_NOTE_BODY);
    expect(note?.task_id).toBe(cut.task_id!);

    const resumed = store.claimInterruptContinue(note!.id);
    expect(resumed.task_id).toBe(cut.task_id!);
    store.close();
  });
});

describe("what a work dir's entry lists", () => {
  test("the union of what this job's messages cited, newest first", () => {
    const { store, bot, session } = fixture();
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
    const trigger = store.postMessage(session.id, { body: "导出季度报表" });
    const first = store.createTurn({
      sessionId: session.id,
      botId: bot.id,
      triggerMessageId: trigger.id,
    });
    const dir = store.getTask(first.task_id!).dir;

    store.insertMessage({
      sessionId: session.id,
      turnId: first.id,
      kind: "bot",
      author: bot.id,
      body: "初稿",
      paths: [`${dir}/data.csv`, "report.md"],
    });
    // A later turn in the same job, after a handoff into another session.
    const handoff = store.insertMessage({
      sessionId: reviewer.direct_session.id,
      turnId: first.id,
      kind: "bot",
      author: bot.id,
      body: "接着看",
      paths: [`${dir}/charts/q3.png`],
    });
    const second = store.createTurn({
      sessionId: reviewer.direct_session.id,
      botId: reviewer.bot.id,
      triggerMessageId: handoff.id,
    });
    store.insertMessage({
      sessionId: reviewer.direct_session.id,
      turnId: second.id,
      kind: "bot",
      author: reviewer.bot.id,
      body: "改了图",
      paths: [`${dir}/charts/q3.png`],
    });

    const listed = store.taskArtifacts(first.task_id!);
    // One row per path however many messages cited it, and the work dir is not the filter:
    // `report.md` lives outside it and still belongs to this job.
    expect(listed.map((row) => row.path).sort()).toEqual(
      [`${dir}/charts/q3.png`, `${dir}/data.csv`, "report.md"].sort(),
    );
    expect(listed[0]!.path).toBe(`${dir}/charts/q3.png`);
    store.close();
  });

  test("another job's files are not in it", () => {
    const { store, bot, session } = fixture();
    const first = store.postMessage(session.id, { body: "第一件事" });
    const one = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });
    store.insertMessage({
      sessionId: session.id,
      turnId: one.id,
      kind: "bot",
      author: bot.id,
      body: "好了",
      paths: ["a.md"],
    });
    const second = store.postMessage(session.id, { body: "第二件事" });
    const two = store.createTurn({
      sessionId: session.id,
      botId: bot.id,
      triggerMessageId: second.id,
      newTask: true,
    });
    store.insertMessage({
      sessionId: session.id,
      turnId: two.id,
      kind: "bot",
      author: bot.id,
      body: "也好了",
      paths: ["b.md"],
    });

    expect(store.taskArtifacts(one.task_id!).map((r) => r.path)).toEqual(["a.md"]);
    expect(store.taskArtifacts(two.task_id!).map((r) => r.path)).toEqual(["b.md"]);
    store.close();
  });
});

describe("a job's trace", () => {
  test("your message is a card, and the turn it woke hangs off it with the files it handed over", () => {
    const { store, bot, session } = fixture();
    const trigger = store.postMessage(session.id, { body: "导出季度报表" });
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id });
    const dir = store.getTask(turn.task_id!).dir;
    const said = store.insertMessage({
      sessionId: session.id,
      turnId: turn.id,
      kind: "bot",
      author: bot.id,
      body: "初稿在这里",
      paths: [`${dir}/data.csv`],
    });
    store.setTurnStatus(turn.id, "completed");

    const trace = store.taskTrace(turn.task_id!);
    expect(trace.title).toBe("导出季度报表");
    expect(trace.nodes.map((node) => node.actor)).toEqual(["user", bot.id]);
    const yours = trace.nodes[0]!;
    const theirs = trace.nodes[1]!;
    expect(yours.summary).toBe("导出季度报表");
    expect(yours.focus_message_id).toBe(trigger.id);
    expect(theirs.woken_by_turn_id).toBe(yours.turn_id);
    expect(theirs.summary).toBe("初稿在这里");
    store.insertMessage({
      sessionId: session.id,
      turnId: turn.id,
      kind: "bot",
      author: bot.id,
      body: "改好了 [报表](work/2026-09-22-导出季度报表-x/data.csv)",
    });
    expect(store.taskTrace(turn.task_id!).nodes[1]!.summary).toBe("改好了 报表");
    expect(theirs.focus_message_id).toBe(said.id);
    expect(theirs.artifacts.map((file) => file.path)).toEqual([`${dir}/data.csv`]);
    expect(theirs.artifacts[0]!.message_id).toBe(said.id);
    store.close();
  });

  test("a handoff into another session stays on the same picture, and so does a Bot↔Bot direct", () => {
    const { store, bot, session } = fixture();
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
    const group = store.createGroup({ name: "制作组", members: [bot.id, reviewer.bot.id] });
    const trigger = store.postMessage(group.id, { body: "先出分镜" });
    const producer = store.createTurn({ sessionId: group.id, botId: bot.id, triggerMessageId: trigger.id });
    const handoff = store.insertMessage({
      sessionId: group.id,
      turnId: producer.id,
      kind: "bot",
      author: bot.id,
      body: "@Reviewer 接着画",
    });
    const drawn = store.createTurn({
      sessionId: group.id,
      botId: reviewer.bot.id,
      triggerMessageId: handoff.id,
    });
    const direct = store.createBotDirect(bot.id, reviewer.bot.id, { sessionId: group.id, messageId: handoff.id });
    const aside = store.insertMessage({
      sessionId: direct.id,
      turnId: drawn.id,
      kind: "bot",
      author: reviewer.bot.id,
      body: "私聊里对一下",
      paths: ["storyboard.pdf"],
    });
    const quiet = store.createTurn({
      sessionId: direct.id,
      botId: bot.id,
      triggerMessageId: aside.id,
    });

    const trace = store.taskTrace(producer.task_id!);
    expect(trace.nodes.map((node) => [node.actor, node.session_id])).toEqual([
      ["user", group.id],
      [bot.id, group.id],
      [reviewer.bot.id, group.id],
      [bot.id, direct.id],
    ]);
    const board = trace.nodes[2]!;
    expect(board.woken_by_turn_id).toBe(producer.id);
    expect(board.artifacts.map((file) => file.path)).toEqual(["storyboard.pdf"]);
    expect(trace.nodes[3]!.woken_by_turn_id).toBe(drawn.id);
    expect(quiet.task_id).toBe(producer.task_id);
    store.close();
  });

  test("a redirect, a fork and a continued interrupt each keep their own card", () => {
    const { store, bot, session } = fixture();
    const first = store.postMessage(session.id, { body: "先写大纲" });
    const original = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });
    store.redirectTurn(original.id);
    const second = store.postMessage(session.id, { body: "改成表格" });
    const redirected = store.createTurn({
      sessionId: session.id,
      botId: bot.id,
      triggerMessageId: second.id,
    });
    const third = store.postMessage(session.id, { body: "另外再开一轮" });
    const fork = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: third.id });
    store.setTurnStatus(fork.id, "completed");

    store.interruptRunningTurns();
    const note = store
      .listMainMessages(session.id, 40)
      .find((message) => message.kind === "system" && message.body === INTERRUPT_NOTE_BODY && message.turn_id === redirected.id);
    const resumed = store.claimInterruptContinue(note!.id);

    const trace = store.taskTrace(original.task_id!);
    const cards = trace.nodes.filter((node) => node.actor === bot.id);
    expect(cards.map((node) => node.status)).toEqual(["redirected", "interrupted", "completed", "running"]);
    expect(cards[1]!.woken_by_turn_id).toBe(trace.nodes.find((node) => node.focus_message_id === second.id && node.actor === "user")!.turn_id);
    expect(cards[1]!.focus_message_id).toBe(note!.id);
    expect(cards[2]!.turn_id).toBe(fork.id);
    expect(cards[3]!.turn_id).toBe(resumed.id);
    expect(cards[3]!.woken_by_turn_id).toBe(redirected.id);
    store.close();
  });

  test("a running turn shows what it is saying, and a waiting one shows the question or the approval", () => {
    const { store, bot, session } = fixture();
    const trigger = store.postMessage(session.id, { body: "导出季度报表" });
    const running = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id });
    store.setTurnPartial(running.id, "正在汇总第三季度");
    const spoken = store.insertMessage({
      sessionId: session.id,
      turnId: running.id,
      kind: "bot",
      author: bot.id,
      body: "还没写完的一句",
    });

    const live = store.taskTrace(running.task_id!);
    expect(live.nodes[1]!.summary).toBe("正在汇总第三季度");
    expect(live.nodes[1]!.focus_message_id).toBe(spoken.id);

    const ask = store.insertMessage({
      sessionId: session.id,
      turnId: running.id,
      kind: "ask",
      author: bot.id,
      body: "要不要把去年的也放进去？",
    });
    store.setTurnStatus(running.id, "waiting_ask");
    const asking = store.taskTrace(running.task_id!);
    expect(asking.nodes[1]!.ask).toEqual({ message_id: ask.id, question: "要不要把去年的也放进去？" });
    expect(asking.nodes[1]!.focus_message_id).toBe(ask.id);
    expect(asking.nodes[1]!.summary).toBe("还没写完的一句");

    const approval = store.insertApproval({
      turnId: running.id,
      messageId: spoken.id,
      kind_key: "outside-write",
      summary: "写入工作区外的报表",
      target: "/tmp/out.csv",
    });
    store.setTurnStatus(running.id, "waiting_approval");
    const waiting = store.taskTrace(running.task_id!);
    expect(waiting.nodes[1]!.approval).toEqual({ message_id: spoken.id, summary: "写入工作区外的报表" });
    expect(waiting.nodes[1]!.ask).toBeNull();
    expect(approval.status).toBe("pending");
    store.close();
  });

  test("watchers are counted on the card that woke them, and a quiet gap splits the picture", () => {
    const { store, bot, session } = fixture();
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
    const group = store.createGroup({ name: "制作组", members: [bot.id, reviewer.bot.id] });
    const trigger = store.postMessage(group.id, { body: "谁来做" });
    store.insertJudgement({ sessionId: group.id, messageId: trigger.id, botId: reviewer.bot.id, decision: "pass" });
    const turn = store.createTurn({ sessionId: group.id, botId: bot.id, triggerMessageId: trigger.id });

    const trace = store.taskTrace(turn.task_id!);
    expect(trace.nodes[0]!.passed).toBe(1);
    expect(trace.nodes[1]!.passed).toBe(0);

    backdate(store, turn.task_id!, TASK_QUIET_MS + 60_000);
    const later = store.postMessage(group.id, { body: "换一件事" });
    const next = store.createTurn({ sessionId: group.id, botId: bot.id, triggerMessageId: later.id });
    expect(store.taskTrace(turn.task_id!).nodes.map((node) => node.trigger_message_id)).toEqual([trigger.id, trigger.id]);
    expect(store.taskTrace(next.task_id!).nodes.map((node) => node.summary)).toEqual(["换一件事", "换一件事"]);
    store.close();
  });

  test("the switcher lists the jobs a session touched, newest first, including one opened elsewhere", () => {
    const { store, bot, session } = fixture();
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
    const first = store.postMessage(session.id, { body: "第一件事" });
    const one = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });
    const second = store.postMessage(session.id, { body: "第二件事" });
    const two = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: second.id, newTask: true });
    const carried = store.insertMessage({
      sessionId: reviewer.direct_session.id,
      turnId: one.id,
      kind: "bot",
      author: bot.id,
      body: "你也看看",
    });
    store.createTurn({ sessionId: reviewer.direct_session.id, botId: reviewer.bot.id, triggerMessageId: carried.id });

    // The handoff woke a turn on the first job after the second one opened, so it is the recent one.
    expect(store.sessionTasks(session.id).map((row) => row.id)).toEqual([one.task_id!, two.task_id!]);
    expect(store.sessionTasks(reviewer.direct_session.id).map((row) => row.id)).toEqual([one.task_id!]);
    store.close();
  });

  test("a summary stops at one line", () => {
    const { store, bot, session } = fixture();
    const trigger = store.postMessage(session.id, { body: `第一行\n${"很".repeat(120)}` });
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id });
    const yours = store.taskTrace(turn.task_id!).nodes[0]!;
    expect(yours.summary.startsWith("第一行 很")).toBe(true);
    expect([...yours.summary].length).toBe(81);
    expect(yours.summary.endsWith("…")).toBe(true);
    store.close();
  });
});
