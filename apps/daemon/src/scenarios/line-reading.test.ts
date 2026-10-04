/**
 * 2026-10-03: the app read lines by fixed word lists, and each miss was patched by adding words.
 * 视频导演 said 「正在编写全新第 1 集设定集与剧本分镜方案」 and ended; 「正在编写」 was not a word
 * the list knew. You said 「从头再做一遍，之前的作废」; 「作废」 and 「从头再做」 were not complaint
 * words either. Each fix widened a list, and the next phrasing missed again.
 *
 * Now a model reads each line before the app acts on it (ADR 0055): what it reads is checked and
 * the app's own rules still decide what follows. Each test here is a line the word lists miss, read
 * by the model, then the same line with no reading to show the lists still miss it, so it is the
 * reading that does the work.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, fileUnder, requestText, sendMessage, tool, type HopContext, type Scenario, type ScenarioOptions, type ToolOutcome } from "../test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options: ScenarioOptions): Promise<Scenario> {
  const h = await createScenario(options);
  open.push(h);
  return h;
}

const NOTHING = { control: "none", control_only: false, status_only: false, objections: [] };

test("a stop the rules do not know, read as nothing but a stop, stops the Bot and wakes nobody", async () => {
  for (const read of [true, false]) {
    const h = await scenario({ holds: true });
    const [director] = h.createBots({ name: "视频导演", duties: "出片" });
    const direct = h.direct(director!);
    if (read) h.judge("read_user_line").reply({ control: "stop", control_only: true, status_only: false, objections: [] });
    h.script(director!).handle(() => call(tool("end_turn", { reason: "nothing_new" })));
    h.postUser(direct, "先别搞了，收手吧");
    await h.waitIdle();
    const holds = h.store.listHolds({ inForce: true });
    if (read) {
      expect(holds.map((hold) => ({ scope: hold.scope, id: hold.scope_id }))).toEqual([{ scope: "bot", id: director!.id }]);
      expect(h.hops(director!)).toEqual([]);
    } else {
      // The word lists know no 「别搞了」 or 「收手」: the line goes to the Bot like any other.
      expect(holds).toEqual([]);
      expect(h.hops(director!).length).toBeGreaterThan(0);
    }
  }
});

test("a stop said beside a request carries the buttons and goes on as any line", async () => {
  const h = await scenario({ holds: true });
  const [director] = h.createBots({ name: "视频导演", duties: "出片" });
  const direct = h.direct(director!);
  h.judge("read_user_line").reply({ control: "stop", control_only: false, status_only: false, objections: [] });
  h.script(director!).handle(() => call(tool("end_turn", { reason: "nothing_new" })));
  const line = h.postUser(direct, "手上的先放放，帮我看下第二集分镜");
  await h.waitIdle();
  expect(h.store.listHolds({ inForce: true })).toEqual([]);
  expect(h.messages(direct).find((message) => message.id === line.id)!.control).toMatchObject({ kind: "possible_control", offer: ["stop"] });
  expect(h.hops(director!).length).toBeGreaterThan(0);
});

test("a status question the lists do not know is answered from the plan's rows, and wakes nobody", async () => {
  for (const read of [true, false]) {
    const h = await scenario({ workItems: true });
    const { director, room } = videoTeam(h);
    openPlan(h, room, "一拳超人", planSpec("一拳超人风格可播放短片"));
    if (read) h.judge("read_user_line").reply({ ...NOTHING, status_only: true });
    h.script(director).handle(() => call(tool("end_turn", { reason: "nothing_new" })));
    h.judge("judgement").handle(() => "join");
    h.postUser(room, "第二集现在推进到哪一步了");
    await h.waitIdle();
    const answered = h.messages(room).some((message) => message.kind === "system" && message.body.startsWith("这件事：一拳超人"));
    expect({ read, answered }).toEqual({ read, answered: read });
    if (read) expect(h.hops()).toEqual([]);
  }
});

test("a complaint the lists miss asks to send the handed-over work back", async () => {
  for (const read of [true, false]) {
    const h = await scenario({ submissions: true });
    const { director, room } = videoTeam(h);
    const plan = openPlan(h, room, "一拳超人", planSpec("一拳超人风格可播放短片"));
    const ticket = h.store.createTicket({ taskId: plan.id, title: "一拳超人风格可播放短片", status: "review", worker: director.id });
    if (read) h.judge("read_user_line").reply({ ...NOTHING, objections: ["这版节奏拖沓", "整个推掉吧"] });
    // About the film, either way (ADR 0057): what is read here is whether it objects.
    h.judge("read_filing").reply(fileUnder("一拳超人"));
    h.script(director).handle(() => call(tool("end_turn", { reason: "nothing_new" })));
    h.postUser(room, "@视频导演 这版节奏拖沓，整个推掉吧");
    await h.waitIdle();
    const card = h.messages(room).find((message) => message.control?.kind === "rework");
    if (read) {
      expect(card?.control).toMatchObject({ ticket_id: ticket.id, offer: ["rework", "dismiss"] });
      expect(h.store.listWorkEvents({ kind: "complaint.asked" }).map((event) => event.payload.signal)).toEqual(["reading"]);
    } else {
      // Neither 拖沓 nor 推掉 is a complaint word.
      expect(card).toBeUndefined();
    }
  }
});

const PROMISE = "收到。我这边着手整理第二集的分镜脚本，弄好发群里。";
const SAID = "我这边着手整理第二集的分镜脚本，弄好发群里";

/** The labels of your lines a hop read (`U12`). */
function yourLabels(request: HopContext["request"]): string[] {
  return [...new Set([...requestText(request).matchAll(/\bU\d+\b/g)].map((match) => match[0]))];
}

test("a promise of more to come the lists miss turns the ending back, quoting the Bot's own words", async () => {
  for (const read of [true, false]) {
    const h = await scenario({ submissions: true });
    const { director, room } = videoTeam(h);
    const plan = openPlan(h, room, "一拳超人", planSpec("一拳超人风格可播放短片"));
    h.store.createTicket({ taskId: plan.id, title: "一拳超人风格可播放短片", status: "review", worker: director.id });
    if (read) {
      h.judge("read_bot_line").handle(({ payload }) => {
        const said = String((payload as { said?: string }).said ?? "");
        return { later: said.includes("着手整理") ? SAID : null, claims_verified: false, no_work: false, bare_status: false };
      });
    }
    const refused: ToolOutcome[] = [];
    let labels: string[] = [];
    let sent = false;
    h.script(director).handle(({ hop, request, results }) => {
      if (hop === 1) labels = yourLabels(request);
      if (results.some((result) => result.name === "send_message" && result.ok)) sent = true;
      refused.push(...results.filter((result) => result.name === "end_turn" && !result.ok));
      if (!sent) return call(sendMessage(PROMISE));
      return call(tool("end_turn", { reason: "done", inbox: labels.map((id) => ({ id, disposition: "answered" })) }));
    });
    h.postUser(room, "@视频导演 第二集也开始吧");
    await h.waitIdle();
    if (read) {
      expect(refused).toHaveLength(1);
      expect(refused[0]!).toMatchObject({ error: "promised_later", content: expect.stringContaining(`You said 「${SAID}」`) });
      expect(h.messages(room).at(-1)!.body).toContain(`视频导演说「${SAID}」，但这一轮已经结束了`);
    } else {
      // 着手 counts only after 这就 / 马上 / 接下来…: the lists hear no promise, and the ending goes through.
      expect(refused).toEqual([]);
      expect(h.messages(room).some((message) => message.body.includes("没有人接着做"))).toBe(false);
    }
  }
});

test("the model chosen for reading in Settings reads the lines, thinking as little as it lists; gone from its list, the default reads them", async () => {
  const h = await scenario({ holds: true });
  const fast = await h.store.createProvider({ name: "Fast", base_url: "http://127.0.0.1:2/v1", api_key: "fast",
    models: [{ name: "fast-reader", thinking_levels: ["high", "low", "none"] }] });
  // Only a model an endpoint lists may be chosen.
  await expect(h.store.patchSettings({ reader_model: { provider_id: fast.id, model: "elsewhere" } })).rejects.toThrow("reader_model");
  const settings = await h.store.patchSettings({ reader_model: { provider_id: fast.id, model: "fast-reader" } });
  expect(settings.reader_model).toEqual({ provider_id: fast.id, model: "fast-reader" });
  const asked: Array<{ model: string; baseUrl: string; thinkingLevel: string | undefined }> = [];
  h.judge("read_user_line").handle(({ request }) => {
    asked.push({ model: request.model, baseUrl: request.baseUrl, thinkingLevel: request.thinkingLevel });
    return NOTHING;
  });
  const [director] = h.createBots({ name: "视频导演", duties: "出片" });
  h.script(director!).handle(() => call(tool("end_turn", { reason: "nothing_new" })));
  h.postUser(h.direct(director!), "第二集分镜先做三镜");
  await h.waitIdle();
  expect(asked).toEqual([{ model: "fast-reader", baseUrl: "http://127.0.0.1:2/v1", thinkingLevel: "none" }]);
  // The endpoint no longer lists it: the setting reads as none, and the default model reads the next line.
  await h.store.patchProvider(fast.id, { models: [{ name: "other", thinking_levels: [] }] });
  expect((await h.store.settings()).reader_model).toBeNull();
  h.postUser(h.direct(director!), "第三镜也做了吧");
  await h.waitIdle();
  expect(asked.at(-1)).toEqual({ model: "scenario", baseUrl: "http://127.0.0.1:1/v1", thinkingLevel: "none" });
  // Following the default again.
  expect((await h.store.patchSettings({ reader_model: null })).reader_model).toBeNull();
});
