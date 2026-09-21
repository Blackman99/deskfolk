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
