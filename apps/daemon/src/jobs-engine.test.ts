/**
 * External jobs in the engine (ADR 0047, engine level 6): a part with a job running is not submitted
 * again without a reason, a reason goes through without reaching the server as an argument, and a
 * check on a registered job is answered from what the daemon last heard.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, endTurn, media, say, type Scenario, type ToolOutcome } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("a part with a job running is not submitted again without a reason; with one it is, and checks read the daemon's last word", async () => {
  const h = await createScenario({ media: { videoPolls: 3 }, jobs: true });
  open.push(h);
  const [director] = h.createBots({ name: "视频导演", duties: "按分镜生成镜头" });
  const dm = h.direct(director!);
  const plan = h.store.openTask({ sessionId: dm, title: "EP01" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "Shots", status: "doing", worker: director!.id });
  const results: ToolOutcome[] = [];
  const keep = ({ results: got }: { results: ToolOutcome[] }) => {
    results.push(...got);
    return null;
  };
  h.script(director!).reply(
    call(media("submit_video", { prompt: "Shot 05：雪地远景" })),
    (ctx) => keep(ctx) ?? call(media("submit_video", { prompt: "Shot 05：雪地远景，镜头更慢" })),
    (ctx) => keep(ctx) ?? call(media("submit_video", { prompt: "Shot 05：雪地远景，镜头更慢", resubmit_reason: "用户要求放慢推镜" })),
    (ctx) => keep(ctx) ?? call(media("check_video", { job_id: "fixture-video-1" })),
    (ctx) => keep(ctx) ?? call(endTurn()),
  );
  const line = h.store.postMessage(dm, { body: "把 Shot 05 渲出来" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();

  // The second submit of Shot 05 was turned away; the third, with its reason, reached the server.
  expect(results.map((result) => result.ok)).toEqual([true, false, true, true]);
  expect(results[1]!.content).toContain("job_pending");
  expect(results[0]!.content).toContain("已登记");
  const submits = h.mcpCalls(director).filter((row) => row.tool === "submit_video");
  expect(submits.map((row) => row.args)).toEqual([{ prompt: "Shot 05：雪地远景" }, { prompt: "Shot 05：雪地远景，镜头更慢" }]);
  expect(h.store.db.query("SELECT request_id, resubmit_reason, part_no FROM external_jobs ORDER BY created_at, rowid").all()).toEqual([
    { request_id: "fixture-video-1", resubmit_reason: null, part_no: 5 },
    { request_id: "fixture-video-2", resubmit_reason: "用户要求放慢推镜", part_no: 5 },
  ]);
  // The check was answered from the job's row, not by the server.
  expect(results[3]!.content).toContain("cached");
  expect(h.mcpCalls(director).filter((row) => row.tool === "check_video")).toEqual([]);
});

test("a Bot whose identical submit was deduplicated is woken with the result too", async () => {
  const h = await createScenario({ media: { videoPolls: 1 }, jobs: true });
  open.push(h);
  const [director, writer] = h.createBots({ name: "视频导演", duties: "生成镜头" }, { name: "编剧", duties: "写分镜" });
  const shot = { prompt: "Shot 05：雪地远景" };
  const results: ToolOutcome[] = [];
  for (const bot of [director!, writer!]) {
    const dm = h.direct(bot);
    const plan = h.store.openTask({ sessionId: dm, title: `${bot.name} 的活` });
    h.script(bot).reply(call(media("submit_video", shot)), ({ results: got }) => {
      results.push(...got);
      return call(endTurn());
    });
    const line = h.store.postMessage(dm, { body: "把 Shot 05 渲出来" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
  }
  expect(h.mcpCalls().filter((row) => row.tool === "submit_video")).toHaveLength(1);
  expect(results[1]!.content).toContain("deduped");
  for (let minute = 0; minute < 3; minute += 1) {
    h.advance(61_000);
    await h.waitIdle();
  }
  const told = h.store.db.query<{ bot_id: string }, []>("SELECT DISTINCT bot_id FROM inbox_items WHERE source = 'job'").all().map((row) => row.bot_id);
  expect(told.sort()).toEqual([director!.id, writer!.id].sort());
});

test("a server that answers in key: value lines has its renders polled by the app too, and the Bot is woken with its words", async () => {
  // grok-imagine answers `request_id: …` and `status: done` / `url: …` lines, not JSON: before, no
  // job was ever registered, and the Bot sat in its own turn checking the render itself.
  const h = await createScenario({ media: { videoPolls: 2, lines: true }, jobs: true });
  open.push(h);
  const [director] = h.createBots({ name: "视频导演", duties: "生成镜头" });
  const dm = h.direct(director!);
  const plan = h.store.openTask({ sessionId: dm, title: "宣传短片" });
  const results: ToolOutcome[] = [];
  h.script(director!).reply(
    call(media("submit_video", { prompt: "6 秒竖版宣传短片" })),
    ({ results: got }) => {
      results.push(...got);
      return call(endTurn());
    },
    say("片子渲好了，我去下载"),
  );
  const line = h.store.postMessage(dm, { body: "把短片渲出来" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();

  expect(results[0]!.content).toContain("已登记");
  expect(h.store.db.query("SELECT request_id, state FROM external_jobs").all()).toEqual([{ request_id: "fixture-video-1", state: "pending" }]);
  for (let minute = 0; minute < 6; minute += 1) {
    h.advance(61_000);
    await h.waitIdle();
  }
  const job = h.store.db.query<{ state: string; status_text: string; result: string; polls: number }, []>(
    "SELECT state, status_text, result, polls FROM external_jobs",
  ).get()!;
  expect(job).toMatchObject({ state: "completed", status_text: "done", polls: 3 });
  // What the Bot gets is the server's own words, its warning about the link included.
  expect(job.result).toBe("status: done\nurl: https://media.example/fixture-video-1.mp4\nduration_s: 6\n(url is TEMPORARY — fetch promptly)");
  // The app asked the server; the Bot never checked, and was woken once it was done.
  expect(h.mcpCalls(director!).filter((row) => row.tool === "check_video")).toEqual([]);
  expect(h.store.db.query("SELECT bot_id FROM inbox_items WHERE source = 'job'").all()).toEqual([{ bot_id: director!.id }]);
  expect(h.messages(dm).filter((message) => message.kind === "bot").map((message) => message.body)).toEqual(["片子渲好了，我去下载"]);
});
