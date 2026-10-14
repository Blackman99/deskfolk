/**
 * 2026-10-14, 视频制作. 创意导演 was an hour into its MV in your direct when you asked it in the
 * group 「@创意导演 你呢」. The line was read as about the MV, so its turn in the direct heard it (ADR
 * 0040 I1b), marked 「在群「视频制作」里」, and was told the user is answered over there. Nobody
 * answered over there: the line was said to it alone. And the MV's next tickets were called back in
 * the group, the last place you had spoken about the MV, while the work was being done in the direct.
 *
 * A line of yours said to a Bot in another conversation now reaches its turn marked as said to it,
 * with that conversation's id, and the Bot answers there with send_message and keeps working. A
 * line that reaches it only because it is about the same job stays unmarked. A job's next ticket is
 * called back where its Bot last worked on the job.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, fileUnder, requestText, say, sendMessage, shell, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const MV = "做一首歌的 MV";

function mvInYourDirect(h: Scenario) {
  const [director, helper] = h.createBots(
    { name: "创意导演", duties: "写歌，做 MV" },
    { name: "通识", duties: "答疑，整理资料" },
  );
  const dm = h.direct(director!);
  const room = h.group("视频制作", [director!, helper!]);
  const plan = openPlan(h, dm, MV, planSpec("一首歌和它的 MV"));
  // Every line here is read as about the MV, as the reader model read the real ones.
  h.judge("read_filing").handle(fileUnder(MV));
  return { director: director!, helper: helper!, dm, room, plan };
}

/** The director's turn in your direct, held on its first hop until `go` resolves; what its second hop read. */
function workingInTheDirect(h: Scenario, director: { id: string }, dm: string, room: string, opts: { answer: boolean }) {
  const go = Promise.withResolvers<void>();
  const seen = { working: false, note: "" };
  h.script(director, dm).handle(async ({ hop, request }) => {
    if (hop === 1) {
      seen.working = true;
      await go.promise;
      return call(shell("echo 剪第四段"));
    }
    if (hop === 2) {
      // The note that read out what came in while hop 1 ran.
      const text = requestText(request);
      seen.note = text.slice(text.lastIndexOf("（应用提示）收件 "));
      return opts.answer ? call(sendMessage("记下了，出片都按先定帧再动来做。", { session_id: room })) : call(shell("echo 拼成片"));
    }
    if (hop === 3) return call(shell("echo 拼成片"));
    return say("整片拼好了。");
  });
  return { go, seen };
}

test("your @ in a group, heard by its turn on that job in your direct, is answered in the group while the work goes on", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, dm, room, plan } = mvInYourDirect(h);
  const { go, seen } = workingInTheDirect(h, director, dm, room, { answer: true });

  h.postUser(dm, "把 MV 做完");
  await h.waitFor(() => seen.working, { what: "the director at work in your direct" });
  const asked = h.postUser(room, "@创意导演 你呢");
  await h.routed();
  go.resolve();
  await h.waitIdle();

  // Heard by the turn already on the MV, with where to answer.
  const [row] = h.store.db.query<{ reply_in: string | null; said_in: string | null }, [string]>(
    "SELECT reply_in, said_in FROM inbox_items WHERE message_id = ?").all(asked.id);
  expect(row).toEqual({ reply_in: room, said_in: "群「视频制作」" });
  expect(seen.note).toContain(`在群「视频制作」里，对你说的，回话发到 session_id ${room}] @创意导演 你呢`);
  expect(seen.note).toContain("用 send_message 带上它的 session_id 在那边回答它；这不会结束这一段。");

  // The answer is in the group; the work went on in the direct, in one turn, to its own close.
  const said = (session: string) => h.messages(session).filter((message) => message.author === director.id).map((message) => message.body);
  expect(said(room)).toEqual(["记下了，出片都按先定帧再动来做。"]);
  expect(said(dm)).toEqual(["整片拼好了。"]);
  expect(h.turns(director).map((turn) => [turn.session_id, turn.task_id, turn.status])).toEqual([[dm, plan.id, "completed"]]);
});

test("a line about the same job said to someone else reaches its turn unmarked", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, helper, dm, room } = mvInYourDirect(h);
  const { go, seen } = workingInTheDirect(h, director, dm, room, { answer: false });
  h.script(helper, room).reply(say("好，雨我加大。"));

  h.postUser(dm, "把 MV 做完");
  await h.waitFor(() => seen.working, { what: "the director at work in your direct" });
  const told = h.postUser(room, "@通识 MV 里的雨再大一点");
  await h.routed();
  go.resolve();
  await h.waitIdle();

  const rows = h.store.db.query<{ bot_id: string; reply_in: string | null }, [string]>(
    "SELECT bot_id, reply_in FROM inbox_items WHERE message_id = ?").all(told.id);
  expect(rows).toEqual([{ bot_id: director.id, reply_in: null }]);
  expect(seen.note).toContain("MV 里的雨再大一点");
  expect(seen.note).not.toContain("对你说的");
  expect(h.messages(room).filter((message) => message.author === director.id)).toEqual([]);
});

test("a job's next ticket is called back where its Bot last worked on the job, not where you last spoke about it", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, dm, room, plan } = mvInYourDirect(h);
  const sample = h.store.createTicket({ taskId: plan.id, title: "第一段（样片）", status: "done", worker: director.id });
  const next = h.store.createTicket({ taskId: plan.id, title: "第三段", status: "todo", worker: director.id });
  // Worked on in your direct: the sample.
  const line = h.store.transaction(() => h.store.postMessage(dm, { body: "做样片" }));
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: sample.id }] });
  const worked = h.store.createTurn({ sessionId: dm, botId: director.id, triggerMessageId: line.id, taskId: plan.id, ticketId: sample.id });
  h.store.setTurnStatus(worked.id, "completed");
  h.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [worked.work_item_id!]);
  // Then you asked about it in the group.
  const asked = h.store.transaction(() => h.store.postMessage(room, { body: "@创意导演 你呢" }));
  h.store.fileMessage(asked.id, { explicit: [{ taskId: plan.id }] });
  h.script(director).reply(call(shell("echo 第三段")), say("第三段在做了。"));

  h.tick(new Date(Date.now() + 15 * 60_000));
  await h.waitIdle();

  const [wake] = h.store.db.query<{ session_id: string }, [string]>(
    "SELECT session_id FROM check_backs WHERE kind = 'supervisor' AND ticket_id = ? ORDER BY created_at").all(next.id);
  expect(wake).toEqual({ session_id: dm });
  expect(h.turns(director).filter((turn) => turn.ticket_id === next.id).map((turn) => turn.session_id)).toEqual([dm]);
});
