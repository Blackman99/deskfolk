/**
 * Coverage for `ablation.ts`'s parsing/labelling, and for every switch site it documents: each one
 * is exercised off (the call is skipped, and the loop takes the path the comment says it takes)
 * against a baseline that shows the same call fires when nothing is ablated.
 *
 * The engine-level tests build their own small `engineHarness` (a `createTurnEngine` over an
 * in-memory `Store`, with a `completions.judge` dispatcher that recognises each short call by its
 * system prompt) rather than importing one from another test file, following the pattern in
 * `organizer.test.ts` / `closing-check.test.ts` / `check-back.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import {
  ABLATED_JOIN_REASON,
  ABLATION_GROUPS,
  AblationError,
  NO_ABLATION,
  SIDE_CALLS,
  ablationLabel,
  ablationList,
  parseAblation,
  type Ablation,
  type AblationGroup,
  type SideCall,
} from "./ablation";
import type { ChatMessage, CompletionOk, JudgeResult } from "./completions";
import { createLocalApi } from "./local-api";
import { JUDGEMENT_SYSTEM } from "./prompts/judgement";
import { ORGANIZER_SYSTEM, type OrganizerPayload } from "./prompts/organizer";
import { ROUTE_LEARN_SYSTEM, ROUTE_PICK_SYSTEM, ROUTE_REVIEW_SYSTEM } from "./prompts/routing";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function call(name: string, args: Record<string, unknown>): CompletionOk {
  return {
    ok: true,
    content: "",
    toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    hadChoices: true,
    usage: null,
    missingReason: null,
  };
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

/** A closed chain's age, so `sweepStaleChains` finds it without a 3-minute real wait (see `turn-engine.test.ts`). */
function ageChain(store: Store, quietMs: number): void {
  const at = new Date(Date.now() - quietMs).toISOString();
  store.db.run(`UPDATE turn_route_decisions SET created_at = ?`, [at]);
  store.db.run(`UPDATE route_feedback SET created_at = ?`, [at]);
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

type Handlers = {
  /** null means "answer unreadably" (the organizer fails open); never a thrown call in this file. */
  organizer?: (payload: OrganizerPayload) => string | null;
  judgement?: (payload: Record<string, unknown>) => string;
  routePick?: (payload: Record<string, unknown>) => string | null;
  routeReview?: (payload: Record<string, unknown>) => string;
  routeLearn?: () => string;
};

function payloadOf(request: { messages: ChatMessage[] }): Record<string, unknown> {
  const raw = request.messages[1]?.content;
  return JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
}

/**
 * `createTurnEngine` over a fresh `Store`, with a `judge` dispatcher that recognises every short
 * call by `messages[0].content` (the system prompt) the way `organizer.test.ts` does for the
 * organizer and the judgement call. `calls` records which system prompt each `judge()` request
 * carried, in order, so a test can assert a kind of call never happened.
 */
function engineHarness(opts: {
  ablation?: Ablation;
  settleQuietMs?: number;
  directQuietMs?: number;
  script?: (messages: ChatMessage[]) => CompletionOk | Promise<CompletionOk>;
  handlers?: Handlers;
}) {
  const root = mkdtempSync(join(tmpdir(), "ablation-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const handlers = opts.handlers ?? {};
  const calls: string[] = [];
  const organizerPayloads: OrganizerPayload[] = [];
  const judgementPayloads: Record<string, unknown>[] = [];
  const routePickPayloads: Record<string, unknown>[] = [];
  const routeReviewPayloads: Record<string, unknown>[] = [];
  const seen: ChatMessage[][] = [];
  const events: ClientEvent[] = [];
  let completedCount = 0;
  const waiters: Array<() => void> = [];
  store.onCommit((event) => events.push(event));
  const engine = createTurnEngine({
    store,
    ablation: opts.ablation,
    settleQuietMs: opts.settleQuietMs ?? 20,
    directQuietMs: opts.directQuietMs,
    publish(event) {
      events.push(event);
      if (event.event === "turn.upsert" && event.status === "completed") {
        completedCount += 1;
        for (const wake of waiters.splice(0)) wake();
      }
    },
    completions: {
      async complete(request) {
        seen.push(request.messages);
        return (opts.script ?? (() => say("ok")))(request.messages);
      },
      async judge(request) {
        const system = request.messages[0]?.content;
        if (system === ORGANIZER_SYSTEM) {
          const payload = payloadOf(request) as unknown as OrganizerPayload;
          organizerPayloads.push(payload);
          calls.push("organizer");
          const content = handlers.organizer ? handlers.organizer(payload) : null;
          return judged(content ?? "我不知道");
        }
        if (system === JUDGEMENT_SYSTEM) {
          const payload = payloadOf(request);
          judgementPayloads.push(payload);
          calls.push("judgement");
          return judged(handlers.judgement ? handlers.judgement(payload) : '{"decision":"join","reason":"fixture"}');
        }
        if (system === ROUTE_PICK_SYSTEM) {
          const payload = payloadOf(request);
          routePickPayloads.push(payload);
          calls.push("route-pick");
          const content = handlers.routePick ? handlers.routePick(payload) : null;
          return judged(content ?? "{}");
        }
        if (system === ROUTE_REVIEW_SYSTEM) {
          const payload = payloadOf(request);
          routeReviewPayloads.push(payload);
          calls.push("route-review");
          return judged(
            handlers.routeReview
              ? handlers.routeReview(payload)
              : '{"fault":"model","direction":"stronger","rounds":1,"confidence":0.9,"reason":"x"}',
          );
        }
        if (system === ROUTE_LEARN_SYSTEM) {
          calls.push("route-learn");
          return judged(handlers.routeLearn ? handlers.routeLearn() : "{}");
        }
        calls.push(`unknown:${String(system)}`);
        return judged('{"decision":"join","reason":"fixture"}');
      },
    },
  });
  const settle = () =>
    store.patchSettings({
      workspace_path: root,
      endpoint_base_url: "http://127.0.0.1:1/v1",
      endpoint_api_key: "fixture",
      endpoint_models: ["fixture"],
      endpoint_default_model: "fixture",
    });
  const completed = () => new Promise<void>((resolve) => waiters.push(resolve));
  const turnOf = (triggerId: string) =>
    store.db
      .query<{ id: string; task_id: string | null; ticket_id: string | null; status: string; bot_id: string }, [string]>(
        "SELECT id, task_id, ticket_id, status, bot_id FROM turns WHERE trigger_message_id = ? ORDER BY created_at ASC",
      )
      .all(triggerId);
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    engine,
    calls,
    organizerPayloads,
    judgementPayloads,
    routePickPayloads,
    routeReviewPayloads,
    seen,
    events,
    completed,
    completedCount: () => completedCount,
    turnOf,
    settle,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. ablation.ts: parsing and labelling
// ---------------------------------------------------------------------------------------------

describe("ablation.ts: parsing and labelling", () => {
  test('empty and "none" parse to nothing off', () => {
    expect(parseAblation("").size).toBe(0);
    expect(parseAblation("none")).toEqual(NO_ABLATION);
    expect(parseAblation("  ")).toEqual(NO_ABLATION);
  });

  test("groups expand to their switches; bare is exactly SIDE_CALLS", () => {
    expect(parseAblation("organizer")).toEqual(new Set(["organize-message", "organize-settle"]));
    expect(parseAblation("nudges")).toEqual(new Set(["plan-nudge", "direct-report"]));
    expect(parseAblation("calls")).toEqual(new Set(ABLATION_GROUPS.calls));
    expect(parseAblation("bare")).toEqual(new Set(SIDE_CALLS));
  });

  test("names separate by comma or plus, whitespace is trimmed, and duplicates collapse", () => {
    expect(parseAblation(" review , learning ")).toEqual(new Set(["review", "learning"]));
    expect(parseAblation("review+learning")).toEqual(new Set(["review", "learning"]));
    expect(parseAblation("review,review,review")).toEqual(new Set(["review"]));
    expect(parseAblation("organizer+judgement")).toEqual(
      new Set(["organize-message", "organize-settle", "judgement"]),
    );
    expect(parseAblation("review, +,learning")).toEqual(new Set(["review", "learning"]));
  });

  test("an unknown name throws AblationError, and its message lists every known name", () => {
    let error: unknown;
    try {
      parseAblation("nope");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AblationError);
    const message = (error as Error).message;
    expect(message).toContain("nope");
    for (const name of [...Object.keys(ABLATION_GROUPS), ...SIDE_CALLS, "none"]) {
      expect(message).toContain(name);
    }
    // A group name inside an otherwise-valid list still throws: nothing partially applies.
    expect(() => parseAblation("review,nope")).toThrow(AblationError);
  });

  test("ablationLabel round-trips through parseAblation for every single switch and every group", () => {
    for (const one of SIDE_CALLS) {
      const set = new Set<SideCall>([one]);
      const label = ablationLabel(set);
      expect(label).toBe(one);
      expect(parseAblation(label)).toEqual(set);
    }
    for (const [name, group] of Object.entries(ABLATION_GROUPS) as Array<[AblationGroup, readonly SideCall[]]>) {
      const set = new Set(group);
      expect(ablationLabel(set)).toBe(name);
      expect(parseAblation(ablationLabel(set))).toEqual(set);
    }
  });

  test("an ad-hoc set (not exactly a group) labels as its names joined by + in SIDE_CALLS order", () => {
    expect(ablationLabel(new Set(["learning", "closing-check"]))).toBe("closing-check+learning");
    expect(ablationLabel(new Set(["direct-report", "organize-message"]))).toBe("organize-message+direct-report");
    expect(ablationLabel(NO_ABLATION)).toBe("none");
  });

  test("ablationList orders by SIDE_CALLS, not input order", () => {
    expect(ablationList(parseAblation("judgement,organize-message"))).toEqual(["organize-message", "judgement"]);
    expect(ablationList(NO_ABLATION)).toEqual([]);
    expect(ablationList(parseAblation("bare"))).toEqual([...SIDE_CALLS]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2 & 3. organize-message / organize-settle
// ---------------------------------------------------------------------------------------------

describe("organizer: organize-message / organize-settle", () => {
  test("organize-message off: no message-mode organizer call; the turn opens in a plan whose spec is absent", async () => {
    const h = engineHarness({ ablation: new Set(["organize-message"]) });
    await h.settle();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报，交到 report.md" });
    const done = h.completed();
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await done;

    expect(h.organizerPayloads.filter((p) => p.mode === "message")).toHaveLength(0);
    const plan = h.store.sessionCurrentTask(session);
    expect(plan).not.toBeNull();
    expect(plan!.spec).toBeNull();
    expect(plan!.brief).toBe("写一份周报，交到 report.md");
    const turn = h.turnOf(trigger.id)[0]!;
    expect(turn.task_id).toBe(plan!.id);
    expect(turn.status).toBe("completed");

    // organize-settle is not ablated here: the quiet plan still gets a settle attempt.
    await until(() => h.organizerPayloads.some((p) => p.mode === "settle"));
  });

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

  async function twoTicketPlan(ablation?: Ablation) {
    const h = engineHarness({ ablation, handlers: { organizer: twoTickets } });
    await h.settle();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = h.store.createGroup({ name: "周报组", members: [writer.bot.id, reviewer.bot.id] });
    const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 写一份周报" });
    const done = h.completed();
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await done;
    const nudges = () =>
      h.store.db
        .query<{ id: string; bot_id: string; ticket_id: string | null; fired_turn_id: string | null }, []>(
          "SELECT id, bot_id, ticket_id, fired_turn_id FROM check_backs WHERE kind = 'plan_nudge'",
        )
        .all();
    return { h, writer, reviewer, group, nudges };
  }

  test("organize-settle off: the filing happens, but no settle payload ever arrives; the quiet reconcile still books a plan_nudge", async () => {
    const { h, writer, nudges } = await twoTicketPlan(new Set(["organize-settle"]));

    expect(h.organizerPayloads.some((p) => p.mode === "message")).toBe(true);

    // onQuiet still fires from the (skipped) settle's completion, with two tickets open.
    await until(() => nudges().length === 1 && nudges()[0]!.fired_turn_id !== null);
    expect(nudges()[0]!.bot_id).toBe(writer.bot.id);

    await Bun.sleep(100);
    expect(h.organizerPayloads.filter((p) => p.mode === "settle")).toHaveLength(0);
  });

  test("plan-nudge off: the same quiet-plan-with-open-tickets scenario books no plan_nudge and posts no stall notice", async () => {
    const { h, group, nudges } = await twoTicketPlan(new Set(["plan-nudge"]));

    // Give the (unablated) settle and the quiet timer plenty of room to have reconciled.
    await Bun.sleep(150);
    expect(nudges()).toHaveLength(0);
    expect(
      h.store.listMainMessages(group.id, 20).some((m) => m.kind === "system" && m.body.startsWith("这件事停下了")),
    ).toBe(false);
  });

  test("plan-nudge on (baseline): the same scenario books one plan_nudge check-back", async () => {
    const { writer, nudges } = await twoTicketPlan();
    await until(() => nudges().length === 1 && nudges()[0]!.fired_turn_id !== null);
    expect(nudges()[0]!.bot_id).toBe(writer.bot.id);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. closing-check
// ---------------------------------------------------------------------------------------------

describe("engine/closing.ts: closing-check", () => {
  /**
   * Since 2026-09-28 (ADR 0036) the closing check is deterministic and makes no judge call: a
   * reply that promises "结论随后" with no check-back booked and nobody named to take it is
   * bounced once as a line in the loop, purely from `turn_runs` / `check_backs` evidence.
   */
  function promiseScript(messages: ChatMessage[]): CompletionOk {
    if (messages.some((m) => m.role === "user" && textOf(m).startsWith("（应用提示）"))) {
      return say("18 张起止帧逐对看完：没有画风跳变。");
    }
    return say("正在逐对核验 18 张起止帧，结论随后。");
  }

  test("closing-check on (baseline): an unbacked 'later' promise is bounced once, deterministically", async () => {
    const h = engineHarness({ script: promiseScript });
    await h.settle();
    const reviewer = h.store.createBot({ name: "审片员", duties: "review", boundaries: "stay" });
    const session = reviewer.direct_session.id;
    const trigger = h.store.insertMessage({
      sessionId: session,
      kind: "user",
      author: "user",
      body: "逐对核验 18 张起止帧，给出结论",
    });
    const done = h.completed();
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await done;

    const posted = h.store.listMainMessages(session, 10).filter((m) => m.kind === "bot").map((m) => m.body);
    expect(posted).toEqual(["18 张起止帧逐对看完：没有画风跳变。"]);
    // The bounce reached the model as a loop line, not a judge call.
    expect(h.calls).not.toContain("closing-check");
  });

  test("closing-check off: the same unbacked promise reaches the session unchecked, with no extra hop", async () => {
    const h = engineHarness({ ablation: new Set(["closing-check"]), script: promiseScript });
    await h.settle();
    const reviewer = h.store.createBot({ name: "审片员", duties: "review", boundaries: "stay" });
    const session = reviewer.direct_session.id;
    const trigger = h.store.insertMessage({
      sessionId: session,
      kind: "user",
      author: "user",
      body: "逐对核验 18 张起止帧，给出结论",
    });
    const done = h.completed();
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await done;

    const posted = h.store.listMainMessages(session, 10).filter((m) => m.kind === "bot").map((m) => m.body);
    expect(posted).toEqual(["正在逐对核验 18 张起止帧，结论随后。"]);
    // One hop only: the promise goes straight out, no "（应用提示）" nudge hop.
    expect(h.seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. route-pick
// ---------------------------------------------------------------------------------------------

describe("engine/routing.ts: route-pick", () => {
  test("route-pick on (baseline): a turn asks the routing agent before running", async () => {
    const h = engineHarness({});
    await h.settle();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报" });
    const done = h.completed();
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await done;

    expect(h.calls.filter((c) => c === "route-pick")).toHaveLength(1);
    expect(h.turnOf(trigger.id)[0]).toMatchObject({ status: "completed" });
  });

  test("route-pick off: no routing-agent call for a turn that would otherwise route; the turn still completes on the fallback rules", async () => {
    const h = engineHarness({ ablation: new Set(["route-pick"]) });
    await h.settle();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报" });
    const done = h.completed();
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await done;

    expect(h.calls.filter((c) => c === "route-pick")).toHaveLength(0);
    expect(h.turnOf(trigger.id)[0]).toMatchObject({ status: "completed" });
    const route = h.store.listSessionRoutes(session)[0];
    expect(route?.model).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------
// 7. judgement
// ---------------------------------------------------------------------------------------------

describe("engine/participation.ts: judgement", () => {
  function twoBotGroup(h: ReturnType<typeof engineHarness>) {
    const a = h.store.createBot({ name: "A", duties: "a 的职责", boundaries: "stay" }).bot;
    const b = h.store.createBot({ name: "B", duties: "b 的职责", boundaries: "stay" }).bot;
    const group = h.store.createGroup({ name: "G", members: [a.id, b.id] });
    return { a, b, group };
  }

  test("judgement on (baseline): an unmentioned group line asks each present Bot to judge", async () => {
    const h = engineHarness({});
    await h.settle();
    const { a, b, group } = twoBotGroup(h);
    const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "有人接一下这个吗" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });

    expect(h.calls.filter((c) => c === "judgement")).toHaveLength(2);
    const rows = h.store.listJudgements(group.id).filter((j) => j.message_id === trigger.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((j) => j.bot_id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((j) => j.decision === "join")).toBe(true);
  });

  test("judgement off: both Bots join without a judge call, with the ablated-join reason, and no judgement is left pending", async () => {
    const h = engineHarness({ ablation: new Set(["judgement"]) });
    await h.settle();
    const { a, b, group } = twoBotGroup(h);
    const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "有人接一下这个吗" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });

    expect(h.calls.filter((c) => c === "judgement")).toHaveLength(0);
    const rows = h.store.listJudgements(group.id).filter((j) => j.message_id === trigger.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((j) => j.bot_id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((j) => j.decision === "join" && j.reason === ABLATED_JOIN_REASON)).toBe(true);
    expect(h.engine.pendingJudgements()).toEqual([]);

    await until(() => h.turnOf(trigger.id).filter((t) => t.status === "completed").length === 2);
    expect(h.turnOf(trigger.id).map((t) => t.bot_id).sort()).toEqual([a.id, b.id].sort());
  });
});

// ---------------------------------------------------------------------------------------------
// 8. review / learning
// ---------------------------------------------------------------------------------------------

describe("engine/chains.ts: review / learning", () => {
  const REVIEW_MODEL_FAULT = JSON.stringify({
    fault: "model",
    direction: "stronger",
    rounds: 1,
    confidence: 0.9,
    reason: "改偏了",
  });

  /**
   * A direct with one Bot: a message, then a follow-up ("这里不对") the store attributes as a
   * critique of the first turn's decision (see `store/routing.ts#attributeCritique`) — the
   * minimal path that warrants a review (`chainWarrantsReview`: `followUps > 0`). Route-pick is
   * left to its default (always unparseable, so it always falls back), which also means every new
   * turn eagerly closes the Bot's previously-open chain; `ageChain` + `sweepStaleChains` afterwards
   * is the belt-and-braces version of the same documented path from `turn-engine.test.ts`, and is a
   * no-op for a chain that has already been reviewed.
   */
  async function warrantedReviewChain(ablation?: Ablation) {
    const h = engineHarness({ ablation, handlers: { routeReview: () => REVIEW_MODEL_FAULT } });
    await h.settle();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const first = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "把这个函数重构一下" });
    const done1 = h.completed();
    await h.engine.handleInboundMessage(first, { fromUser: true });
    await done1;
    const follow = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "这里不对" });
    const done2 = h.completed();
    await h.engine.handleInboundMessage(follow, { fromUser: true });
    await done2;
    ageChain(h.store, 4 * 60_000);
    h.engine.sweepStaleChains();
    return { h, session };
  }

  test("review on, learning on (baseline): a follow-up warrants a review, and a model-fault verdict starts one learning hop", async () => {
    const { h, session } = await warrantedReviewChain();
    await until(() => h.calls.includes("route-review"));
    await until(() => h.calls.includes("route-learn"));

    const reviews = h.store.listSessionReviews(session);
    expect(reviews.some((r) => r.fault === "model")).toBe(true);
    expect(h.store.listSpend({ session_id: session }).some((row) => row.kind === "route_review")).toBe(true);
    expect(h.store.listSpend({ session_id: session }).some((row) => row.kind === "route_learn")).toBe(true);
  });

  test("review off: the warranted chain is recorded locally with fault none; no review or learning call is made", async () => {
    const { h, session } = await warrantedReviewChain(new Set(["review"]));
    await Bun.sleep(150);

    expect(h.calls.includes("route-review")).toBe(false);
    expect(h.calls.includes("route-learn")).toBe(false);
    const reviews = h.store.listSessionReviews(session);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((r) => r.fault === "none")).toBe(true);
    expect(h.store.listSpend({ session_id: session }).some((row) => row.kind === "route_review")).toBe(false);
    expect(h.store.listSpend({ session_id: session }).some((row) => row.kind === "route_learn")).toBe(false);
  });

  test("learning off: the review still runs and records the model-fault verdict, but no learning hop follows", async () => {
    const { h, session } = await warrantedReviewChain(new Set(["learning"]));
    await until(() => h.calls.includes("route-review"));
    await Bun.sleep(150);

    expect(h.calls.includes("route-learn")).toBe(false);
    const reviews = h.store.listSessionReviews(session);
    expect(reviews.some((r) => r.fault === "model")).toBe(true);
    expect(h.store.listSpend({ session_id: session }).some((row) => row.kind === "route_learn")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 9. direct-report
// ---------------------------------------------------------------------------------------------

/** A Writer in a group with a Reviewer; `reply` answers each turn by what woke it (see `check-back.test.ts`). */
function relayHarness(reply: (trigger: string) => string | { handoff: string }, ablation?: Ablation) {
  const root = mkdtempSync(join(tmpdir(), "ablation-direct-report-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const shown: ClientEvent[] = [];
  const engine = createTurnEngine({
    store,
    ablation,
    directQuietMs: 20,
    publish(event) {
      shown.push(event);
    },
    completions: {
      async complete(request) {
        const trigger = textOf(request.messages.find((m) => m.role === "user" && textOf(m).includes("（本轮触发）"))!);
        const answer = reply(trigger);
        if (typeof answer === "string") return say(answer);
        const results = request.messages.filter((m) => m.role === "tool");
        if (results.length === 0) return call("create_direct", { name: "Reviewer" });
        const opened = JSON.parse(textOf(results[0]!)) as { data: { session_id: string } };
        return call("send_message", { session_id: opened.data.session_id, body: answer.handoff });
      },
      async judge() {
        throw new Error("no judge");
      },
    },
  });
  const setup = async () => {
    await store.patchSettings({
      workspace_path: root,
      endpoint_base_url: "http://127.0.0.1:1/v1",
      endpoint_api_key: "fixture",
      endpoint_models: ["fixture"],
      endpoint_default_model: "fixture",
    });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }).bot;
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
    const group = store.createGroup({ name: "Cut", members: [writer.id, reviewer.id] });
    return { writer, reviewer, group };
  };
  const writerTurnsIn = (sessionId: string, writerId: string) =>
    shown.filter(
      (e): e is Extract<ClientEvent, { event: "turn.upsert" }> =>
        e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writerId && e.session_id === sessionId,
    );
  const cleanup = async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { store, engine, setup, writerTurnsIn, cleanup };
}

describe("engine/direct-report.ts: direct-report", () => {
  test("direct-report on (baseline): a Bot↔Bot direct that goes quiet calls its opener back to the group", async () => {
    const h = relayHarness((trigger) => {
      if (trigger.includes("回看：")) return "第一镜审过了，Reviewer 说通过。";
      if (trigger.includes("第一镜通过")) return "无需回复";
      if (trigger.includes("请审第一镜")) return "第一镜通过";
      return { handoff: "请审第一镜" };
    });
    try {
      const { writer, group } = await h.setup();
      const ask = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 第一镜送审到通过为止" });
      await h.engine.handleInboundMessage(ask, { fromUser: true });
      await until(() => h.writerTurnsIn(group.id, writer.id).length >= 2);
      expect(h.writerTurnsIn(group.id, writer.id)).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  });

  test("direct-report off: a quiet Bot↔Bot direct never calls its opener back", async () => {
    const h = relayHarness((trigger) => {
      // If ablation failed and a report-back happened anyway, keep it from looping forever while
      // still leaving a trace the assertions below would catch (an extra completed Writer turn).
      if (trigger.includes("回看：")) return "不应回看：direct-report 应该已关闭";
      if (trigger.includes("第一镜通过")) return "无需回复";
      if (trigger.includes("请审第一镜")) return "第一镜通过";
      return { handoff: "请审第一镜" };
    }, new Set(["direct-report"]));
    try {
      const { writer, group } = await h.setup();
      const ask = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 第一镜送审到通过为止" });
      await h.engine.handleInboundMessage(ask, { fromUser: true });

      const direct = await (async () => {
        await until(() => h.store.listSessions().some((s) => s.kind === "direct" && s.origin_session_id === group.id));
        return h.store.listSessions().find((s) => s.kind === "direct" && s.origin_session_id === group.id)!;
      })();
      await until(() => h.store.listMainMessages(direct.id, 10).length > 0 && h.store.listLiveTurns({ sessionId: direct.id }).length === 0);
      // Comfortably past directQuietMs (20ms), with nothing to book a report-back on.
      await Bun.sleep(150);
      expect(h.writerTurnsIn(group.id, writer.id)).toHaveLength(1);
      expect(h.store.listPendingCheckBacks()).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 10. local-api threading
// ---------------------------------------------------------------------------------------------

describe("local-api.ts: threads ablation into the engine it builds", () => {
  test("route-pick off, passed through createLocalApi (no engine given), skips the routing-agent call", async () => {
    const root = mkdtempSync(join(tmpdir(), "ablation-local-api-"));
    const store = new Store({ endpointKey: memoryKeyStore() });
    const calls: string[] = [];
    const events: ClientEvent[] = [];
    store.onCommit((event) => events.push(event));
    const api = createLocalApi({
      store,
      token: "test-token",
      schedule: false,
      ablation: parseAblation("route-pick"),
      completions: {
        async complete() {
          return say("ok");
        },
        async judge(request) {
          if (request.messages[0]?.content === ROUTE_PICK_SYSTEM) calls.push("route-pick");
          return judged('{"decision":"join","reason":"fixture"}');
        },
      },
    });
    try {
      await store.patchSettings({
        workspace_path: root,
        endpoint_base_url: "http://127.0.0.1:1/v1",
        endpoint_api_key: "fixture",
        endpoint_models: ["fixture"],
        endpoint_default_model: "fixture",
      });
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
      const session = writer.direct_session.id;
      const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报" });
      await api.engine.handleInboundMessage(trigger, { fromUser: true });
      await until(() =>
        events.some((event) => event.event === "turn.upsert" && (event as { status?: string }).status === "completed"),
      );

      expect(calls).toHaveLength(0);
      const turn = store.db
        .query<{ status: string }, [string]>("SELECT status FROM turns WHERE trigger_message_id = ?")
        .get(trigger.id);
      expect(turn?.status).toBe("completed");
    } finally {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
