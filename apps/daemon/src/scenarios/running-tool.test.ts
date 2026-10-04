/**
 * A live turn knows the tool call it is running, from its start until it exits, so a window that
 * missed the start can say so instead of 「思考中」 (2026-10-04: a `qlmanage` that hung for ten
 * minutes under a real-model run read 「思考中」 the whole time).
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, shell, tool, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("a live turn says which tool call it is running, and stops saying it when the call exits", async () => {
  const h = await createScenario();
  open.push(h);
  const [bot] = h.createBots("设计师");
  const direct = h.direct(bot!);
  h.script(bot!).handle(({ hop }) => hop === 1 ? call(shell("sleep 1")) : call(tool("end_turn", { reason: "done" })));
  h.postUser(direct, "出一张图");
  await h.waitFor(() => h.turns(bot!).some((turn) => h.engine.runningTool(turn.id) !== null), { timeoutMs: 4_000, what: "the shell running" });
  const live = h.turns(bot!)[0]!;
  expect(h.engine.runningTool(live.id)).toMatchObject({ name: "shell", target: expect.stringContaining("sleep 1") });
  await h.waitIdle({ timeoutMs: 8_000 });
  expect(h.engine.runningTool(live.id)).toBeNull();
});
