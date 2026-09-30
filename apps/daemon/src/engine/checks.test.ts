/**
 * `createPlanChecks` itself: the injection point the task doc asks for ("`judgeContinuity(evidence,
 * rules) => Promise<...>` injected into `createPlanChecks` so tests fake it") is exercised through
 * `evaluate`'s `opts.continuity`, not the judge directly — the judge is `acceptance-eval`'s and
 * `seams-check`'s to test. What belongs here is the runner's own behavior: a `continuity` (衔接
 * 一致 / "Seams") check shares the same daemon-wide exclusive queue a `command` check does, and it
 * is handed its plan's dir, rules and session — the deps `seams-check.ts` cannot get any other way.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckVerdict } from "../acceptance-eval";
import { Store } from "../store";
import { createWakeWatch } from "../wake";
import { createPlanChecks, type CheckEvaluator } from "./checks";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plan-checks-"));
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const a = store.createBot({ name: "A", duties: "write", boundaries: "none" });
  const b = store.createBot({ name: "B", duties: "write", boundaries: "none" });
  const planA = store.openTask({ sessionId: a.direct_session.id, title: "跑测试" });
  const planB = store.openTask({ sessionId: b.direct_session.id, title: "拼装样片" });
  return {
    root,
    store,
    planA,
    planB,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("createPlanChecks: continuity", () => {
  test("a continuity check shares the command check's exclusive queue, and gets its plan's dir/rules/session", async () => {
    const f = fixture();
    f.store.setPlanSpecByUser(f.planB.id, {
      kind: "样片",
      goal: "拼装样片",
      acceptance: ["镜头连贯"],
      rules: ["义肢在左手"],
      process: [],
      progress: { done: [], open: [], blocked: [] },
      status: "active",
    });

    const order: string[] = [];
    let seenContinuity: Parameters<CheckEvaluator>[2]["continuity"];
    const evaluate: CheckEvaluator = async (_root, check, opts): Promise<CheckVerdict> => {
      if (check.kind === "command") {
        order.push("command:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("command:end");
        return { outcome: "pass", exitCode: 0, detail: "ok", output: null };
      }
      order.push("continuity:start");
      seenContinuity = opts.continuity;
      order.push("continuity:end");
      return { outcome: "pass", exitCode: null, detail: "ok", output: null };
    };

    const checks = createPlanChecks({ store: f.store, wake: createWakeWatch(), renderMirrors: () => {}, evaluate });
    const cmdCheck = f.store.createCheckByUser(f.planA.id, { item: "跑起来", kind: "command", command: "true" });
    const contCheck = f.store.createCheckByUser(f.planB.id, { item: "镜头连贯", kind: "continuity", command: "true" });

    await Promise.all([
      checks.run(f.planA.id, { cause: "user", checkIds: [cmdCheck.id] }),
      checks.run(f.planB.id, { cause: "user", checkIds: [contCheck.id] }),
    ]);

    expect(order).toEqual(["command:start", "command:end", "continuity:start", "continuity:end"]);
    expect(seenContinuity).toMatchObject({ planDir: f.planB.dir, rules: ["义肢在左手"], sessionId: f.planB.session_id });
    expect(f.store.getCheck(cmdCheck.id).last_run).toMatchObject({ outcome: "pass" });
    expect(f.store.getCheck(contCheck.id).last_run).toMatchObject({ outcome: "pass" });
    f.close();
  });

  test("with no judgeContinuity wired up, a continuity check still closes with a terminal outcome rather than crashing the runner", async () => {
    const f = fixture();
    const checks = createPlanChecks({ store: f.store, wake: createWakeWatch(), renderMirrors: () => {} });
    const check = f.store.createCheckByUser(f.planB.id, { item: "镜头连贯", kind: "continuity", path: "renders/master.mp4" });
    await checks.run(f.planB.id, { cause: "user", checkIds: [check.id] });
    // No video at that path either way, so this closes as `fail` before ever reaching the judge —
    // the point is only that nothing threw past `run` and a run did close.
    expect(f.store.getCheck(check.id).running).toBe(false);
    expect(["pass", "fail", "blocked", "error"]).toContain(f.store.getCheck(check.id).last_run?.outcome ?? "");
    f.close();
  });
});
