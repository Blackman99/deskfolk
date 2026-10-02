import { afterEach, expect, test } from "bun:test";
import { call, createScenario, failed, say, shell, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/**
 * ADR 0050: a turn that fails by its shape is the model's quality event wherever it ran — a direct
 * with no plan too (the 4414× loop of 09-29 ran in one) — and an endpoint that could not be reached
 * is nobody's. Below level 8 nothing is filed.
 */
test("a reply that loops is filed on the Bot and its model wherever it ran; an unreachable endpoint is not", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [writer] = h.createBots("Writer");
  const dm = h.direct(writer!);
  // A failed reply is tried once more before the turn fails.
  h.script(writer!, dm).reply(failed("repeat"), failed("repeat"));
  h.postUser(dm, "写一份周报");
  await h.waitIdle();
  h.script(writer!, dm).reply(failed("unreachable"), failed("unreachable"));
  h.postUser(dm, "再试一次");
  await h.waitIdle();
  const filed = h.store.listQualityEvents().map((row) => ({ kind: row.kind, category: row.category, bot: row.bot_id, model: row.model }));
  expect(filed).toEqual([{ kind: "failure_shape:repeat", category: "model", bot: writer!.id, model: expect.any(String) }]);
});

test("below level 8 a failed turn files nothing", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const [writer] = h.createBots("Writer");
  const dm = h.direct(writer!);
  h.script(writer!, dm).reply(failed("repeat"), failed("repeat"));
  h.postUser(dm, "写一份周报");
  await h.waitIdle();
  expect(h.store.db.query("SELECT status FROM turns").all()).toEqual([{ status: "completed" }]);
  expect(h.store.listQualityEvents()).toEqual([]);
});

test.skipIf(process.platform === "win32")("a command that runs long without walking a tree is not learned from", async () => {
  const h = await createScenario({ learning: true, shellTimeoutMs: 300 });
  open.push(h);
  const [writer] = h.createBots("Writer");
  const dm = h.direct(writer!);
  h.script(writer!, dm).reply(call(shell("sleep 5")), call(shell("sleep 5")), say("渲染太久了"));
  h.postUser(dm, "渲染一下");
  await h.waitIdle();
  expect(h.toolCalls(writer!, "shell").map(({ result }) => result?.error ?? null)).toEqual(["failed", "failed"]);
  expect(h.store.listLessons()).toEqual([]);
});
