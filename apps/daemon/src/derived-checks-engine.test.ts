/**
 * Checks from your words, engine side (ADR 0040 P3): offered once your line is filed, shown on the
 * board, with no card asking you about it (2026-10-04) — only a number that differs from a gate in
 * force gets the app's line, with 确认 / 改 / 不要, again with a count when you say it again; measured
 * once bound, its result shown and never a block; a gate only once you confirm it, and then measured,
 * holding the job open and calling a Bot back like any check.
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

test("each number is offered on the board with no card; confirmed there it is in force, and nothing runs before", async () => {
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
  // You just said it: nothing asks you to confirm what you said, and nothing waits on you.
  expect(cards()).toEqual([]);
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'ask'").get()).toEqual({ n: 0 });

  // Offered: asked to run, nothing runs.
  await h.engine.runPlanChecks(planId, { cause: "user" });
  expect(h.store.listChecks(planId).map((check) => check.last_run)).toEqual([null, null]);

  h.engine.confirmDerivedCheck(checks[0]!.id);
  expect(h.store.getCheck(checks[0]!.id).derived_state).toBe("active");
  expect(cards()).toEqual([]);
});

test("said again, it is still only offered; bound and measured, it stays an offer until you confirm it", async () => {
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
  expect(cards()).toEqual([]);

  h.postUser(direct, "交母带吧");
  await h.waitIdle();
  const [check] = h.store.listChecks(planId);
  expect(check).toMatchObject({ bind_kind: "glob", bind_glob: "*MASTER*", derived_state: "proposed" });
  // Measured once bound (the file is no video, so it could not be measured), and no gate: nothing waits on it.
  expect(check!.last_run?.outcome).toBe("error");
  expect(h.store.checkStale(planId)).toBe(false);
  h.engine.confirmDerivedCheck(check!.id);
  await h.waitIdle();
  expect(h.store.listChecks(planId)[0]).toMatchObject({ derived_state: "active", last_run: { outcome: "error" } });
  // A gate finding its file says nothing either: the board shows it.
  expect(cards()).toEqual([]);
});

test("a later number that differs from the gate you confirmed gets a card: it names both, and the gate stays in force until you choose", async () => {
  const { h, director, direct, cards } = await scenario();
  h.script(director, direct).reply(say("好的"), say("收到"), say("明白"), say("嗯"));
  h.postUser(direct, "做个片子，片长约 90 秒");
  await h.waitIdle();
  const planId = h.store.listQuotes()[0]!.task_id!;
  const [gate] = h.store.listChecks(planId);
  h.engine.confirmDerivedCheck(gate!.id);
  h.postUser(direct, "片长改成 2 分钟");
  await h.waitIdle();
  const [offer] = cards();
  expect(offer).toMatchObject({
    kind: "system",
    control: { kind: "check", event: "proposed", replacing: gate!.id, offer: ["confirm_check", "edit_check", "remove_check"], edit_draft: "片长改成 " },
  });
  expect(offer!.body).toBe("你后来说的和生效中的检查不一样：生效中是时长 81–99 秒，你刚说的是时长 108–132 秒。你选之前，生效中的那条照旧。");
  // For you: the Bots read the checks in the plan's situation, not in the transcript.
  expect(h.store.db.query<{ hidden: number }, [string]>(`SELECT hidden_from_bots AS hidden FROM messages WHERE id = ?`).get(offer!.id)!.hidden).toBe(1);
  expect(h.store.getCheck(gate!.id).derived_state).toBe("active");
  // Said again, the card comes back with how many times.
  h.postUser(direct, "片长 2 分钟");
  await h.waitIdle();
  expect(cards()).toHaveLength(2);
  expect(cards()[1]!.control).toMatchObject({ times: 2, replacing: gate!.id });
  expect(cards()[1]!.body).toStartWith("你已经说了 2 次。你后来说的和生效中的检查不一样");
  // 不要 on the offer: the gate was never out of force. A second press, a button it does not offer,
  // or 改 (the messenger's own) does nothing more.
  expect(h.engine.control(offer!.id, { action: "remove_check" })).toEqual({ made: [], lifted: [] });
  expect(h.store.listChecks(planId).map((check) => [check.id, check.derived_state])).toEqual([[gate!.id, "active"]]);
  expect(h.engine.control(offer!.id, { action: "confirm_check" })).toEqual({ made: [], lifted: [] });
  expect(() => h.engine.control(offer!.id, { action: "undo" })).toThrow("this line does not offer that button");
  expect(() => h.engine.control(offer!.id, { action: "edit_check" })).toThrow("this line does not offer that button");
  // A complaint afterwards touches nothing.
  h.postUser(direct, "上一版 107 秒太短了");
  await h.waitIdle();
  expect(h.store.listChecks(planId).map((check) => [check.id, check.derived_state])).toEqual([[gate!.id, "active"]]);
  expect(events(cards())).toEqual(["proposed", "proposed"]);
});

test("确认 on a replacement's card puts the new number in force in place of the gate", async () => {
  const { h, director, direct, cards } = await scenario();
  h.script(director, direct).reply(say("好的"), say("收到"));
  h.postUser(direct, "做个片子，片长约 90 秒");
  await h.waitIdle();
  const planId = h.store.listQuotes()[0]!.task_id!;
  const [gate] = h.store.listChecks(planId);
  h.engine.confirmDerivedCheck(gate!.id);
  h.postUser(direct, "片长改成 2 分钟");
  await h.waitIdle();
  const [offer] = cards();
  h.engine.control(offer!.id, { action: "confirm_check" });
  await h.waitIdle();
  expect(h.store.listChecks(planId).map((check) => [check.measure, check.derived_state])).toEqual([[{ dimension: "duration", min: 108, max: 132 }, "active"]]);
  expect(h.store.getMessage(offer!.id).control).toMatchObject({ acted: ["confirm_check"] });
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

  h.engine.confirmDerivedCheck(h.store.listChecks(planId)[0]!.id);
  await h.waitIdle();
  expect(h.store.listChecks(planId)[0]).toMatchObject({ derived_state: "active", last_run: { outcome: "fail", detail: "3.00 秒，要时长 81–99 秒" } });
  expect(cards()).toEqual([]);
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

  // A newer cut is measured at once.
  writeFileSync(join(root, "out", "EP01_MASTER_v2.mp4"), "video");
  store.insertMessage({ sessionId: direct.id, turnId: turn.id, kind: "bot", author: bot.id, body: "再交", paths: ["out/EP01_MASTER_v2.mp4"] });
  derived.noteTurnEnded(store.getTurn(turn.id));
  expect(runs).toEqual([[check!.id], [check!.id]]);
  // An offer asks nothing of you: no line about it, bound or not.
  expect(said).toEqual([]);

  // Confirmed from the board: a gate, measured anew.
  derived.confirm(check!.id);
  expect(runs).toEqual([[check!.id], [check!.id], [check!.id]]);
  expect(store.getCheck(check!.id).derived_state).toBe("active");
  store.close();
});
