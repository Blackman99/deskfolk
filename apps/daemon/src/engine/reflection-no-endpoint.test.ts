/**
 * Set up on Claude Code alone (ADR 0078): with no endpoint at all, a reflection still runs on the
 * Claude model you chose for reflections, and with neither nothing is claimed, so it waits.
 */
import { afterEach, expect, test } from "bun:test";
import { isoNow } from "../ids";
import { Store } from "../store";
import { ENGINE_LEVELS } from "../store/schema-gate";
import type { ClaudeJudge } from "../claude-code/reading";
import { createReflector } from "./reflection";
import type { BuiltinTarget } from "./builtin-models";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function dueReflection() {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(ENGINE_LEVELS.learning)]);
  const maker = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" }).bot;
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "Studio", members: [maker.id, reviewer.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: plan.id, title: "第七镜", worker: maker.id });
  store.recordWorkEvent({ kind: "review.miss", actor: "user", botId: reviewer.id, taskId: plan.id, ticketId: ticket.id,
    payload: { reviewer_bot_id: reviewer.id, reviewer_model: "sonnet", message_id: null, card_id: "card-1" } });
  return store;
}

function reflectorOn(store: Store, chosen: BuiltinTarget | null, claudeJudge: ClaudeJudge) {
  const tracked: Promise<unknown>[] = [];
  const reflector = createReflector({
    store,
    completions: {} as never,
    routing: { credentials: async () => null, decideRoute: () => { throw new Error("no endpoint to route to"); } },
    spend: { spendOwner: () => ({}), record: () => null } as never,
    track: (promise) => { tracked.push(promise); return promise; },
    publishMessage: () => {},
    builtinTarget: async (role) => (role === "reflection" ? chosen : null),
    claudeJudge,
  });
  return { reflect: async () => { reflector.reflect(new Date(isoNow())); await Promise.all(tracked); } };
}

test("with no endpoint, a reflection runs on the Claude model chosen for it", async () => {
  const store = dueReflection();
  const asked: string[] = [];
  const { reflect } = reflectorOn(store, { kind: "claude_code", model: "sonnet", configDir: null, effort: "high" }, async ({ target }) => {
    asked.push(target.model);
    return { content: JSON.stringify({ kind: "none", reason: "nothing to learn" }), usage: null, fail: null };
  });
  await reflect();
  expect(asked).toEqual(["sonnet"]);
  expect(store.claimDueReflection()).toBeNull();
});

test("with no endpoint and no Claude model chosen, nothing is claimed: the reflection waits for a model", async () => {
  const store = dueReflection();
  let asked = 0;
  const { reflect } = reflectorOn(store, null, async () => {
    asked += 1;
    return { content: null, usage: null, fail: "claude_unavailable" };
  });
  await reflect();
  expect(asked).toBe(0);
  expect(store.claimDueReflection()).not.toBeNull();
});
