import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import type { ChatMessage, CompletionOk, CompletionsClient, JudgeRequest, JudgeResult } from "./completions";
import { SITUATION_HEADING } from "./context";
import { JUDGEMENT_SYSTEM } from "./prompts/judgement";
import { ORGANIZER_SYSTEM, type OrganizerPayload } from "./prompts/organizer";
import { memoryKeyStore } from "./secrets";
import { PLAN_MAP_FILE, Store, TICKET_FILE } from "./store";
import { createTurnEngine } from "./turn-engine";
import {
  createOrganizer,
  ORGANIZER_MAX_TOKENS,
  ORGANIZER_SETTLE_TIMEOUT_MS,
  ORGANIZER_TIMEOUT_MS,
} from "./organizer";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

/** What the organizer answers for a payload; null means the call itself fails. */
type Answer = (payload: OrganizerPayload) => string | null;

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

async function harness(
  answer: Answer,
  script: (messages: ChatMessage[]) => CompletionOk | Promise<CompletionOk> = () => say("初稿在 draft.md"),
) {
  const root = mkdtempSync(join(tmpdir(), "organizer-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: ChatMessage[][] = [];
  const organized: OrganizerPayload[] = [];
  const judgements: Array<Record<string, unknown>> = [];
  const events: ClientEvent[] = [];
  const waiters: Array<() => void> = [];
  store.onCommit((event) => events.push(event));
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish(event) {
      events.push(event);
      if (event.event === "turn.upsert" && event.status === "completed") for (const wake of waiters.splice(0)) wake();
    },
    completions: {
      async complete(request) {
        seen.push(request.messages);
        return script(request.messages);
      },
      async judge(request) {
        if (request.messages[0]?.content === ORGANIZER_SYSTEM) {
          const payload = JSON.parse(String(request.messages[1]!.content)) as OrganizerPayload;
          organized.push(payload);
          const content = answer(payload);
          if (content === null) throw new Error("organizer down");
          return judged(content);
        }
        if (request.messages[0]?.content === JUDGEMENT_SYSTEM) {
          judgements.push(JSON.parse(String(request.messages[1]!.content)) as Record<string, unknown>);
        }
        return judged('{"decision":"join","reason":"fixture"}');
      },
    },
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const completed = () => new Promise<void>((resolve) => waiters.push(resolve));
  const turnOf = (triggerId: string) =>
    store.db
      .query<{ id: string; task_id: string | null; ticket_id: string | null; status: string }, [string]>(
        "SELECT id, task_id, ticket_id, status FROM turns WHERE trigger_message_id = ? ORDER BY created_at ASC",
      )
      .all(triggerId);
  return { root, store, engine, seen, organized, judgements, events, completed, turnOf };
}

test("a user line is filed before its turn opens: the turn works in the ticket dir, sees the plan, the mirrors are written, and the quiet plan is settled", async () => {
  const h = await harness((payload) => {
    if (payload.mode === "message" && !payload.current_plan) {
      return JSON.stringify({
        decision: "new",
        plan: { kind: "周报", goal: "写一份周报", acceptance: ["交到 report.md"], rules: ["不要口语"] },
        tickets: [{ id: "new-1", title: "初稿", spec: "写出第一版", status: "doing", worker: "Writer" }],
        message_ticket: "new-1",
      });
    }
    const ticket = payload.current_plan!.tickets[0]!;
    if (payload.mode === "settle") {
      return JSON.stringify({
        decision: "continue",
        plan: { ...payload.current_plan!.spec, progress: { done: ["初稿"], open: [], blocked: [] } },
        tickets: [{ id: ticket.id, title: ticket.title, status: "review", worker: "Writer" }],
      });
    }
    return JSON.stringify({ decision: "continue", plan: payload.current_plan!.spec, tickets: [], message_ticket: ticket.id });
  });
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报，交到 report.md" });
  const first = h.completed();
  await h.engine.handleInboundMessage(trigger, { fromUser: true });
  await first;

  // Filed first, with nothing to continue; the plan, its ticket and the stamp on the message follow.
  expect(h.organized[0]).toMatchObject({ mode: "message", current_plan: null, message: { id: trigger.id, author: "user" } });
  const plan = h.store.sessionCurrentTask(session)!;
  expect(plan.dir).toMatch(/^work\/写一份周报-[0-9a-z]{4}$/);
  expect(plan.kind).toBe("周报");
  const ticket = h.store.listTickets(plan.id)[0]!;
  expect(ticket).toMatchObject({ seq: 1, title: "初稿", status: "doing", worker: writer.bot.id });
  expect(h.store.getMessage(trigger.id)).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
  const [turn] = h.turnOf(trigger.id);
  expect(turn).toMatchObject({ task_id: plan.id, ticket_id: ticket.id, status: "completed" });
  expect(h.store.turnWorkDir(turn!.id)).toBe(ticket.dir);
  expect(h.store.listMainMessages(session, 10).find((m) => m.body === "初稿在 draft.md")).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });

  // What the Bot saw: the plan's spec, its own ticket, and the folder it works in.
  const situation = textOf(h.seen[0]!.find((m) => m.role === "user" && textOf(m).startsWith(SITUATION_HEADING))!);
  expect(situation).toContain("规划「写一份周报」：写一份周报（周报，进行中）");
  expect(situation).toContain("验收：交到 report.md");
  expect(situation).toContain("规则：不要口语");
  expect(situation).toContain("本轮任务：01 初稿");
  expect(situation).toContain(`本轮任务目录：${ticket.dir}/（规划目录：${plan.dir}/）`);

  // The mirrors are on disk and are not artifacts.
  expect(readFileSync(join(h.root, plan.dir, PLAN_MAP_FILE), "utf8")).toContain("| 01 | 初稿 | 进行中 | Writer |");
  expect(readFileSync(join(h.root, ticket.dir, TICKET_FILE), "utf8")).toContain("# 01 初稿");
  expect(h.store.taskArtifacts(plan.id, () => true).map((row) => row.path)).not.toContain(`${plan.dir}/${PLAN_MAP_FILE}`);

  // Once the plan has been quiet, it is settled: the ticket moves to review and a second version names the turn.
  await until(() => h.store.getTicket(ticket.id).status === "review");
  expect(h.organized.find((payload) => payload.mode === "settle")).toMatchObject({ current_plan: { id: plan.id }, message: null });
  expect(h.store.listSpecRevisions(plan.id)[0]).toMatchObject({ revision: 2, actor: "app", source_turn_id: turn!.id, source_message_id: null });
  expect(readFileSync(join(h.root, plan.dir, PLAN_MAP_FILE), "utf8")).toContain("| 01 | 初稿 | 待验收 | Writer |");
  expect(h.events.filter((event) => event.event === "ticket.upsert").map((event) => (event as { status: string }).status)).toEqual(["doing", "review"]);

  // A follow-up is filed under the same plan and ticket, and its turn works in the same folder.
  const follow = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "再改一版" });
  const second = h.completed();
  await h.engine.handleInboundMessage(follow, { fromUser: true });
  await second;
  expect(h.organized.filter((payload) => payload.mode === "message")[1]).toMatchObject({ current_plan: { id: plan.id, revision: 2 } });
  expect(h.store.getMessage(follow.id)).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
  expect(h.turnOf(follow.id)[0]).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
  expect(h.store.sessionTasks(session)).toHaveLength(1);
});

test("a quiet plan runs its stale checks before the settle payload is built, and a check run through the engine (cause edit) publishes task.upsert with its result", async () => {
  const state: { checkId: string | null; sawRunBeforeSettlePayload: boolean | null } = { checkId: null, sawRunBeforeSettlePayload: null };
  let h: Awaited<ReturnType<typeof harness>>;
  h = await harness((payload) => {
    if (payload.mode === "settle" && state.checkId && state.sawRunBeforeSettlePayload === null) {
      // The whole point of the ordering: by the time the settle call is even built, `beforeSettle`
      // — awaited first in `quietStretch` — has already run the check and closed its run.
      state.sawRunBeforeSettlePayload = h.store.getCheck(state.checkId).last_run !== null;
    }
    if (payload.mode === "message" && !payload.current_plan) {
      return JSON.stringify({
        decision: "new",
        plan: { kind: "周报", goal: "写一份周报", acceptance: ["交到 report.md"], rules: [] },
        tickets: [{ id: "new-1", title: "初稿", spec: "写出第一版", status: "doing", worker: "Writer" }],
        message_ticket: "new-1",
      });
    }
    if (payload.mode === "settle") {
      return JSON.stringify({ decision: "continue", plan: payload.current_plan!.spec, tickets: [] });
    }
    return JSON.stringify({ decision: "continue", plan: payload.current_plan!.spec, tickets: [] });
  });
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报，交到 report.md" });
  const first = h.completed();
  await h.engine.handleInboundMessage(trigger, { fromUser: true });
  await first;

  const plan = h.store.sessionCurrentTask(session)!;
  // Created right after the turn ends and well inside the 20 ms quiet window: a check with no run
  // yet, on a file that is not there, so `checkStale` reads the plan as needing a run first.
  state.checkId = h.store.createCheckByUser(plan.id, { item: "交到 report.md", kind: "exists", path: "report.md" }).id;
  expect(h.store.checkStale(plan.id)).toBe(true);

  await until(() => h.organized.some((payload) => payload.mode === "settle"));
  expect(state.sawRunBeforeSettlePayload).toBe(true);
  expect(h.store.getCheck(state.checkId)!.last_run).toMatchObject({ outcome: "fail", cause: "settle" });

  // A second check, run directly through the engine the way the `POST /v1/checks` route does
  // (cause `edit`), publishes a `task.upsert` that carries its result.
  h.events.length = 0;
  const other = h.store.createCheckByUser(plan.id, { item: "另一条", kind: "command", command: "true" });
  await h.engine.runPlanChecks(plan.id, { cause: "edit", checkIds: [other.id] });
  expect(h.store.getCheck(other.id).last_run).toMatchObject({ outcome: "pass", cause: "edit" });
  const upserts = h.events.filter((event) => event.event === "task.upsert") as Array<{ checks?: Array<{ id: string; last_run: { outcome: string } | null }> }>;
  expect(upserts.length).toBeGreaterThan(0);
  const withResult = upserts.at(-1)!.checks?.find((row) => row.id === other.id);
  expect(withResult?.last_run).toMatchObject({ outcome: "pass" });
});

test("an organizer that answers nothing usable, or is down, changes nothing: the turn opens in a plan without a spec", async () => {
  let down = false;
  const h = await harness(() => (down ? null : "我不知道"));
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报，交到 report.md" });
  const first = h.completed();
  await h.engine.handleInboundMessage(trigger, { fromUser: true });
  await first;

  const plan = h.store.sessionCurrentTask(session)!;
  expect(plan.spec).toBeNull();
  expect(plan.brief).toBe("写一份周报，交到 report.md");
  expect(h.store.listTickets(plan.id)).toEqual([]);
  expect(h.store.listSpecRevisions(plan.id)).toEqual([]);
  const [turn] = h.turnOf(trigger.id);
  expect(turn).toMatchObject({ task_id: plan.id, ticket_id: null, status: "completed" });
  expect(h.store.turnWorkDir(turn!.id)).toBe(plan.dir);
  expect(existsSync(join(h.root, plan.dir, PLAN_MAP_FILE))).toBe(false);
  const situation = textOf(h.seen[0]!.find((m) => m.role === "user" && textOf(m).startsWith(SITUATION_HEADING))!);
  expect(situation).toContain("这是这件事的第一轮（规划「写一份周报，交到 report.md」）。");
  expect(situation).toContain(`本轮工作目录：${plan.dir}/`);
  expect(situation).not.toContain("规划「写一份周报，交到 report.md」：");

  // The call that failed outright is not billed; the one that answered is.
  down = true;
  const follow = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "再改一版" });
  const second = h.completed();
  await h.engine.handleInboundMessage(follow, { fromUser: true });
  await second;
  expect(h.organized).toHaveLength(2);
  expect(h.turnOf(follow.id)[0]).toMatchObject({ task_id: plan.id, ticket_id: null });
  expect(h.store.listSpend({ session_id: session }).filter((row) => row.kind === "organize")).toHaveLength(1);
});

test("in a group, every turn a filed line opens lands in its plan and ticket", async () => {
  const h = await harness((payload) =>
    payload.current_plan
      ? JSON.stringify({ decision: "continue", plan: payload.current_plan.spec, tickets: [] })
      : JSON.stringify({
          decision: "new",
          plan: { goal: "做一版海报" },
          tickets: [{ id: "new-1", title: "文案", status: "todo" }],
          message_ticket: "new-1",
        }),
  );
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
  const group = h.store.createGroup({ name: "海报组", members: [writer.bot.id, reviewer.bot.id] });
  const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "做一版海报，先出文案" });
  await h.engine.handleInboundMessage(trigger, { fromUser: true });
  await until(() => h.turnOf(trigger.id).filter((turn) => turn.status === "completed").length === 2);

  const plan = h.store.sessionCurrentTask(group.id)!;
  const ticket = h.store.listTickets(plan.id)[0]!;
  expect(ticket.title).toBe("文案");
  const turns = h.turnOf(trigger.id);
  expect(turns).toHaveLength(2);
  expect(turns.every((turn) => turn.task_id === plan.id && turn.ticket_id === ticket.id)).toBe(true);
  expect(h.organized.filter((payload) => payload.mode === "message")).toHaveLength(1);
  expect(h.store.getMessage(trigger.id)).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
  // The judges weigh the ticket the line was filed under, not a copy of it from before filing.
  expect(h.judgements.length).toBeGreaterThan(0);
  for (const judgement of h.judgements) {
    expect(judgement.plan).toMatchObject({ goal: "做一版海报", message_ticket: { seq: 1, title: "文案" } });
  }
});

/**
 * The Writer is drafting the group's report — its turn held mid-hop — when you tell it something
 * about that report in your direct. The organizer files the line under the group's plan, the
 * group turn hears it, and the turn in your direct knows the group already has it.
 */
async function reportInTheGroup(secondHop: "tool" | "done") {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The direct's turn stays live until the group turn is done, as it would with a slower model.
  let releaseDirect = () => {};
  const directHeld = new Promise<void>((resolve) => {
    releaseDirect = resolve;
  });
  let groupHops = 0;
  let heard = "";
  let directSituation = "";
  let groupSituation = "";
  const h = await harness(
    (payload) => {
      if (payload.mode === "settle") return null;
      if (payload.session.kind === "group") {
        return JSON.stringify({
          decision: "new",
          plan: { goal: "写一份周报", rules: ["不要口语"] },
          tickets: [{ id: "new-1", title: "初稿", status: "doing", worker: "Writer" }],
          message_ticket: "new-1",
        });
      }
      const report = payload.elsewhere_plans[0]!;
      return JSON.stringify({
        decision: "join",
        join_plan_id: report.id,
        plan: { ...report.spec, rules: [...report.spec!.rules, "标题别太长"] },
        tickets: [],
        message_ticket: report.tickets[0]!.id,
      });
    },
    async (messages) => {
      const situation = textOf(messages.find((m) => m.role === "user" && textOf(m).startsWith(SITUATION_HEADING))!);
      if (!situation.includes("在场成员")) {
        directSituation = situation;
        await directHeld;
        return say("收到，标题会短一些");
      }
      groupHops += 1;
      if (groupHops === 1) {
        await held;
        return secondHop === "tool" ? call("list_dir", { path: "." }) : say("初稿在 draft.md");
      }
      // Later group hops belong to the plan's own nudge once this turn ends with its ticket open.
      if (groupHops === 2) {
        heard = messages.filter((m) => m.role === "user").map(textOf).at(-1) ?? "";
        groupSituation = situation;
      }
      return say("初稿在 draft.md，标题改短了");
    },
  );
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
  const group = h.store.createGroup({ name: "周报组", members: [writer.bot.id, reviewer.bot.id] });
  const go = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 写一份周报" });
  void h.engine.handleInboundMessage(go, { fromUser: true });
  await until(() => groupHops === 1);
  const plan = h.store.sessionCurrentTask(group.id)!;
  const ticket = h.store.listTickets(plan.id)[0]!;
  const groupTurn = h.turnOf(go.id)[0]!;

  const aside = h.store.insertMessage({ sessionId: writer.direct_session.id, kind: "user", author: "user", body: "周报标题别太长" });
  await h.engine.handleInboundMessage(aside, { fromUser: true });
  await until(() => directSituation !== "");
  release();
  await until(() => h.store.getTurn(groupTurn.id).status === "completed");
  releaseDirect();
  await until(() => h.turnOf(aside.id)[0]?.status === "completed");
  await Bun.sleep(30);
  return {
    h,
    group,
    plan,
    ticket,
    groupTurn,
    aside,
    heard: () => heard,
    directSituation: () => directSituation,
    groupSituation: () => groupSituation,
    groupHops: () => groupHops,
  };
}

test("a line in your direct about the job a Bot is doing in a group is filed there, the group's turn hears it, and the direct's turn leaves the work to it", async () => {
  const { h, group, plan, ticket, groupTurn, aside, heard, directSituation, groupSituation } = await reportInTheGroup("tool");
  // Filed under the group's plan and ticket; the direct keeps no plan of its own.
  expect(h.store.getMessage(aside.id)).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
  expect(h.turnOf(aside.id)[0]).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
  expect(h.store.sessionCurrentTask(group.id)?.id).toBe(plan.id);
  expect(h.store.getTask(plan.id).session_id).toBe(group.id);
  const parsed = JSON.parse(h.store.getTask(plan.id).spec!) as { rules: string[] };
  expect(parsed.rules).toEqual(["不要口语", "标题别太长"]);

  // The group turn read it on its next hop, from where it was said.
  expect(heard()).toContain("你这一轮干活时有人找你");
  expect(heard()).toContain("【user，在你和用户的私聊里】周报标题别太长");
  expect(h.turnOf(aside.id)).toHaveLength(1);
  expect(h.store.getTurn(groupTurn.id).status).toBe("completed");

  // The direct's turn saw the group's job and was told its own group turn has the line.
  expect(directSituation()).toContain("规划「写一份周报」：写一份周报");
  expect(directSituation()).toContain("这件事是在群「周报组」里开的。");
  expect(directSituation()).toContain("这件事别处进行中的轮：你（群「周报组」）。");
  expect(directSituation()).toContain("触发这一轮的那句已经转给了你。你在那边的那一轮也收到了");

  // The group turn sees the direct's turn on the same job, but its own opening line went to nobody.
  expect(groupSituation()).toContain("这件事别处进行中的轮：你（你和用户的私聊）。");
  expect(groupSituation()).not.toContain("触发这一轮的那句");
});

test("a group turn that ends before reading your line from elsewhere opens no turn for it there", async () => {
  const { h, group, aside, groupTurn } = await reportInTheGroup("done");
  // The line was answered in your direct; the group opens nothing on it.
  const onAside = h.store.db
    .query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND trigger_message_id = ?")
    .get(group.id, aside.id)!;
  expect(onAside.n).toBe(0);
  expect(h.store.getTurn(groupTurn.id).status).toBe("completed");
});

function call(name: string, args: Record<string, unknown>): CompletionOk {
  return { ok: true, content: "", toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

/** A two-ticket plan, the Writer's in progress and the Reviewer's to do; a settle changes nothing. */
function twoTickets(payload: OrganizerPayload): string {
  if (payload.mode === "message" && !payload.current_plan) {
    return JSON.stringify({
      decision: "new",
      plan: { kind: "周报", goal: "写一份周报", acceptance: ["交到 report.md"] },
      tickets: [
        { id: "new-1", title: "初稿", spec: "写出第一版", status: "doing", worker: "Writer" },
        { id: "new-2", title: "审稿", spec: "过一遍", status: "todo", worker: "Reviewer" },
      ],
      message_ticket: "new-1",
    });
  }
  return JSON.stringify({ decision: "continue", plan: payload.current_plan!.spec, tickets: [] });
}

test("a plan that goes quiet with tickets open calls one Bot back; when nothing moves after that, you are told once", async () => {
  const h = await harness(twoTickets);
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
  const group = h.store.createGroup({ name: "周报组", members: [writer.bot.id, reviewer.bot.id] });
  const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 写一份周报" });
  await h.engine.handleInboundMessage(trigger, { fromUser: true });

  const nudges = () =>
    h.store.db
      .query<{ id: string; bot_id: string; ticket_id: string | null; fired_turn_id: string | null; note: string }, []>(
        "SELECT id, bot_id, ticket_id, fired_turn_id, note FROM check_backs WHERE kind = 'plan_nudge'",
      )
      .all();
  await until(() => nudges().length === 1 && nudges()[0]!.fired_turn_id !== null);
  const plan = h.store.sessionCurrentTask(group.id)!;
  const [draft, review] = h.store.listTickets(plan.id);
  const nudge = nudges()[0]!;
  // The Bot on the first open ticket is called back, into that ticket, with every open ticket named.
  expect(nudge).toMatchObject({ bot_id: writer.bot.id, ticket_id: draft!.id });
  expect(nudge.note).toContain("01《初稿》（进行中，Writer）");
  expect(nudge.note).toContain("02《审稿》（待做，Reviewer）");
  const woken = h.store.getTurn(nudge.fired_turn_id!);
  expect(woken).toMatchObject({ bot_id: writer.bot.id, task_id: plan.id, ticket_id: draft!.id });
  expect(h.store.getMessage(woken.trigger_message_id).body).toStartWith("回看：规划静下来了");

  // The call-back handed nothing over and no ticket moved: the session says so, and you get one notification.
  await until(() => h.store.listMainMessages(group.id, 20).some((m) => m.kind === "system" && m.body.startsWith("这件事停下了")));
  const stalled = h.store.listMainMessages(group.id, 20).find((m) => m.body.startsWith("这件事停下了"))!;
  expect(stalled.body).toContain("已经叫过Writer一次");
  const notice = h.store.db
    .query<{ kind: string; fail_kind: string | null; message_id: string | null }, [string]>(
      "SELECT kind, fail_kind, message_id FROM notifications WHERE semantic_key = ?",
    )
    .get(`stalled:${nudge.id}`);
  expect(notice).toMatchObject({ kind: "failure", fail_kind: "stalled_plan", message_id: stalled.id });
  await Bun.sleep(150);
  expect(nudges()).toHaveLength(1);
  expect(h.store.listMainMessages(group.id, 30).filter((m) => m.body.startsWith("这件事停下了"))).toHaveLength(1);
  expect(h.store.getTicket(review!.id).status).toBe("todo");
});

test("a turn filed under a ticket moves it to doing when it starts writing and to review when it hands the files over", async () => {
  let hop = 0;
  const h = await harness(
    (payload) =>
      payload.current_plan
        ? JSON.stringify({ decision: "continue", plan: payload.current_plan.spec, tickets: [] })
        : JSON.stringify({
            decision: "new",
            plan: { goal: "写一份周报" },
            tickets: [{ id: "new-1", title: "初稿", status: "todo", worker: "Writer" }],
            message_ticket: "new-1",
          }),
    () => {
      hop += 1;
      return hop === 1 ? call("shell", { command: "printf draft > draft.md" }) : say("初稿在 draft.md");
    },
  );
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报" });
  const done = h.completed();
  await h.engine.handleInboundMessage(trigger, { fromUser: true });
  await done;
  const plan = h.store.sessionCurrentTask(session)!;
  const ticket = h.store.listTickets(plan.id)[0]!;
  expect(ticket).toMatchObject({ status: "review", worker: writer.bot.id });
  expect(
    h.events
      .filter((event) => event.event === "ticket.upsert")
      .map((event) => (event as { status: string }).status)
      .filter((status, i, all) => all[i - 1] !== status),
  ).toEqual(["todo", "doing", "review"]);
  // What it ran is on record for the closing check and the organizer.
  const [turn] = h.turnOf(trigger.id);
  expect(h.store.turnRuns(turn!.id)).toMatchObject([{ tool: "shell", command: "printf draft > draft.md", exit_code: 0, ok: 1, ticket_id: ticket.id }]);
  expect(readFileSync(join(h.root, plan.dir, PLAN_MAP_FILE), "utf8")).toContain("| 01 | 初稿 | 待验收 | Writer |");
});

/** The organizer alone, over a store, answering each call with the next of `answers`. */
function bareOrganizer(answers: Array<JudgeResult | Error>) {
  const store = new Store();
  const requests: JudgeRequest[] = [];
  const lines: string[] = [];
  const completions = {
    async complete() {
      throw new Error("the organizer never streams");
    },
    async judge(request: JudgeRequest) {
      requests.push(request);
      const next = answers.shift();
      if (!next) throw new Error("no answer scripted");
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as CompletionsClient;
  const organizer = createOrganizer({
    store,
    completions,
    routing: async () => ({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture",
      providerId: "p",
      providerName: "fixture",
      model: "fixture",
      thinkingLevel: null,
    }),
    recordSpend: () => {},
    draining: () => false,
    log: (line) => lines.push(line),
  });
  closes.push(async () => {
    organizer.clearTimers();
    store.close();
  });
  return { store, organizer, requests, lines };
}

test("the organizer asks for room for a whole plan, a minute for a line and longer to settle", async () => {
  // Every real answer was cut at a verdict's 256 tokens, mid-JSON, so no plan was ever filed; and a
  // reasoning model's first word came at nineteen seconds against a twenty-second limit.
  const h = bareOrganizer([judged("我不知道"), judged("我不知道")]);
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const plan = h.store.openTask({ sessionId: session, title: "写一份周报" });
  // Opened a minute ago, so the line below is news to it.
  h.store.db.run("UPDATE tasks SET created_at = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), plan.id]);
  const line = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报" });
  await h.organizer.organizeMessage(line);
  expect(await h.organizer.settlePlan(plan.id)).toBe(false);
  expect(h.requests.map((request) => [request.maxTokens, request.timeoutMs])).toEqual([
    [ORGANIZER_MAX_TOKENS, ORGANIZER_TIMEOUT_MS],
    [ORGANIZER_MAX_TOKENS, ORGANIZER_SETTLE_TIMEOUT_MS],
  ]);
  expect(ORGANIZER_MAX_TOKENS).toBeGreaterThanOrEqual(2048);
  expect(ORGANIZER_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
});

test("a filing that comes to nothing files nothing and says why: cut off, unreadable, failed, thrown", async () => {
  // A cut-off plan would parse if it happened to close its braces; it is refused all the same.
  const cut = { ...judged('{"decision":"new","plan":{"goal":"写周报"}}'), truncated: true };
  const failed: JudgeResult = { ...judged(""), content: null, failKind: "first_byte" };
  const h = bareOrganizer([cut, judged("我不知道"), failed, new Error("socket hang up")]);
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  for (const body of ["一", "二", "三", "四"]) {
    const line = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body });
    expect(await h.organizer.organizeMessage(line)).toEqual({ taskId: null, ticketId: null });
  }
  expect(h.store.sessionCurrentTask(session)).toBeNull();
  expect(h.lines).toHaveLength(4);
  expect(h.lines[0]).toContain(`${ORGANIZER_MAX_TOKENS}-token cap`);
  expect(h.lines[1]).toContain("did not read as a plan");
  expect(h.lines[2]).toContain("first_byte");
  expect(h.lines[3]).toContain("socket hang up");
  for (const text of h.lines) expect(text).toMatch(/^\[organizer\] filing message /);
});

test("the organizer is shown the newest of what happened, oldest first", () => {
  // With no revision yet, "since" is the plan's start; taking the oldest rows froze the window at
  // the plan's first hour, and the line you just sent never reached the organizer.
  const store = new Store();
  closes.push(async () => store.close());
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const plan = store.openTask({ sessionId: session, title: "长的一件事" });
  const bodies = ["第一句", "第二句", "第三句", "第四句"];
  for (const [index, body] of bodies.entries()) {
    const row = store.insertMessage({ sessionId: session, kind: "user", author: "user", body });
    store.db.run("UPDATE messages SET created_at = ?, task_id = ? WHERE id = ?", [
      `2026-09-25T00:00:0${index}.000Z`,
      plan.id,
      row.id,
    ]);
  }
  expect(store.taskMessagesSince(plan.id, "", 2).map((row) => row.body)).toEqual(["第三句", "第四句"]);
  expect(store.taskMessagesSince(plan.id, "", 10).map((row) => row.body)).toEqual(bodies);
});
