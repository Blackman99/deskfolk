/**
 * Checks from your words, engine side (ADR 0040 P3): offered once your line is filed, each on the
 * app's line in the conversation with 确认 / 改 / 不要, and offered again, with a count, when you say
 * it again; measured once bound, its result shown and never a block; a gate only once you press
 * 确认, and then measured, holding the job open and calling a Bot back like any check.
 */
import { afterEach, expect, test } from "bun:test";
import type { Message } from "@real-bot/protocol";
import { checkEnv } from "./acceptance-eval";
import { resolveFfmpegBins } from "./seams-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDerivedChecks } from "./engine/derived-checks";
import { Store } from "./store";
import { call, createScenario, requestText, say, shell, type Scenario } from "./test-kit/scenario";

const FFMPEG = resolveFfmpegBins(checkEnv(process.env));

const open: Scenario[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function scenario() {
  const h = await createScenario();
  open.push(h);
  const [director] = h.createBots("视频导演");
  const direct = h.direct(director!);
  const cards = (): Message[] => h.messages(direct).filter((message) => message.control?.kind === "check");
  return { h, director: director!, direct, cards };
}

const events = (messages: Message[]) => messages.map((card) => (card.control?.kind === "check" ? card.control.event : null));

test("each number is offered on its own card; 确认 puts it in force and 不要 removes it, once each", async () => {
  const { h, director, direct, cards } = await scenario();
  h.script(director, direct).reply(say("好的"));
  h.postUser(direct, "做个片子，约 90 秒，竖屏");
  await h.waitIdle();

  const planId = h.store.listQuotes()[0]!.task_id!;
  const checks = h.store.listChecks(planId);
  expect(checks.map((check) => [check.origin, check.measure, check.derived_state, check.bind_kind])).toEqual([
    ["derived", { dimension: "duration", min: 81, max: 99 }, "proposed", null],
    ["derived", { dimension: "aspect", ratio: "portrait" }, "proposed", null],
  ]);
  const [duration, aspect] = cards();
  expect(duration).toMatchObject({
    kind: "system",
    control: { kind: "check", event: "proposed", check_ids: [checks[0]!.id], offer: ["confirm_check", "edit_check", "remove_check"], replacing: null, edit_draft: "片长改成 " },
  });
  expect(duration!.body).toContain("按你的话加检查：时长 81–99 秒？");
  expect(aspect).toMatchObject({ control: { check_ids: [checks[1]!.id], edit_draft: "画幅改成 " } });
  // For you: the Bots read the checks in the plan's situation, not in the transcript.
  expect(h.store.db.query<{ hidden: number }, [string]>(`SELECT hidden_from_bots AS hidden FROM messages WHERE id = ?`).get(duration!.id)!.hidden).toBe(1);

  // Offered: asked to run, nothing runs.
  await h.engine.runPlanChecks(planId, { cause: "user" });
  expect(h.store.listChecks(planId).map((check) => check.last_run)).toEqual([null, null]);

  expect(h.engine.control(duration!.id, { action: "confirm_check" })).toEqual({ made: [], lifted: [] });
  expect(h.store.getCheck(checks[0]!.id).derived_state).toBe("active");
  expect(h.store.getMessage(duration!.id).control).toMatchObject({ acted: ["confirm_check"] });
  expect(h.engine.control(aspect!.id, { action: "remove_check" })).toEqual({ made: [], lifted: [] });
  expect(h.store.listChecks(planId).map((check) => check.id)).toEqual([checks[0]!.id]);
  // A second press, a button it does not offer, or 改 (the messenger's own) does nothing more.
  expect(h.engine.control(duration!.id, { action: "remove_check" })).toEqual({ made: [], lifted: [] });
  expect(h.store.listChecks(planId)).toHaveLength(1);
  expect(() => h.engine.control(aspect!.id, { action: "undo" })).toThrow("this line does not offer that button");
  expect(() => h.engine.control(aspect!.id, { action: "edit_check" })).toThrow("this line does not offer that button");
  // Nothing else was said about it: a press needs no card.
  expect(events(cards())).toEqual(["proposed", "proposed"]);
});

test("said again, the card comes back with how many times; bound and measured, it stays an offer until you press 确认", async () => {
  const { h, director, direct, cards } = await scenario();
  h.script(director, direct).reply(
    say("好的"),
    say("收到"),
    call(shell("printf x > EP01_MASTER.mp4")),
    say("母带交了：EP01_MASTER.mp4"),
  );
  h.postUser(direct, "做个片子，片长约 90 秒");
  await h.waitIdle();
  h.postUser(direct, "片长 90 秒左右");
  await h.waitIdle();
  const planId = h.store.listQuotes()[0]!.task_id!;
  expect(h.store.listChecks(planId).map((check) => [check.measure, check.derived_state])).toEqual([[{ dimension: "duration", min: 81, max: 99 }, "proposed"]]);
  expect(events(cards())).toEqual(["proposed", "proposed"]);
  const first = cards()[0]!.control;
  expect(cards()[1]!.control).toMatchObject({ times: 2, check_ids: first?.kind === "check" ? first.check_ids : [] });
  expect(cards()[1]!.body).toStartWith("你已经说了 2 次。按你的话加检查：时长 81–99 秒？");

  h.postUser(direct, "交母带吧");
  await h.waitIdle();
  const [check] = h.store.listChecks(planId);
  expect(check).toMatchObject({ bind_kind: "glob", bind_glob: "*MASTER*", derived_state: "proposed" });
  // Measured once bound (the file is no video, so it could not be measured), and no gate: nothing waits on it.
  expect(check!.last_run?.outcome).toBe("error");
  expect(h.store.checkStale(planId)).toBe(false);
  h.engine.control(cards()[1]!.id, { action: "confirm_check" });
  await h.waitIdle();
  expect(h.store.listChecks(planId)[0]).toMatchObject({ derived_state: "active", last_run: { outcome: "error" } });
  expect(events(cards())).toEqual(["proposed", "proposed"]);
});

test("a later number is offered beside the gate you confirmed: the card names it, and it stays in force until you choose", async () => {
  const { h, director, direct, cards } = await scenario();
  h.script(director, direct).reply(say("好的"), say("收到"), say("明白"));
  h.postUser(direct, "做个片子，片长约 90 秒");
  await h.waitIdle();
  const planId = h.store.listQuotes()[0]!.task_id!;
  h.engine.control(cards()[0]!.id, { action: "confirm_check" });
  const [gate] = h.store.listChecks(planId);
  h.postUser(direct, "片长改成 2 分钟");
  await h.waitIdle();
  const offer = cards().at(-1)!;
  expect(offer.control).toMatchObject({ event: "proposed", replacing: gate!.id });
  expect(offer.body).toContain("生效中是时长 81–99 秒，你刚说的是时长 108–132 秒");
  expect(h.store.getCheck(gate!.id).derived_state).toBe("active");
  // 不要 on the offer: the gate was never out of force.
  h.engine.control(offer.id, { action: "remove_check" });
  expect(h.store.listChecks(planId).map((check) => [check.id, check.derived_state])).toEqual([[gate!.id, "active"]]);
  // A complaint afterwards touches nothing.
  h.postUser(direct, "上一版 107 秒太短了");
  await h.waitIdle();
  expect(h.store.listChecks(planId).map((check) => [check.id, check.derived_state])).toEqual([[gate!.id, "active"]]);
  expect(events(cards())).toEqual(["proposed", "proposed"]);
});

test.skipIf(!FFMPEG)("a failing offer calls nobody back; confirmed, handing the master over is sent back and the Bot is called back over it", async () => {
  const { h, director, direct, cards } = await scenario();
  const cut = `'${FFMPEG!.ffmpeg}' -v error -f lavfi -i color=c=black:s=16x16:r=1 -t 3 -c:v mpeg4 -y EP01_MASTER.mp4`;
  const master = () => h.store.listChecks(h.store.listQuotes()[0]!.task_id!)[0]!.path!;
  h.script(director, direct).reply(
    call(shell(cut)),
    say("先出了一版 EP01_MASTER.mp4"),
    () => say(`母带好了\n附件：${master()}`),
    say("母带是 3 秒，我再剪长"),
    say("收到，重剪"),
  );
  h.postUser(direct, "做个片子，片长约 90 秒");
  await h.waitIdle();
  const planId = h.store.listQuotes()[0]!.task_id!;
  // Measured and shown, never a block: no call-back over it.
  expect(h.store.listChecks(planId)[0]).toMatchObject({ derived_state: "proposed", last_run: { outcome: "fail", detail: "3.00 秒，要时长 81–99 秒" } });
  expect(h.hops(director).map((hop) => requestText(hop.request)).some((text) => text.includes("回看：还有验收检查没过"))).toBe(false);

  h.engine.control(cards()[0]!.id, { action: "confirm_check" });
  await h.waitIdle();
  expect(h.store.listChecks(planId)[0]).toMatchObject({ derived_state: "active", last_run: { outcome: "fail", detail: "3.00 秒，要时长 81–99 秒" } });
  // Confirmed and failing, it is a gate like any check the app runs: handing the same master over
  // again meets the closing look, and once the plan is quiet the plan watch calls the Bot back.
  h.postUser(direct, "母带再交一次");
  await h.waitIdle();
  const hops = h.hops(director);
  const noted = hops.flatMap((hop) => hop.request.messages.map((message) => requestText({ ...hop.request, messages: [message] }))).find((text) => text.startsWith("（应用提示）") && text.includes("3.00 秒"));
  expect(noted).toContain("「时长约 90 秒」时长 81–99 秒：");
  expect(hops.map((hop) => requestText(hop.request)).some((text) => text.includes("回看：还有验收检查没过") && text.includes("3.00 秒，要时长 81–99 秒"))).toBe(true);
});

test("an offer is measured the moment it is bound, and again on a newer cut; your confirm measures it anew", () => {
  const root = mkdtempSync(join(tmpdir(), "derived-engine-"));
  roots.push(root);
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const { bot, direct_session: direct } = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const runs: string[][] = [];
  const said: Message[] = [];
  const derived = createDerivedChecks({
    store,
    publishMessage: (message) => void said.push(message),
    run: async (_taskId, checkIds) => void runs.push(checkIds),
    track: (promise) => promise,
    renderMirrors: () => {},
  });
  const line = store.postMessage(direct.id, { body: "片长约 90 秒" });
  const turn = store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: line.id });
  derived.noteLine(line.id);
  const [check] = store.listChecks(turn.task_id!);
  expect(runs).toEqual([]);

  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out", "EP01_MASTER.mp4"), "video");
  store.insertMessage({ sessionId: direct.id, turnId: turn.id, kind: "bot", author: bot.id, body: "交了", paths: ["out/EP01_MASTER.mp4"] });
  derived.noteTurnEnded(store.setTurnStatus(turn.id, "completed"));
  expect(store.getCheck(check!.id)).toMatchObject({ path: "out/EP01_MASTER.mp4", derived_state: "proposed" });
  expect(runs).toEqual([[check!.id]]);

  // A newer cut is measured at once, without another line or card.
  writeFileSync(join(root, "out", "EP01_MASTER_v2.mp4"), "video");
  store.insertMessage({ sessionId: direct.id, turnId: turn.id, kind: "bot", author: bot.id, body: "再交", paths: ["out/EP01_MASTER_v2.mp4"] });
  derived.noteTurnEnded(store.getTurn(turn.id));
  expect(runs).toEqual([[check!.id], [check!.id]]);
  expect(said.map((message) => (message.control?.kind === "check" ? message.control.event : null))).toEqual(["proposed"]);

  // Confirmed from the board: a gate, measured anew.
  derived.confirm(check!.id);
  expect(runs).toEqual([[check!.id], [check!.id], [check!.id]]);
  expect(store.getCheck(check!.id).derived_state).toBe("active");
  store.close();
});
