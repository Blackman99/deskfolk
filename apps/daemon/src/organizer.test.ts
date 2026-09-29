import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import type { ChatMessage, CompletionOk, CompletionsClient, JudgeRequest, JudgeResult } from "./completions";
import { SITUATION_HEADING } from "./context";
import { createPlanWatch } from "./engine/plan-watch";
import { JUDGEMENT_SYSTEM } from "./prompts/judgement";
import { ORGANIZER_SYSTEM, type OrganizerPayload } from "./prompts/organizer";
import { memoryKeyStore } from "./secrets";
import { PLAN_MAP_FILE, Store, TICKET_FILE } from "./store";
import { PLAN_NUDGES_UNANSWERED_MAX } from "./engine/plan-watch";
import { createTurnEngine } from "./turn-engine";
import {
  asksToStop,
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

/** `createPlanWatch` alone, over a real store: reconcile's nudge/stall/budget logic tested synchronously, without a real turn or timer. */
function barePlanWatch() {
  const store = new Store();
  const published: string[] = [];
  const fired: string[] = [];
  const planWatch = createPlanWatch({
    store,
    admission: undefined,
    publishMessage: (message) => published.push(message.body),
    renderMirrors: () => {},
    fireCheckBack: (id) => {
      fired.push(id);
      // The real engine wakes a turn on the check-back, which claims it; a plan with one still
      // pending is left alone by the next reconcile (`pendingPlanCheckBacks`), so this fake must
      // claim it too or every call after the first would silently no-op.
      store.claimCheckBack(id);
      return null;
    },
  });
  const root = mkdtempSync(join(tmpdir(), "plan-watch-"));
  store.patchSettingsSync({ workspace_path: root });
  closes.push(async () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, planWatch, published, fired };
}

function planNudges(store: InstanceType<typeof Store>, taskId: string): Array<{ id: string; bot_id: string; note: string; created_at: string }> {
  return store.db
    .query<{ id: string; bot_id: string; note: string; created_at: string }, [string]>(
      `SELECT id, bot_id, note, created_at FROM check_backs WHERE task_id = ? AND kind = 'plan_nudge' ORDER BY created_at ASC, rowid ASC`,
    )
    .all(taskId);
}

async function harness(
  answer: Answer,
  script: (messages: ChatMessage[]) => CompletionOk | Promise<CompletionOk> = () => say("初稿在 draft.md"),
  options: { planLeftQuietMs?: number } = {},
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
    planLeftQuietMs: options.planLeftQuietMs ?? 30,
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
  // A job handed over with nothing left in its progress waits for you: nobody is called back.
  await Bun.sleep(60);
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM check_backs WHERE kind = 'plan_nudge'").get()).toEqual({ n: 0 });

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

test("an organizer-added check runs after the settle, holding a `done` open; exactly one evidence settle follows and lets it through once the check has passed", async () => {
  let ticketId: string | null = null;
  let hop = 0;
  const h = await harness((payload) => {
    if (payload.mode === "message" && !payload.current_plan) {
      return JSON.stringify({
        decision: "new",
        plan: { kind: "周报", goal: "写一份周报", acceptance: ["交到 report.md"] },
        tickets: [{ id: "new-1", title: "初稿", spec: "", status: "doing", worker: "Writer" }],
        message_ticket: "new-1",
      });
    }
    // Every settle call — the regular one, and the evidence follow-up after the check runs — says
    // the same thing: done, with the check it proposed. The evidence call's `checks` is ignored by
    // the engine regardless, so returning it again here is harmless.
    if (payload.mode === "settle") {
      ticketId = payload.current_plan!.tickets[0]!.id;
      return JSON.stringify({
        decision: "continue",
        plan: { ...payload.current_plan!.spec, status: "done" },
        tickets: [{ id: ticketId, status: "done" }],
        // Copied with the same cwd the Bot's own run used (`commandSeenInPlan` matches on both).
        checks: [{ id: "new-1", item: "交到 report.md", kind: "command", command: "true", cwd: "." }],
      });
    }
    return JSON.stringify({ decision: "continue", plan: payload.current_plan!.spec, tickets: [] });
  }, () => {
    hop += 1;
    return hop === 1 ? call("shell", { command: "true", cwd: "." }) : say("初稿在 draft.md");
  });
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报，交到 report.md" });
  const first = h.completed();
  await h.engine.handleInboundMessage(trigger, { fromUser: true });
  await first;
  const plan = h.store.sessionCurrentTask(session)!;

  // The first settle: `done`, plus a brand-new check nobody has run yet — so `done` is held open,
  // for lack of evidence alone (not a failure), and the check runs once `afterSettle` catches it.
  await until(() => h.store.listChecks(plan.id).length === 1);
  const [check] = h.store.listChecks(plan.id);
  expect(check).toMatchObject({ source: "organizer", command: "true" });
  await until(() => h.store.getCheck(check!.id).last_run !== null);
  expect(h.store.getCheck(check!.id).last_run).toMatchObject({ outcome: "pass", cause: "settle" });

  // Exactly one evidence settle follows, and it is the one that lets `done` through.
  await until(() => h.store.getTask(plan.id).status === "done");
  expect(h.organized.filter((payload) => payload.mode === "settle")).toHaveLength(2);
  await Bun.sleep(80);
  expect(h.organized.filter((payload) => payload.mode === "settle")).toHaveLength(2);
  expect(h.store.getTicket(ticketId!).status).toBe("done");
});

test("a command the organizer invents out of thin air — nobody ran it, nobody typed it — is dropped, not proposed as a check", async () => {
  const h = await harness((payload) => {
    if (payload.mode === "message" && !payload.current_plan) {
      return JSON.stringify({
        decision: "new",
        plan: { kind: "周报", goal: "写一份周报", acceptance: ["交到 report.md"] },
        tickets: [{ id: "new-1", title: "初稿", spec: "", status: "doing", worker: "Writer" }],
        message_ticket: "new-1",
      });
    }
    if (payload.mode === "settle") {
      return JSON.stringify({
        decision: "continue",
        plan: payload.current_plan!.spec,
        tickets: [],
        checks: [{ id: "new-1", item: "交到 report.md", kind: "command", command: "rm -rf build" }],
      });
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
  await until(() => h.organized.some((payload) => payload.mode === "settle"));
  await Bun.sleep(80);
  expect(h.store.listChecks(plan.id)).toEqual([]);
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

test("a failing check alone (no open ticket) still calls its ticket's worker back, and the note carries the check's own output tail", () => {
  const { store, planWatch, fired } = barePlanWatch();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const plan = store.openTask({ sessionId: session, title: "写周报" });
  // Handed over already (not "open"): only the failing check is left to reconcile about.
  const ticket = store.createTicket({ taskId: plan.id, title: "初稿", status: "done", worker: writer.bot.id });
  const check = store.createCheckByUser(plan.id, { item: "交到 report.md", ticket_id: ticket.id, kind: "command", command: "false" });
  const run = store.beginCheckRun(check.id, "user");
  store.finishCheckRun(run.id, { outcome: "fail", exitCode: 1, detail: "退出码 1，应为 0", output: "boom\nnot ok" });

  planWatch.reconcilePlan(plan.id);
  expect(fired).toHaveLength(1);
  const [nudge] = planNudges(store, plan.id);
  expect(nudge).toMatchObject({ bot_id: writer.bot.id });
  expect(nudge!.note).toContain("还有验收检查没过（应用自己在本机跑的）");
  expect(nudge!.note).toContain("「交到 report.md」——命令：false：退出码 1，应为 0");
  expect(nudge!.note).toContain("boom");
  expect(nudge!.note).toContain("修交付物，不是改检查");
});

test("no ticket open and no check failing: nothing to reconcile", () => {
  const { store, planWatch, fired } = barePlanWatch();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const plan = store.openTask({ sessionId: writer.direct_session.id, title: "写周报" });
  store.createTicket({ taskId: plan.id, title: "初稿", status: "done", worker: writer.bot.id });
  planWatch.reconcilePlan(plan.id);
  expect(fired).toHaveLength(0);
});

test(
  "a first pass since a check's definition lets one more nudge through instead of a stall; a later fail-then-pass (first_passed_at already set) does not",
  () => {
    const { store, planWatch, fired, published } = barePlanWatch();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const plan = store.openTask({ sessionId: session, title: "写周报" });
    // A ticket that never moves, so only the check's own history decides moved/firstPassed each cycle.
    const ticket = store.createTicket({ taskId: plan.id, title: "初稿", status: "doing", worker: writer.bot.id });
    const check = store.createCheckByUser(plan.id, { item: "交到 report.md", ticket_id: ticket.id, kind: "command", command: "false" });
    const fail = (detail: string) => {
      const run = store.beginCheckRun(check.id, "user");
      store.finishCheckRun(run.id, { outcome: "fail", exitCode: 1, detail, output: null });
    };
    const pass = () => {
      const run = store.beginCheckRun(check.id, "user");
      store.finishCheckRun(run.id, { outcome: "pass", exitCode: 0, detail: "ok", output: null });
    };

    fail("第一次不过");
    planWatch.reconcilePlan(plan.id); // nudge 1: no `last` yet, always fires.
    expect(fired).toHaveLength(1);

    planWatch.reconcilePlan(plan.id); // nothing moved, the check never passed since nudge 1: stalled once.
    expect(fired).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("这件事停下了");
    expect(published[0]).toContain("第一次不过");

    // Stalled again changes nothing: the notice is deduped by the nudge's own id.
    planWatch.reconcilePlan(plan.id);
    expect(published).toHaveLength(1);

    // The check passes for the first time since it was defined — after nudge 1 — while the ticket
    // still has not moved: that alone lets exactly one more nudge through, not another stall.
    pass();
    planWatch.reconcilePlan(plan.id);
    expect(fired).toHaveLength(2);
    expect(published).toHaveLength(1);

    // A fail right after nudge 2 has nothing new since nudge 2 either (the earlier pass predates
    // it): stalled immediately, this time under nudge 2's own notice.
    fail("又不过了");
    planWatch.reconcilePlan(plan.id);
    expect(fired).toHaveLength(2);
    expect(published).toHaveLength(2);
    expect(published[1]).toContain("这件事停下了");

    // Passing again does not help: `first_passed_at` only ever stamps once, so this is not a
    // *first* pass since nudge 2 either — it does not count as progress, and the same notice (now
    // already sent) is all reconcile has to say; no third nudge, no third message.
    pass();
    planWatch.reconcilePlan(plan.id);
    expect(fired).toHaveLength(2);
    expect(published).toHaveLength(2);
  },
);

test("a hard budget (tickets + checks, since the user's own last line) stops the reconcile even when a ticket keeps moving", () => {
  const { store, planWatch, fired, published } = barePlanWatch();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const plan = store.openTask({ sessionId: session, title: "写周报" });
  const ticket = store.createTicket({ taskId: plan.id, title: "初稿", status: "doing", worker: writer.bot.id });
  const check = store.createCheckByUser(plan.id, { item: "交到 report.md", ticket_id: ticket.id, kind: "command", command: "false" });
  const run = store.beginCheckRun(check.id, "user");
  store.finishCheckRun(run.id, { outcome: "fail", exitCode: 1, detail: "不通过", output: null });
  // Budget = tickets.length (1) + checks.length (1) = 2.
  let t = Date.now();
  const markReviewed = () => {
    t += 60_000;
    store.db.run(`UPDATE tickets SET status = 'review', updated_at = ? WHERE id = ?`, [new Date(t).toISOString(), ticket.id]);
  };

  planWatch.reconcilePlan(plan.id); // nudge 1: no `last` yet, always fires.
  expect(fired).toHaveLength(1);
  markReviewed();
  planWatch.reconcilePlan(plan.id); // moved since nudge 1, and only 1 nudge booked so far (< budget 2): nudge 2.
  expect(fired).toHaveLength(2);
  markReviewed();
  planWatch.reconcilePlan(plan.id); // moved since nudge 2 too, but the budget (2 nudges) is already spent: stalled instead.
  expect(fired).toHaveLength(2);
  expect(planNudges(store, plan.id)).toHaveLength(2);
  expect(published).toHaveLength(1);
  expect(published[0]).toContain("这件事停下了");
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

/** The organizer alone, over a store, answering each call with the next of `answers`; a function answers when the call is made. */
function bareOrganizer(answers: Array<JudgeResult | Error | (() => JudgeResult)>) {
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
      return typeof next === "function" ? next() : next;
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

test("a line asking to stop never puts a parked plan back to work; one that says to go on does", async () => {
  // The live case: 「你私聊里的没停」 came back as 「私聊里这件还没停，不要搁置，接着做完」, the
  // plan went active again and the video Bots rendered two more shots after being told to stop.
  const reopen = (planId: string) =>
    judged(
      JSON.stringify({
        decision: "resume",
        resume_plan_id: planId,
        plan: { goal: "做一部短片", rules: ["私聊里这件还没停，不要搁置，接着做完"], status: "active" },
        tickets: [],
      }),
    );
  const answers: JudgeResult[] = [];
  const h = bareOrganizer(answers);
  const director = h.store.createBot({ name: "Director", duties: "direct", boundaries: "stay" });
  const session = director.direct_session.id;
  const plan = h.store.openTask({ sessionId: session, title: "做一部短片" });
  const opening = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "做一部短片" });
  h.store.db.run("UPDATE messages SET task_id = ? WHERE id = ?", [plan.id, opening.id]);
  h.store.setPlanSpecByUser(plan.id, { goal: "做一部短片", rules: ["用户叫停，没说继续之前不再做"], status: "parked" });
  const revisions = h.store.listSpecRevisions(plan.id).length;

  for (const body of ["你私聊里的没停", "停下你所有的工作", "you still haven't stopped"]) {
    h.lines.length = 0;
    h.requests.length = 0;
    const line = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body });
    // The call was made and its answer read; only applying it is refused.
    answers.push(reopen(plan.id));
    expect(await h.organizer.organizeMessage(line)).toEqual({ taskId: null, ticketId: null });
    expect(h.requests).toHaveLength(1);
    expect(h.store.getTask(plan.id).status).toBe("parked");
    expect(h.store.getMessage(line.id).task_id).toBeNull();
    expect(h.lines).toEqual([
      `[organizer] filing message ${line.id}: a line asking to stop would have reopened parked plan ${plan.id}, nothing filed`,
    ]);
  }
  expect(h.store.listSpecRevisions(plan.id)).toHaveLength(revisions);
  expect(JSON.parse(h.store.getTask(plan.id).spec!).rules).toEqual(["用户叫停，没说继续之前不再做"]);

  const goOn = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "停了的那部接着做" });
  answers.push(reopen(plan.id));
  expect(await h.organizer.organizeMessage(goOn)).toMatchObject({ taskId: plan.id });
  expect(h.store.getTask(plan.id).status).toBe("active");
});

test("a settle files what the Bots handed over in a parked plan but leaves it parked", async () => {
  const answers: JudgeResult[] = [];
  const h = bareOrganizer(answers);
  const director = h.store.createBot({ name: "Director", duties: "direct", boundaries: "stay" });
  const session = director.direct_session.id;
  const plan = h.store.openTask({ sessionId: session, title: "做一部短片" });
  h.store.setPlanSpecByUser(plan.id, { goal: "做一部短片", status: "parked" });
  const handed = h.store.insertMessage({ sessionId: session, kind: "bot", author: director.bot.id, body: "Shot 12 交在 shots/shot_12.mp4" });
  h.store.db.run("UPDATE messages SET task_id = ?, created_at = ? WHERE id = ?", [plan.id, new Date(Date.now() + 1000).toISOString(), handed.id]);
  answers.push(
    judged(JSON.stringify({ decision: "continue", plan: { goal: "做一部短片", progress: { done: ["Shot 12 已交"] }, status: "active" }, tickets: [] })),
  );

  expect(await h.organizer.settlePlan(plan.id)).toBe(true);
  const task = h.store.getTask(plan.id);
  expect(task.status).toBe("parked");
  expect(JSON.parse(task.spec!)).toMatchObject({ status: "parked", progress: { done: ["Shot 12 已交"] } });
  expect(h.lines).toEqual([`[organizer] plan ${plan.id}: the settle called it active; kept parked`]);
});

test("stop lines are told from lines that say to go on", () => {
  for (const body of ["停下你所有的工作", "私聊里的也停掉", "你私聊里的没停", "你手头的生成停一下", "先暂停", "别再生成了", "Stop everything", "please pause"]) {
    expect(asksToStop(body)).toBe(true);
  }
  for (const body of ["继续", "停了的那部接着做", "不要停", "停车场那张图再亮一点", "为什么不继续了", "don't stop now", "keep going", "别再用冻帧补时长", "不要再出现左右手反"]) {
    expect(asksToStop(body)).toBe(false);
  }
});

/**
 * A plan with a version the organizer wrote — the rule 不要口语, ticket 01 写出第一版 — and after it the
 * Writer handing a draft over: something to settle, and not a word from you since.
 */
function quietPlan(store: Store) {
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const spec = {
    kind: "周报",
    goal: "写一份周报",
    acceptance: ["交到 report.md"],
    rules: ["不要口语"],
    process: [],
    progress: { done: [], open: ["初稿"], blocked: [] },
    status: "active" as const,
  };
  const plan = store.openTask({ sessionId: session, title: "写一份周报", spec });
  const ticket = store.createTicket({ taskId: plan.id, title: "初稿", spec: "写出第一版", status: "doing", worker: writer.bot.id });
  const opener = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报" });
  const turn = store.createTurn({ sessionId: session, botId: writer.bot.id, triggerMessageId: opener.id, taskId: plan.id, ticketId: ticket.id });
  store.recordSpecRevision({ taskId: plan.id, spec, actor: "app" });
  store.insertMessage({ sessionId: session, turnId: turn.id, kind: "bot", author: writer.bot.id, body: "初稿在 draft.md，审稿先冻结", paths: [`${ticket.dir}/draft.md`] });
  store.setTurnStatus(turn.id, "completed");
  return { session, plan, ticket, spec };
}

function planSpecOf(store: Store, taskId: string): { goal: string; acceptance: string[]; rules: string[]; progress: { done: string[] } } {
  return JSON.parse(store.getTask(taskId).spec!);
}

test("a settle with nothing new from you since the last version files the handover but keeps Done when, the rules and what each ticket is for, and says so", async () => {
  const answers: Array<JudgeResult | Error | (() => JudgeResult)> = [];
  const h = bareOrganizer(answers);
  const { session, plan, ticket, spec } = quietPlan(h.store);
  // The Writer's own caution, written up as the plan's rule, Done when and the ticket's description.
  answers.push(
    judged(
      JSON.stringify({
        decision: "continue",
        plan: { ...spec, acceptance: [...spec.acceptance, "审稿解冻前不能当作终稿"], rules: ["只推进初稿，审稿冻结"], progress: { done: ["初稿"], open: [], blocked: [] } },
        tickets: [{ id: ticket.id, spec: "已交初稿，不再重试", status: "review" }],
      }),
    ),
  );
  expect(await h.organizer.settlePlan(plan.id)).toBe(true);
  const seen = JSON.parse(String(h.requests[0]!.messages[1]!.content)) as OrganizerPayload;
  expect(seen.since_last_revision.user_spoke).toBe(false);
  expect(planSpecOf(h.store, plan.id)).toMatchObject({ acceptance: ["交到 report.md"], rules: ["不要口语"], progress: { done: ["初稿"] } });
  expect(h.store.getTicket(ticket.id)).toMatchObject({ spec: "写出第一版", status: "review" });
  const quiet = `[organizer] plan ${plan.id}: nothing new from the user since the last version;`;
  expect(h.lines).toEqual([`${quiet} kept Done when as it was`, `${quiet} kept the rules as they were`, `${quiet} kept ticket 01's spec`]);

  // You speak — a line not filed anywhere yet — and the next settle may write your word into the rules.
  h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "标题别太长" });
  answers.push(judged(JSON.stringify({ decision: "continue", plan: { ...planSpecOf(h.store, plan.id), rules: ["不要口语", "标题别太长"] }, tickets: [] })));
  expect(await h.organizer.settlePlan(plan.id)).toBe(true);
  expect((JSON.parse(String(h.requests[1]!.messages[1]!.content)) as OrganizerPayload).since_last_revision.user_spoke).toBe(true);
  expect(planSpecOf(h.store, plan.id).rules).toEqual(["不要口语", "标题别太长"]);
  expect(h.lines).toHaveLength(3);
});

test("a line of yours that lands while a settle is out does not free its answer: the organizer never saw it", async () => {
  const answers: Array<JudgeResult | Error | (() => JudgeResult)> = [];
  const h = bareOrganizer(answers);
  const { session, plan, spec } = quietPlan(h.store);
  answers.push(() => {
    h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "先把初稿做好" });
    return judged(JSON.stringify({ decision: "continue", plan: { ...spec, rules: ["不要口语", "审稿冻结"] }, tickets: [] }));
  });
  expect(await h.organizer.settlePlan(plan.id)).toBe(true);
  expect(planSpecOf(h.store, plan.id).rules).toEqual(["不要口语"]);
  expect(h.lines).toEqual([`[organizer] plan ${plan.id}: nothing new from the user since the last version; kept the rules as they were`]);
});

test("a settle whose plan you changed while it was out files nothing", async () => {
  const answers: Array<JudgeResult | Error | (() => JudgeResult)> = [];
  const h = bareOrganizer(answers);
  const { plan, spec } = quietPlan(h.store);
  answers.push(() => {
    h.store.setPlanSpecByUser(plan.id, { ...spec, rules: ["不要口语", "标题别太长"] });
    return judged(JSON.stringify({ decision: "continue", plan: { ...spec, rules: ["不要口语", "审稿冻结"], progress: { done: ["初稿"], open: [], blocked: [] } }, tickets: [] }));
  });
  expect(await h.organizer.settlePlan(plan.id)).toBe(false);
  expect(planSpecOf(h.store, plan.id)).toMatchObject({ rules: ["不要口语", "标题别太长"], progress: { done: [] } });
  expect(h.store.listSpecRevisions(plan.id)[0]).toMatchObject({ revision: 2, actor: "user" });
  // Nothing was filed, so nothing is said to have been kept.
  expect(h.lines).toEqual([`[organizer] plan ${plan.id}: the plan changed while it was being settled; nothing filed`]);
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

describe("a group plan with everything handed over while its progress still lists work", () => {
  /**
   * 初稿 awaits review with the Writer and 排版 is done by the Lead, while the plan's progress still
   * has 定稿 to do. Every settle after that tries to reword 初稿, which a settle with nothing new from
   * you may not do, and hands 排版 to the other Bot: tickets change, nothing more is handed over.
   */
  function handedOver(payload: OrganizerPayload): string {
    const plan = payload.current_plan;
    if (!plan) {
      return JSON.stringify({
        decision: "new",
        plan: {
          kind: "周报",
          goal: "写一份周报",
          acceptance: ["交到 report.md"],
          progress: { done: ["初稿", "排版"], open: ["定稿还没做"], blocked: [] },
        },
        tickets: [
          { id: "new-1", title: "初稿", spec: "写出第一版", status: "review", worker: "Writer" },
          { id: "new-2", title: "排版", spec: "排好版", status: "done", worker: "Lead" },
        ],
        message_ticket: null,
      });
    }
    return JSON.stringify({
      decision: "continue",
      plan: plan.spec,
      tickets: [
        { id: plan.tickets[0]!.id, spec: `第 ${plan.revision} 版说明` },
        { id: plan.tickets[1]!.id, worker: plan.revision % 2 === 0 ? "Writer" : "Lead" },
      ],
    });
  }

  async function inTheGroup(answer: Answer = handedOver, options: { planLeftQuietMs?: number } = {}) {
    const h = await harness(answer, undefined, options);
    const lead = h.store.createBot({ name: "Lead", duties: "coordinate", boundaries: "stay" });
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const group = h.store.createGroup({ name: "周报组", members: [lead.bot.id, writer.bot.id] });
    const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Lead 安排周报" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    const nudges = () =>
      h.store.db
        .query<{ id: string; bot_id: string; ticket_id: string | null; fired_turn_id: string | null; note: string; created_at: string }, []>(
          "SELECT id, bot_id, ticket_id, fired_turn_id, note, created_at FROM check_backs WHERE kind = 'plan_nudge' ORDER BY created_at ASC, rowid ASC",
        )
        .all();
    const stalled = () => h.store.listMainMessages(group.id, 80).filter((m) => m.kind === "system" && m.body.startsWith("这件事停下了"));
    const notice = (nudgeId: string) =>
      h.store.db
        .query<{ kind: string; fail_kind: string | null; message_id: string | null }, [string]>(
          "SELECT kind, fail_kind, message_id FROM notifications WHERE semantic_key = ?",
        )
        .get(`stalled:${nudgeId}`);
    return { h, lead: lead.bot, writer: writer.bot, group, nudges, stalled, notice };
  }

  test("once it has been quiet a while, the Bot that spoke last is called back into the plan's folder; a ticket changing without moving is no move, so you are told once", async () => {
    const { h, lead, group, nudges, stalled, notice } = await inTheGroup();
    await until(() => nudges().length === 1 && nudges()[0]!.fired_turn_id !== null);
    const plan = h.store.sessionCurrentTask(group.id)!;
    const [draft, layout] = h.store.listTickets(plan.id);
    const nudge = nudges()[0]!;
    // Nobody is picked for a ticket: the Bot the plan stopped on takes stock, in the plan's folder.
    expect(nudge).toMatchObject({ bot_id: lead.id, ticket_id: null });
    expect(nudge.note).toStartWith("规划静下来一阵了：没有待做或进行中的任务");
    expect(nudge.note).toContain("自己交的也不自己判");
    expect(nudge.note).toContain("待验收：01《初稿》（待验收，Writer）。");
    // What is left is the organizer's words: the situation shows them, the Bot's reminder does not repeat them.
    expect(nudge.note).not.toContain("定稿还没做");
    const woken = h.store.getTurn(nudge.fired_turn_id!);
    expect(woken).toMatchObject({ bot_id: lead.id, task_id: plan.id, ticket_id: null });
    expect(h.store.getMessage(woken.trigger_message_id).body).toStartWith("回看：规划静下来一阵了");
    await until(() => h.seen.some((messages) => messages.some((m) => textOf(m).includes("回看：规划静下来一阵了"))));
    const heard = h.seen.find((messages) => messages.some((m) => textOf(m).includes("回看：规划静下来一阵了")))!;
    expect(textOf(heard.find((m) => m.role === "user" && textOf(m).startsWith(SITUATION_HEADING))!)).toContain("待做 定稿还没做");

    // The settle after the call-back handed nothing over, so the session says so, once.
    await until(() => stalled().length === 1);
    const line = stalled()[0]!;
    expect(line.body).toStartWith("这件事停下了：没有待做或进行中的任务，进展里还记着没做完或卡住的：定稿还没做。");
    expect(line.body).toContain("已经叫过Lead一次，之后没有任务交出或收口");
    expect(notice(nudge.id)).toMatchObject({ kind: "failure", fail_kind: "stalled_plan", message_id: line.id });
    // With nothing new from you the settle kept 初稿's spec; 排版 did change after the call-back, just not where it stands.
    expect(h.store.getTicket(draft!.id)).toMatchObject({ status: "review", spec: "写出第一版" });
    expect(h.store.getTicket(layout!.id).status).toBe("done");
    expect(h.store.getTicket(layout!.id).updated_at > nudge.created_at).toBe(true);
    await Bun.sleep(200);
    expect(nudges()).toHaveLength(1);
    expect(stalled()).toHaveLength(1);
  });

  test("waits until the plan and its session have both been quiet: a line of yours meanwhile moves the time", async () => {
    const quiet = 500;
    const { h, group, nudges } = await inTheGroup(handedOver, { planLeftQuietMs: quiet });
    await until(() => {
      const plan = h.store.sessionCurrentTask(group.id);
      return plan !== null && h.store.currentRevision(plan.id) >= 2;
    });
    const plan = h.store.sessionCurrentTask(group.id)!;
    const quietFrom = Date.parse(h.store.taskLastActivityAt(plan.id));
    await Bun.sleep(100);
    // You say something that opens no turn: you are still in the conversation.
    const aside = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "我先看看" });
    expect(Date.parse(aside.created_at)).toBeLessThan(quietFrom + quiet);
    expect(nudges()).toHaveLength(0);
    await until(() => nudges().length === 1, 5000);
    expect(Date.parse(nudges()[0]!.created_at)).toBeGreaterThanOrEqual(Date.parse(aside.created_at) + quiet);
  });

  test("in your direct with a Bot nobody is called back: its last word already went to you", async () => {
    const h = await harness(handedOver);
    h.store.createBot({ name: "Lead", duties: "coordinate", boundaries: "stay" });
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "安排周报" });
    const done = h.completed();
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await done;
    const plan = h.store.sessionCurrentTask(session)!;
    await until(() => h.store.currentRevision(plan.id) >= 2);
    await Bun.sleep(150);
    expect(h.store.listTickets(plan.id).map((ticket) => ticket.status)).toEqual(["review", "done"]);
    expect(h.store.getTask(plan.id).spec).toContain("定稿还没做");
    expect(h.store.db.query("SELECT COUNT(*) AS n FROM check_backs WHERE kind = 'plan_nudge'").get()).toEqual({ n: 0 });
    expect(h.store.listMainMessages(session, 20).some((m) => m.body.startsWith("这件事停下了"))).toBe(false);
  });

  test("a group plan of one handed-over ticket is a one-shot job waiting for you: nobody is called back", async () => {
    const { h, group, nudges, stalled } = await inTheGroup((payload) => {
      const plan = payload.current_plan;
      if (plan) return JSON.stringify({ decision: "continue", plan: plan.spec, tickets: [] });
      return JSON.stringify({
        decision: "new",
        plan: { goal: "写一份周报", progress: { done: ["初稿"], open: ["等定稿意见"], blocked: [] } },
        tickets: [{ id: "new-1", title: "初稿", spec: "写出第一版", status: "review", worker: "Writer" }],
        message_ticket: null,
      });
    });
    await until(() => {
      const plan = h.store.sessionCurrentTask(group.id);
      return plan !== null && h.store.currentRevision(plan.id) >= 2;
    });
    await Bun.sleep(150);
    expect(nudges()).toHaveLength(0);
    expect(stalled()).toHaveLength(0);
  });

  test("work the record files as held up counts as left: a Bot's own freeze is called back too", async () => {
    const { h, lead, group, nudges, stalled } = await inTheGroup((payload) => {
      const plan = payload.current_plan;
      if (plan) return JSON.stringify({ decision: "continue", plan: plan.spec, tickets: [] });
      return JSON.stringify({
        decision: "new",
        plan: { goal: "写一份周报", progress: { done: ["初稿", "排版"], open: [], blocked: ["定稿：Lead 自己冻结了，等它解冻"] } },
        tickets: [
          { id: "new-1", title: "初稿", spec: "写出第一版", status: "review", worker: "Writer" },
          { id: "new-2", title: "排版", spec: "排好版", status: "done", worker: "Lead" },
        ],
        message_ticket: null,
      });
    });
    await until(() => stalled().length === 1);
    const plan = h.store.sessionCurrentTask(group.id)!;
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toMatchObject({ bot_id: lead.id, ticket_id: null });
    expect(nudges()[0]!.note).toContain("卡住的，想清楚你们自己定的暂停、冻结还该不该停");
    expect(stalled()[0]!.body).toContain("定稿：Lead 自己冻结了，等它解冻");
    expect(h.store.getTask(plan.id).status).toBe("active");
  });

  test("a parked ticket does not make a plan of two: one handed over and one parked calls nobody back", async () => {
    const { h, group, nudges, stalled } = await inTheGroup((payload) => {
      const plan = payload.current_plan;
      if (plan) return JSON.stringify({ decision: "continue", plan: plan.spec, tickets: [] });
      return JSON.stringify({
        decision: "new",
        plan: { goal: "写一份周报", progress: { done: ["初稿"], open: ["定稿还没做"], blocked: [] } },
        tickets: [
          { id: "new-1", title: "初稿", spec: "写出第一版", status: "review", worker: "Writer" },
          { id: "new-2", title: "配图", spec: "不要了", status: "parked", worker: null },
        ],
        message_ticket: null,
      });
    });
    await until(() => {
      const plan = h.store.sessionCurrentTask(group.id);
      return plan !== null && h.store.currentRevision(plan.id) >= 2;
    });
    await Bun.sleep(150);
    expect(nudges()).toHaveLength(0);
    expect(stalled()).toHaveLength(0);
  });

  test("when the Bot to call back already has an appointment here for another plan, the plan is looked at again once it is gone", async () => {
    const { h, lead, writer, group } = await inTheGroup(handedOver, { planLeftQuietMs: 60 });
    // Lead holds an appointment in this group for a job that lives in another session.
    const elsewhere = h.store.createGroup({ name: "月报组", members: [lead.id, writer.id] });
    const other = h.store.openTask({ sessionId: elsewhere.id, title: "月报" });
    const appointment = h.store.bookPlanNudge({ botId: lead.id, sessionId: group.id, taskId: other.id, ticketId: null, note: "看月报" });
    const plan = () => h.store.sessionCurrentTask(group.id);
    const callBacks = () =>
      h.store.db
        .query<{ bot_id: string }, [string]>("SELECT bot_id FROM check_backs WHERE kind = 'plan_nudge' AND task_id = ?")
        .all(plan()?.id ?? "");
    await until(() => plan() !== null && h.store.currentRevision(plan()!.id) >= 2);
    await Bun.sleep(300);
    // Booking would have voided Lead's appointment: the watch waits instead of dropping the plan.
    expect(callBacks()).toHaveLength(0);
    expect(h.store.pendingCheckBack(lead.id, group.id)?.id).toBe(appointment.id);
    h.store.voidCheckBacks({ botId: lead.id, sessionId: group.id });
    await until(() => callBacks().length === 1);
    expect(callBacks()[0]!.bot_id).toBe(lead.id);
  });

  test(`while you say nothing, a plan is called back at most ${PLAN_NUDGES_UNANSWERED_MAX} times, even when every call-back hands something over`, async () => {
    // Each settle opens one more ticket already awaiting review: a move every time.
    const { h, lead, nudges, stalled, notice } = await inTheGroup((payload) => {
      const plan = payload.current_plan;
      if (!plan) return handedOver(payload);
      return JSON.stringify({
        decision: "continue",
        plan: plan.spec,
        tickets: [{ id: "new-1", title: `第 ${plan.revision} 份`, spec: "交了", status: "review", worker: "Writer" }],
      });
    });
    await until(() => stalled().length === 1, 8000);
    expect(nudges()).toHaveLength(PLAN_NUDGES_UNANSWERED_MAX);
    expect(nudges().every((nudge) => nudge.bot_id === lead.id && nudge.ticket_id === null)).toBe(true);
    const line = stalled()[0]!;
    expect(line.body).toStartWith("这件事停下了：没有待做或进行中的任务");
    expect(line.body).toContain(`你上次在这件事里说话之后已经叫回 ${PLAN_NUDGES_UNANSWERED_MAX} 次，最近一次叫的是Lead，不再叫了。`);
    expect(notice(nudges().at(-1)!.id)).toMatchObject({ kind: "failure", fail_kind: "stalled_plan", message_id: line.id });
    await Bun.sleep(200);
    expect(nudges()).toHaveLength(PLAN_NUDGES_UNANSWERED_MAX);
    expect(stalled()).toHaveLength(1);
  });
});
