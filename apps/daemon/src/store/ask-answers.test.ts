import { expect, test } from "bun:test";
import { isoNow } from "../ids";
import { Store } from "./index";

test("an answer lives on the question: readers see it there, a late answer counts as new, search finds it", () => {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const plan = store.openTask({ sessionId: session, title: "写周报" });
  const opener = store.postMessage(session, { body: "写一份周报" });
  const turn = store.createTurn({ sessionId: session, botId: writer.bot.id, triggerMessageId: opener.id, taskId: plan.id });
  const ask = store.insertMessage({
    sessionId: session,
    turnId: turn.id,
    kind: "ask",
    author: writer.bot.id,
    body: "发给谁？",
    ask: { options: [{ label: "团队" }, { label: "老板" }], multi_select: false },
  });
  expect(ask.ask).toEqual({ options: [{ label: "团队" }, { label: "老板" }], multi_select: false });
  expect(ask.ask_answer).toBeNull();
  // Only a question carries the fields at all.
  expect("ask" in store.getMessage(opener.id)).toBe(false);

  // The store's own clock: it never goes backwards, so it can run ahead of the wall clock.
  const since = isoNow();
  expect(store.taskMessagesSince(plan.id, since).map((row) => row.id)).toEqual([]);

  const answered = store.recordAskAnswer(ask.id, { selected: ["老板"], custom: "抄送财务", answered_at: isoNow() });
  expect(answered.ask_answer).toMatchObject({ selected: ["老板"], custom: "抄送财务" });
  expect(store.listMessages(session).items.filter((m) => m.author === "user")).toHaveLength(1);

  const rows = store.taskMessagesSince(plan.id, since);
  expect(rows.map((row) => row.id)).toEqual([ask.id]);
  expect(rows[0]!.body).toBe("发给谁？\n选项（单选）：团队 / 老板\n用户选了：老板\n用户补充：抄送财务");

  expect(store.search("抄送财务").some((hit) => hit.kind === "message" && hit.id === ask.id)).toBe(true);
  expect(() => store.recordAskAnswer(ask.id, { selected: ["团队"], custom: null, answered_at: isoNow() }))
    .toThrow("ask is no longer pending");
  expect(() => store.recordAskAnswer(opener.id, { selected: [], custom: "x", answered_at: isoNow() }))
    .toThrow("only a question takes an answer");
  store.close();
});
