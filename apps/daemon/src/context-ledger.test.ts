/**
 * The user's words and the requirements ledger in the situation block (ADR 0040 P3): the quote
 * layer — the first 4 and the latest 6 lines of the user's filed under the plan — in every turn
 * bound to the plan, wherever it runs (a group, a Bot↔Bot direct, a check-back, a routine), and the
 * requirements section: nearest first, everything said twice, the rest within a budget, proposed
 * and unverified entries apart, inherited entries named by the plan that set them. Precedents no
 * longer feed it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import type { ChatMessage } from "./completions";
import { assembleTurnMessages, QUOTE_LAYER_HEAD, QUOTE_LAYER_TAIL, REQUIREMENT_LINES, SITUATION_HEADING } from "./context";
import { Store, type PlanSpec } from "./store";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function spec(goal: string, over: Partial<PlanSpec> = {}): PlanSpec {
  return { kind: "动画成片", goal, acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active", ...over };
}

function situationOf(messages: ChatMessage[]): string {
  const block = messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SITUATION_HEADING));
  return String(block?.content ?? "");
}

/** The video group with EP01 open in it; the user's lines filed under a plan. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "context-ledger-"));
  roots.push(root);
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "stay" }).bot;
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "stay" }).bot;
  const room = store.createGroup({ name: "AI影视创作组", members: [director.id, reviewer.id] }).id;
  const ep01 = store.openTask({ sessionId: room, title: "EP01 动画成片", spec: spec("EP01 动画成片") });
  const say = (taskId: string, body: string, sessionId = room) => {
    const line = store.postMessage(sessionId, { body });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [taskId, line.id]);
    return line;
  };
  const situation = (input: { sessionId: string; botId: string; triggerId: string; taskId: string; ticketId?: string; locale?: "zh" | "en" }) => {
    const turn = store.createTurn({ sessionId: input.sessionId, botId: input.botId, triggerMessageId: input.triggerId, taskId: input.taskId, ticketId: input.ticketId });
    return situationOf(
      assembleTurnMessages(store, {
        sessionId: input.sessionId,
        botId: input.botId,
        turnId: turn.id,
        triggerMessageId: input.triggerId,
        locale: input.locale ?? "zh",
        interrupt: false,
        loop: [],
      }),
    );
  };
  return { store, room, director, reviewer, ep01, say, situation };
}

describe("the quote layer", () => {
  test("the first 4 and the latest 6 of the user's lines, with how many between, in every turn bound to the plan", () => {
    const { store, room, director, reviewer, ep01, say, situation } = fixture();
    const lines = Array.from({ length: 13 }, (_, i) => say(ep01.id, `第 ${i + 1} 句要求`));
    // An erased line is not shown, and does not count.
    store.db.run(`UPDATE user_quotes SET body = '', redacted_at = ? WHERE message_id = ?`, [new Date().toISOString(), lines[12]!.id]);
    // An answer and a board line are the user's words too, said where they were said.
    store.setPlanSpecByUser(ep01.id, spec("EP01 动画成片", { rules: ["仓门朝左开"] }));

    const expected = (block: string) => {
      expect(block).toContain(`用户在这件事里的话（原文，最早 ${QUOTE_LAYER_HEAD} 条和最新 ${QUOTE_LAYER_TAIL} 条）：`);
      for (const n of [1, 2, 3, 4, 8, 9, 10, 11, 12]) expect(block).toMatch(new RegExp(`- \\d\\d-\\d\\d \\d\\d:\\d\\d 在[^：\\n]+：第 ${n} 句要求\\n`));
      for (const n of [5, 6, 7, 13]) expect(block).not.toContain(`第 ${n} 句要求`);
      expect(block).toContain("- …中间还有 3 条");
      expect(block).toMatch(/- \d\d-\d\d \d\d:\d\d 在流程图写：仓门朝左开/);
    };

    // In the group.
    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 继续" });
    const group = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id });
    expected(group);
    expect(group).toContain("：第 1 句要求");
    expect(group).toMatch(/在群「AI影视创作组」：第 1 句要求/);

    // In a Bot↔Bot direct, where no line of the user's is in the transcript.
    const dm = store.createBotDirect(director.id, reviewer.id, { sessionId: room, messageId: trigger.id });
    const relay = store.insertMessage({ sessionId: dm.id, kind: "bot", author: director.id, body: "Shot 11 帮我看看" });
    expected(situation({ sessionId: dm.id, botId: reviewer.id, triggerId: relay.id, taskId: ep01.id }));

    // A check-back, woken by the app's line in the Bot's direct with the user.
    const direct = store.findDirectSession(USER_MEMBER, director.id)!.id;
    const due = store.insertMessage({ sessionId: direct, kind: "system", author: USER_MEMBER, body: "回看：Shot 11 渲染好了没" });
    expected(situation({ sessionId: direct, botId: director.id, triggerId: due.id, taskId: ep01.id }));

    // A routine's turn filed under the plan.
    const routine = store.createRoutine({ bot_id: director.id, title: "每日进度", instruction: "汇报 EP01 进度", schedule: { kind: "daily", time: "09:00" } });
    const fired = store.insertMessage({ sessionId: direct, kind: "system", author: USER_MEMBER, body: "日程：每日进度" });
    const turn = store.createTurn({ sessionId: direct, botId: director.id, triggerMessageId: fired.id, taskId: ep01.id, routineId: routine.id });
    expected(situationOf(assembleTurnMessages(store, { sessionId: direct, botId: director.id, turnId: turn.id, triggerMessageId: fired.id, locale: "zh", interrupt: false, loop: [] })));
    store.close();
  });

  test("a line you changed shows as sent, and the words you changed as changed where you said it (ADR 0063)", () => {
    const { store, room, director, ep01, say, situation } = fixture();
    const line = say(ep01.id, "片长约 2 分钟，机械臂是左手");
    store.editMessage(line.id, { body: "片长约 3 分钟，机械臂是左手", userActionId: "layer" });
    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 继续" });
    const zh = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id });
    expect(zh).toContain("在群「AI影视创作组」：片长约 2 分钟，机械臂是左手");
    expect(zh).toContain("在群「AI影视创作组」改了一句：片长约 3 分钟");
    const en = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id, locale: "en" });
    expect(en).toContain('changed a line in group "AI影视创作组": 片长约 3 分钟');
    store.close();
  });

  test("a short job lists all of it, in English too; nothing kept, no layer", () => {
    const { store, room, director, ep01, say, situation } = fixture();
    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 开工" });
    expect(situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id })).not.toContain("用户在这件事里的话");
    say(ep01.id, "片长约 2 分钟，机械臂是左手");
    const zh = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id });
    expect(zh).toContain("用户在这件事里的话（原文）：\n- ");
    expect(zh).toContain("在群「AI影视创作组」：片长约 2 分钟，机械臂是左手");
    const en = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id, locale: "en" });
    expect(en).toContain('What the user said in this job (verbatim):\n- ');
    expect(en).toContain('in group "AI影视创作组": 片长约 2 分钟，机械臂是左手');
    store.close();
  });
});

describe("the requirements section", () => {
  test("nearest first, counted, with where each holds and the check on its number; proposed and old rules apart; set-aside ones gone", () => {
    const { store, room, director, ep01, say, situation } = fixture();
    const ticket = store.createTicket({ taskId: ep01.id, title: "Shot 01–03" });
    const other = store.createTicket({ taskId: ep01.id, title: "Shot 11" });
    const quoteOf = (body: string) => store.quoteOfMessage(say(ep01.id, body).id, "message")!;
    const add = (body: string, over: Partial<Parameters<Store["addRequirement"]>[0]> = {}) =>
      store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: body, sourceKind: "message", sourceQuoteId: quoteOf(body).id, addedBy: "scribe", ...over });
    const running = add("片长约 2 分钟", { restated: "母带约 120 秒" });
    store.raiseRequirement(running.id, { quoteId: quoteOf("片长还是约 2 分钟").id, actor: "scribe" });
    const shots = add("前三镜背景严重跳跃", { scope: "ticket", scopeId: ticket.id, restated: "前三镜背景要连贯" });
    const shot11 = add("Shot 11 要夜景", { scope: "ticket", scopeId: other.id });
    const arm = add("机械臂必须是左手", { scope: "project", scopeId: room });
    const aside = add("字幕用白色", { scope: "project", scopeId: room });
    store.setRequirementHere(aside.id, { taskId: ep01.id, holds: false });
    // Your 「约 2 分钟」 offered as a check, before the change came.
    store.syncDerivedChecks(ep01.id);
    const change = add("改成 3 分钟", { status: "proposed", supersedes: running.id });
    store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "用户要求这条短片接着做完", sourceKind: "legacy", addedBy: "import", status: "unverified" });

    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 继续" });
    const block = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id, ticketId: ticket.id });
    const section = block.slice(block.indexOf("用户要求（按适用范围由近到远）："));
    const rows = section.split("\n").slice(1, 5);
    expect(rows).toEqual([
      `- R-${shots.seq}｜「前三镜背景严重跳跃」（转述：前三镜背景要连贯）｜适用：任务 01 Shot 01–03`,
      `- R-${running.seq}｜「片长约 2 分钟」（转述：母带约 120 秒）｜用户已说 2 次｜适用：这件事｜挂检查：时长 108–132 秒（待用户确认）`,
      `- R-${shot11.seq}｜「Shot 11 要夜景」｜适用：任务 02 Shot 11`,
      `- R-${arm.seq}｜「机械臂必须是左手」｜适用：这个会话的每件事`,
    ]);
    // Set not to hold for EP01: the words stay in the quote layer, the entry is not listed.
    expect(block).not.toContain(`R-${aside.seq}｜`);
    expect(block).toContain(`待用户确认的取代或建议（还没生效，不要当要求执行）：\n- R-${change.seq}｜「改成 3 分钟」｜要取代 R-${running.seq}「片长约 2 分钟」｜适用：这件事`);
    expect(block).toContain("旧规则（出处未核实，只作参考）：\n- R-");
    expect(block).toContain("「用户要求这条短片接着做完」｜适用：这件事");
    // The user's words and asks come before the checks and the tickets.
    expect(block.indexOf("用户要求（")).toBeLessThan(block.indexOf("验收检查"));
    expect(block.indexOf("用户在这件事里的话")).toBeLessThan(block.indexOf("用户要求（"));

    const en = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id, ticketId: ticket.id, locale: "en" });
    expect(en).toContain(`- R-${running.seq} | "片长约 2 分钟" (restated: 母带约 120 秒) | the user said it 2 times | holds for: this job | check: Running time 108–132 s (waiting for the user to confirm)`);
    expect(en).toContain("Old rules (source unverified; for reference only):");
    store.close();
  });

  test("an entry set in another plan of the conversation reads as inherited, and counts the plans it was said in", () => {
    const { store, room, director, ep01, say, situation } = fixture();
    const quote = store.quoteOfMessage(say(ep01.id, "每次过门都要有过渡镜头").id, "message")!;
    const transition = store.addRequirement({ scope: "project", scopeId: room, quote: "每次过门都要有过渡镜头", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "scribe" });
    const film = store.openTask({ sessionId: room, title: "9AG7 未来世界短片", spec: spec("9AG7 未来世界短片") });
    const again = store.quoteOfMessage(say(film.id, "过门还是要有过渡镜头").id, "message")!;
    store.raiseRequirement(transition.id, { quoteId: again.id, actor: "scribe" });
    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 开工" });
    expect(situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: film.id })).toContain(
      `- R-${transition.seq}｜「每次过门都要有过渡镜头」｜用户已说 2 次（跨 2 个规划）｜适用：这个会话的每件事（继承自「EP01 动画成片」）`,
    );
    store.close();
  });

  test("everything said twice is listed; of the rest, at most REQUIREMENT_LINES, and how many more", () => {
    const { store, room, director, ep01, say, situation } = fixture();
    const quoteOf = (body: string) => store.quoteOfMessage(say(ep01.id, body).id, "message")!;
    const twice = Array.from({ length: 3 }, (_, i) => {
      const entry = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: `重要要求 ${i}`, sourceKind: "message", sourceQuoteId: quoteOf(`重要要求 ${i}`).id, addedBy: "scribe" });
      store.raiseRequirement(entry.id, { quoteId: quoteOf(`再说一次重要要求 ${i}`).id, actor: "scribe" });
      return entry;
    });
    for (let i = 0; i < REQUIREMENT_LINES + 5; i++) {
      store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: `一般要求 ${i}`, sourceKind: "board", addedBy: "user" });
    }
    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 开工" });
    const block = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id });
    for (const entry of twice) expect(block).toContain(`R-${entry.seq}｜「${entry.quote}」｜用户已说 2 次`);
    expect(block.match(/「一般要求 \d+」/g)).toHaveLength(REQUIREMENT_LINES);
    expect(block).toContain("- …还有 5 条");
    store.close();
  });

  test("a turn a stop holds reads what the user said and asked as it stood when the stop was made", () => {
    const { store, room, director, reviewer, ep01, say } = fixture();
    const quoteOf = (body: string, sessionId = room) => store.quoteOfMessage(say(ep01.id, body, sessionId).id, "message")!;
    const before = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "片尾字幕用黑色", sourceKind: "message", sourceQuoteId: quoteOf("片尾字幕用黑色").id, addedBy: "scribe" });
    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 开工" });
    const turn = store.createTurn({ sessionId: room, botId: director.id, triggerMessageId: trigger.id, taskId: ep01.id });
    const block = () =>
      situationOf(assembleTurnMessages(store, { sessionId: room, botId: director.id, turnId: turn.id, triggerMessageId: trigger.id, locale: "zh", interrupt: false, loop: [] }));
    store.raiseEngineLevel(null);
    const stop = store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    // Said after the stop, in your direct with 审片员 (so not in this turn's transcript): a line, and
    // the entry the scribe made of it.
    const dm = store.findDirectSession(USER_MEMBER, reviewer.id)!.id;
    const after = store.addRequirement({
      scope: "plan",
      scopeId: ep01.id,
      quote: "片尾字幕换成白色",
      sourceKind: "message",
      sourceQuoteId: quoteOf("片尾字幕换成白色", dm).id,
      addedBy: "scribe",
    });

    const held = block();
    expect(held).toContain(`R-${before.seq}｜「片尾字幕用黑色」`);
    expect(held).not.toContain("片尾字幕换成白色");
    store.liftHold(stop.id, { by: "user_button" });
    const lifted = block();
    expect(lifted).toMatch(/- \d\d-\d\d \d\d:\d\d 在[^：\n]+：片尾字幕换成白色/);
    expect(lifted).toContain(`R-${after.seq}｜「片尾字幕换成白色」`);
    store.close();
  });

  test("a finished plan of the same kind no longer shows as a precedent", () => {
    const { store, room, director, ep01, situation } = fixture();
    const earlier = store.openTask({ sessionId: room, title: "EP00 试片", spec: spec("EP00 试片", { rules: ["旧片的规则"], status: "done" }) });
    store.db.run(`UPDATE tasks SET status = 'done', closed_at = ? WHERE id = ?`, [new Date().toISOString(), earlier.id]);
    store.db.run(`UPDATE tasks SET closed_at = NULL WHERE id = ?`, [ep01.id]);
    const trigger = store.insertMessage({ sessionId: room, kind: "user", author: USER_MEMBER, body: "@视频导演 开工" });
    const block = situation({ sessionId: room, botId: director.id, triggerId: trigger.id, taskId: ep01.id });
    expect(block).not.toContain("先例");
    expect(block).not.toContain("旧片的规则");
    store.close();
  });
});
