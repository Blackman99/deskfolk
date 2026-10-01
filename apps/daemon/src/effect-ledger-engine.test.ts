import { expect, test } from "bun:test";
import { call, createScenario, endTurn, tool, writeFile } from "./test-kit/scenario";

test("a workspace effect has durable start and terminal evidence before its tool result is heard", async () => {
  const h = await createScenario({ supervision: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const trigger = h.store.postMessage(direct, { body: "Write a report" });
    h.store.fileMessage(trigger.id, { explicit: [{ taskId: plan.id }] });
    let receivedWithEvidence = false;
    h.script(bot!).reply(call(writeFile("report.md", "report")), ({ turn }) => {
      const rows = h.store.executionRecoveryFacts({ turnId: turn!.id }).executions;
      receivedWithEvidence = rows.some((row) => row.tool === "write_file" && row.outcome === "succeeded" && row.finished_at !== null);
      return call(endTurn());
    });
    await h.engine.handleInboundMessage(h.store.getMessage(trigger.id), { fromUser: true });
    await h.waitIdle();
    expect(receivedWithEvidence).toBe(true);
    const facts = h.store.executionRecoveryFacts({ turnId: h.turns(bot!)[0]!.id });
    expect(facts.executions).toHaveLength(1);
    expect(facts.hasUncertainEffects).toBe(false);
  } finally { await h.close(); }
});
