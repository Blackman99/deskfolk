import { expect, test } from "bun:test";
import { call, createScenario, tool, writeFile } from "./test-kit/scenario";

test("a blocked segment leaves an answerable question and an explicit answer dispatches its original work", async () => {
  const h = await createScenario({ supervision: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const line = h.store.postMessage(direct, { body: "Write the report" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    let heard = false;
    h.script(bot!).reply(call(tool("end_turn", { reason: "blocked", needs_from_user: "Which audience?" })),
      ({ request }) => { heard = request.messages.some((message) => typeof message.content === "string" && message.content.includes("New readers")); return call(writeFile("report.md", "for new readers")); },
      call(tool("end_turn", { reason: "answered" })));
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    const question = h.messages(direct).find((message) => message.control?.kind === "work_question")!;
    expect(question.control?.kind).toBe("work_question");
    expect(h.turns(bot!)[0]!.status).toBe("completed");
    const result = h.store.answerWorkQuestion(question.id, { body: "New readers", userActionId: "answer" });
    expect(result.answered).toBe(true);
    h.engine.dispatchQueuedWork();
    await h.waitIdle();
    expect(heard).toBe(true);
    expect(h.turns(bot!).filter((turn) => turn.task_id === plan.id)).toHaveLength(2);
    expect(h.toolCalls(bot!, "write_file")[0]!.result?.ok).toBe(true);
  } finally { await h.close(); }
});
