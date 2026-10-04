/**
 * 2026-10-02, in a direct with zz-stop-A: 「请写一篇 4000 字的中文长篇科幻小说」 was filed under the
 * only job open there, 「请用 shell 工具执行 sleep 120…」 (rule 6), and the Bot went to work on it
 * there. The attribution dialog could only move a line to a job that already existed, so a new
 * request glued to an old job could only be stopped and said again.
 *
 * 「新开一件事」 opens a job from the line and files it there: the Bot starts on it in a segment of
 * its own, and the segment still at work on the old job hears, at its next step, not to act on the
 * line there. A model reads where a line belongs now (ADR 0057), not rule 6; a reading can still
 * take a new request for the old job, and this is how you put it right.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, fileUnder, requestText, say, shell, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("a new request glued to an old job becomes a job of its own, and the old segment is told to leave it", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "zz-stop-A", duties: "测试" });
  const dm = h.direct(bot!);
  const old = openPlan(h, dm, "请用 shell 工具执行 sleep 120，执行完告诉我完成", planSpec("sleep 120"));
  h.store.createTicket({ taskId: old.id, title: "执行 sleep 120", status: "doing", worker: bot!.id });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let heard = "";
  // The old segment waits at its first step until you have moved the line; the new one just starts.
  h.script(bot!).handle(async ({ turn, hop, request }) => {
    if (turn?.task_id !== old.id) return say("开始写这篇小说。");
    if (hop === 1) { await gate; return call(shell("echo 写小说")); }
    heard = requestText(request);
    return say("好，这一段不写了。");
  });
  // The reading takes it for the old job, as rule 6 did then.
  h.judge("read_filing").reply(fileUnder("请用 shell 工具执行 sleep 120，执行完告诉我完成"));
  const line = h.postUser(dm, "请写一篇 4000 字的中文长篇科幻小说，不要调用任何工具");
  await h.waitFor(() => h.turns(bot!).some((turn) => turn.status === "running"), { what: "the old segment at work" });
  const first = h.turns(bot!)[0]!;
  expect(first).toMatchObject({ task_id: old.id, trigger_message_id: line.id });

  // You open a new job from the line, the way the dialog's 「新开一件事」 does.
  const moved = h.store.newJobFromLine(line.id, { userActionId: "test" });
  h.engine.noteFiled(moved.id);
  h.engine.dispatchQueuedWork();
  release();
  await h.waitIdle();

  const job = h.store.getTask(moved.task_id!);
  expect(job.title).toBe("请写一篇 4000 字的中文长篇科幻小说，不要调用任何工具");
  expect(h.store.filingsOfMessage(line.id).map((f) => f.taskId)).toEqual([job.id]);
  // The old segment heard it at its next step.
  expect(heard).toContain(`改归到了《${job.title}》`);
  expect(heard).toContain("别再按这句动手");
  // A segment of its own on the new job.
  const onJob = h.turns(bot!).filter((turn) => turn.task_id === job.id);
  expect(onJob).toHaveLength(1);
  expect(h.messages(dm).some((m) => m.kind === "bot" && m.body === "开始写这篇小说。")).toBe(true);
});
