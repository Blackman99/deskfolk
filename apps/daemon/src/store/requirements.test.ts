/**
 * The requirements ledger (需求台账, ADR 0040): entries stand on your words, are raised again by
 * them, and every change is in the work log. The one delete is your purge, and the database itself
 * refuses any other (I4).
 */
import { describe, expect, test } from "bun:test";
import { Store } from ".";
import { REQUIREMENT_PURGE_ABORT, REQUIREMENT_QUOTE_MAX } from "./requirements";

/** Your direct with 视频导演, a plan it opened on a line of yours, and that line's quote. */
function fixture() {
  const store = new Store();
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session.id;
  const line = store.postMessage(direct, { body: "片长 2 分钟左右，机械臂是左手" });
  const turn = store.createTurn({ sessionId: direct, botId: director.bot.id, triggerMessageId: line.id });
  const quote = store.listQuotes({ messageId: line.id })[0]!;
  return { store, direct, planId: turn.task_id!, quote };
}

describe("an entry", () => {
  test("stands on your words: added with its first mention, raised with each later one, each change logged", () => {
    const { store, direct, planId, quote } = fixture();
    const entry = store.addRequirement({
      scope: "plan",
      scopeId: planId,
      quote: "片长 2 分钟左右",
      restated: "母带时长约 120 秒",
      category: "duration",
      dimension: "duration",
      value: { approx_sec: 120 },
      sourceKind: "message",
      sourceQuoteId: quote.id,
      addedBy: "app",
    });
    expect(entry).toMatchObject({
      scope: "plan",
      scope_id: planId,
      quote: "片长 2 分钟左右",
      polarity: "must",
      value: { approx_sec: 120 },
      status: "open",
      times_raised: 1,
    });

    const again = store.postMessage(direct, { body: "再说一次，两分钟左右" });
    const [second] = store.listQuotes({ messageId: again.id });
    const raised = store.raiseRequirement(entry.id, { quoteId: second!.id, actor: "scribe" });
    expect(raised.times_raised).toBe(2);
    expect(raised.last_raised_at > entry.last_raised_at).toBe(true);
    expect(store.requirementMentions(entry.id).map((row) => row.quote_id)).toEqual([quote.id, second!.id]);

    expect(store.listWorkEvents().filter((row) => row.kind.startsWith("requirement.")).map((row) => [row.kind, row.actor, row.payload])).toEqual([
      ["requirement.add", "app", { requirement: entry.id, scope: "plan", scope_id: planId, source_kind: "message", status: "open" }],
      ["requirement.raise", "scribe", { requirement: entry.id, quote: second!.id }],
    ]);
    expect(store.listRequirements({ scope: "plan", scopeId: planId }).map((row) => row.id)).toEqual([entry.id]);
    store.close();
  });

  test("carries at most REQUIREMENT_QUOTE_MAX code points of your words, and names what it holds for", () => {
    const { store, planId, quote } = fixture();
    const long = store.addRequirement({ scope: "plan", scopeId: planId, quote: "镜".repeat(REQUIREMENT_QUOTE_MAX + 5), sourceKind: "legacy", addedBy: "app", status: "unverified" });
    expect([...long.quote]).toHaveLength(REQUIREMENT_QUOTE_MAX);
    expect(() => store.addRequirement({ scope: "plan", scopeId: planId, quote: "   ", sourceKind: "message", addedBy: "app" })).toThrow("needs your words");
    expect(() => store.addRequirement({ scope: "plan", scopeId: null, quote: "x", sourceKind: "message", addedBy: "app" })).toThrow("names what it holds for");
    expect(() => store.addRequirement({ scope: "standing", scopeId: planId, quote: "x", sourceKind: "message", addedBy: "app" })).toThrow("names what it holds for");
    expect(() => store.addRequirement({ scope: "plan", scopeId: planId, quote: "x", sourceKind: "message", sourceQuoteId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", addedBy: "app" })).toThrow("quote not found");
    expect(store.addRequirement({ scope: "standing", scopeId: null, domain: "video", quote: "不用冻帧补时长", sourceKind: "board", addedBy: "user" }).scope_id).toBeNull();
    expect(store.requirementMentions(long.id)).toEqual([]);
    expect(quote.body).toBe("片长 2 分钟左右，机械臂是左手");
    store.close();
  });
});

describe("the words an entry stands on", () => {
  test("must be words of the quote it names, compared without spaces, punctuation, width or case", () => {
    const { store, direct, planId, quote } = fixture();
    const add = (words: string, sourceQuoteId = quote.id) =>
      store.addRequirement({ scope: "plan", scopeId: planId, quote: words, sourceKind: "message", sourceQuoteId, addedBy: "scribe" });
    expect(add("片长２分钟左右，机械臂").quote).toBe("片长２分钟左右，机械臂");
    const english = store.postMessage(direct, { body: "Keep it UNDER two minutes, please." });
    const [said] = store.listQuotes({ messageId: english.id });
    expect(add("keep it under two-minutes", said!.id).quote).toBe("keep it under two-minutes");
    // Words the line does not hold, a restatement, or nothing but punctuation: refused, and nothing written.
    for (const words of ["片长约 3 分钟", "机械臂是右手", "母带时长约 120 秒", "，。！"]) {
      expect(() => add(words), words).toThrow("must be words of the quote it names");
    }
    expect(store.listRequirements()).toHaveLength(2);
    expect(store.listWorkEvents({ kind: "requirement.add" })).toHaveLength(2);
    store.close();
  });

  test("cannot be words you erased", () => {
    const { store, direct, planId, quote } = fixture();
    store.clearSessionMessages(direct, { eraseQuotes: true });
    expect(store.getQuote(quote.id)).toMatchObject({ body: "", redacted_at: expect.any(String) });
    expect(() =>
      store.addRequirement({ scope: "plan", scopeId: planId, quote: "机械臂是左手", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "scribe" }),
    ).toThrow("must be words of the quote it names");
    store.close();
  });
});

describe("I4: only your purge deletes an entry", () => {
  test("a delete the work log holds no purge for is refused by the database, whoever issues it", () => {
    const { store, planId, quote } = fixture();
    const entry = store.addRequirement({ scope: "plan", scopeId: planId, quote: "机械臂是左手", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "app" });
    const other = store.addRequirement({ scope: "plan", scopeId: planId, quote: "片长 2 分钟左右", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "app" });

    expect(() => store.db.run(`DELETE FROM requirements WHERE id = ?`, [entry.id])).toThrow(REQUIREMENT_PURGE_ABORT);
    // A purge of another entry lets only that one go; one naming nothing, nothing.
    store.recordWorkEvent({ kind: "requirement.purge", actor: "user", payload: { requirements: [other.id] } });
    store.recordWorkEvent({ kind: "requirement.purge", actor: "user", payload: {} });
    expect(() => store.db.run(`DELETE FROM requirements`)).toThrow(REQUIREMENT_PURGE_ABORT);
    expect(store.listRequirements().map((row) => row.id)).toEqual([entry.id, other.id]);
    // Another kind naming it does not count either.
    store.recordWorkEvent({ kind: "requirement.waive", actor: "user", payload: { requirements: [entry.id] } });
    expect(() => store.db.run(`DELETE FROM requirements WHERE id = ?`, [entry.id])).toThrow(REQUIREMENT_PURGE_ABORT);
    store.close();
  });

  test("your purge logs itself first and takes the entries it names, with their mentions", () => {
    const { store, planId, quote } = fixture();
    const entry = store.addRequirement({ scope: "plan", scopeId: planId, quote: "机械臂是左手", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "app" });
    const kept = store.addRequirement({ scope: "plan", scopeId: planId, quote: "片长 2 分钟左右", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "app" });

    expect(store.purgeRequirements([entry.id, entry.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV"], { taskId: planId })).toEqual([entry.id]);
    expect(() => store.getRequirement(entry.id)).toThrow("requirement not found");
    expect(store.requirementMentions(entry.id)).toEqual([]);
    expect(store.listRequirements().map((row) => row.id)).toEqual([kept.id]);
    expect(store.listWorkEvents({ kind: "requirement.purge" })).toMatchObject([{ actor: "user", task_id: planId, payload: { requirements: [entry.id] } }]);
    // The words it stood on are yours, not the ledger's: they stay.
    expect(store.listQuotes({ taskId: planId }).map((row) => row.id)).toEqual([quote.id]);
    expect(store.purgeRequirements(["01ARZ3NDEKTSV4RRFFQ69G5FAV"])).toEqual([]);
    expect(store.listWorkEvents({ kind: "requirement.purge" })).toHaveLength(1);
    store.close();
  });
});
