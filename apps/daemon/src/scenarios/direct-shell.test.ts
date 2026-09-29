/**
 * Smoke scenario for the scenario harness (`test-kit/scenario.ts`), and the shape the incident
 * fixtures next to it follow: you ask one Bot in your direct, it runs a command, then answers with
 * what the command printed. Behaviour that ships today, so a plain `test`.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, say, shell, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("you ask a Bot in your direct: it runs a command, answers with the output, and the turn is on record", async () => {
  const h = await createScenario();
  open.push(h);
  const [builder] = h.createBots("Builder");
  const dm = h.direct(builder!);
  h.script(builder!, dm).reply(call(shell("echo scenario-ok")), ({ results }) => {
    const printed = (JSON.parse(results[0]!.content) as { data: { stdout: string } }).data.stdout.trim();
    return say(`跑了，输出是 ${printed}`);
  });

  const asked = h.postUser(dm, "跑一下 echo 看看");
  await h.waitIdle();

  const [turn, ...more] = h.turns(builder!);
  expect(more).toEqual([]);
  expect(turn).toMatchObject({ session_id: dm, trigger_message_id: asked.id, status: "completed" });
  expect(h.runs(builder!).map(({ turn_id, tool, command, exit_code, ok }) => ({ turn_id, tool, command, exit_code, ok }))).toEqual([
    { turn_id: turn!.id, tool: "shell", command: "echo scenario-ok", exit_code: 0, ok: 1 },
  ]);
  expect(h.messages(dm).map(({ kind, author, body, turn_id }) => ({ kind, author, body, turn_id }))).toEqual([
    { kind: "user", author: "user", body: "跑一下 echo 看看", turn_id: null },
    { kind: "bot", author: builder!.id, body: "跑了，输出是 scenario-ok", turn_id: turn!.id },
  ]);
  // Two hops, both scripted; the shell call ran, came back ok, and is the one side effect.
  expect(h.hops(builder!).map((hop) => hop.hop)).toEqual([1, 2]);
  expect(h.unscripted()).toEqual([]);
  expect(h.sideEffectCalls(builder!, asked).map(({ name, turnId, result }) => ({ name, turnId, result }))).toEqual([
    { name: "shell", turnId: turn!.id, result: { ok: true, error: null } },
  ]);
});
