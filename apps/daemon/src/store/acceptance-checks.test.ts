import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import { Store } from ".";
import { HttpError } from "../errors";
import { CHECKS_MAX, CHECK_RUNS_KEPT, checkDefinitionKey } from "./acceptance-checks";

function status(error: unknown): number {
  return error instanceof HttpError ? error.status : -1;
}

function code(error: unknown): string {
  return error instanceof HttpError ? error.code : "";
}

function refused(work: () => unknown): { status: number; code: string } {
  try {
    work();
  } catch (error) {
    return { status: status(error), code: code(error) };
  }
  return { status: 0, code: "" };
}

/** A store with a real workspace directory, a bot, and an open plan. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acceptance-checks-"));
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const plan = store.openTask({ sessionId: writer.direct_session.id, title: "写周报" });
  return {
    root,
    store,
    bot: writer.bot,
    session: writer.direct_session,
    plan,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("normalizeCheckInput / createCheckByUser: 422s", () => {
  test("item is required", () => {
    const f = fixture();
    expect(refused(() => f.store.createCheckByUser(f.plan.id, { kind: "exists", path: "report.md" }))).toMatchObject({
      status: 422,
      code: "invalid_args",
    });
    f.close();
  });

  test("kind must be one of the four", () => {
    const f = fixture();
    expect(
      refused(() => f.store.createCheckByUser(f.plan.id, { item: "交出 report.md", kind: "verify" })),
    ).toMatchObject({ status: 422, code: "invalid_args" });
    f.close();
  });

  test("a file kind outside the workspace is refused, path resolved through symlinks", () => {
    const f = fixture();
    expect(
      refused(() => f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "../../etc/passwd" })),
    ).toMatchObject({ status: 422, code: "outside_workspace" });
    f.close();
  });

  test("no workspace open is outside_workspace too", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const plan = store.openTask({ sessionId: writer.direct_session.id, title: "写周报" });
    expect(refused(() => store.createCheckByUser(plan.id, { item: "x", kind: "exists", path: "report.md" }))).toMatchObject({
      status: 422,
      code: "outside_workspace",
    });
    store.close();
  });

  test("matches needs a pattern that compiles", () => {
    const f = fixture();
    expect(
      refused(() => f.store.createCheckByUser(f.plan.id, { item: "x", kind: "matches", path: "report.md", pattern: "(" })),
    ).toMatchObject({ status: 422, code: "invalid_args" });
    f.close();
  });

  test("a command that reaches outside the workspace is refused", () => {
    const f = fixture();
    expect(
      refused(() => f.store.createCheckByUser(f.plan.id, { item: "x", kind: "command", command: "cat /etc/passwd" })),
    ).toMatchObject({ status: 422, code: "outside_workspace" });
    f.close();
  });

  test("a command check defaults its cwd to the plan dir, which is inside the workspace", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "跑测试", kind: "command", command: "true" });
    expect(check).toMatchObject({ kind: "command", command: "true", cwd: null });
    f.close();
  });

  test("ticket_id must belong to the plan", () => {
    const f = fixture();
    const other = f.store.openTask({ sessionId: f.session.id, title: "另一件事" });
    const ticket = f.store.createTicket({ taskId: other.id, title: "别的任务", worker: null });
    expect(
      refused(() => f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "report.md", ticket_id: ticket.id })),
    ).toMatchObject({ status: 422, code: "invalid_args" });
    f.close();
  });

  test("more than CHECKS_MAX active checks is refused", () => {
    const f = fixture();
    for (let i = 0; i < CHECKS_MAX; i++) {
      f.store.createCheckByUser(f.plan.id, { item: `第 ${i} 条`, kind: "exists", path: `f${i}.md` });
    }
    expect(
      refused(() => f.store.createCheckByUser(f.plan.id, { item: "超额", kind: "exists", path: "over.md" })),
    ).toMatchObject({ status: 422, code: "too_many_checks" });
    expect(f.store.listChecks(f.plan.id)).toHaveLength(CHECKS_MAX);
    f.close();
  });
});

describe("createCheckByUser / listChecks", () => {
  test("a fresh check is source user, has no last_run, and is not running", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
    expect(check).toMatchObject({
      task_id: f.plan.id,
      ticket_id: null,
      item: "交出 report.md",
      kind: "exists",
      path: "report.md",
      source: "user",
      last_run: null,
      running: false,
      first_passed_at: null,
    });
    expect(check.created_at).toBe(check.updated_at);
    expect(check.created_at).toBe(check.defined_at);
    expect(f.store.listChecks(f.plan.id)).toEqual([check]);
    f.close();
  });
});

describe("patchCheckByUser", () => {
  test("pins an organizer-sourced check to the user", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    f.store.db.run(`UPDATE acceptance_checks SET source = 'organizer' WHERE id = ?`, [check.id]);
    const patched = f.store.patchCheckByUser(check.id, { item: "改过的措辞" });
    expect(patched.source).toBe("user");
    f.close();
  });

  test("changing only item/ticket_id keeps the definition, its runs, and first_passed_at", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    writeFileSync(join(f.root, "a.md"), "hello");
    const run = f.store.beginCheckRun(check.id, "user");
    f.store.finishCheckRun(run.id, { outcome: "pass", exitCode: null, detail: "5 bytes", output: null });
    const afterPass = f.store.getCheck(check.id);
    expect(afterPass.first_passed_at).toBeString();

    const renamed = f.store.patchCheckByUser(check.id, { item: "换了个说法" });
    expect(renamed).toMatchObject({ item: "换了个说法", path: "a.md", first_passed_at: afterPass.first_passed_at, defined_at: check.defined_at });
    expect(f.store.getCheckRun(run.id)).toMatchObject({ outcome: "pass" });
    f.close();
  });

  test("changing what it proves deletes its runs, resets first_passed_at, and bumps defined_at", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    const run = f.store.beginCheckRun(check.id, "user");
    f.store.finishCheckRun(run.id, { outcome: "pass", exitCode: null, detail: "ok", output: null });
    expect(f.store.getCheck(check.id).first_passed_at).toBeString();

    const redefined = f.store.patchCheckByUser(check.id, { path: "b.md" });
    expect(redefined.path).toBe("b.md");
    expect(redefined.first_passed_at).toBeNull();
    expect(redefined.last_run).toBeNull();
    expect(redefined.defined_at).not.toBe(check.defined_at);
    expect(refused(() => f.store.getCheckRun(run.id))).toMatchObject({ status: 404 });
    f.close();
  });

  test("if_revision must match updated_at", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    expect(refused(() => f.store.patchCheckByUser(check.id, { item: "y" }, "not-the-revision"))).toMatchObject({
      status: 409,
      code: "conflict",
    });
    const patched = f.store.patchCheckByUser(check.id, { item: "y" }, check.updated_at);
    expect(patched.item).toBe("y");
    f.close();
  });

  test("a removed check is check_gone on patch and on a second removal", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    f.store.removeCheckByUser(check.id);
    expect(refused(() => f.store.patchCheckByUser(check.id, { item: "y" }))).toMatchObject({ status: 409, code: "check_gone" });
    expect(refused(() => f.store.removeCheckByUser(check.id))).toMatchObject({ status: 409, code: "check_gone" });
    expect(f.store.listChecks(f.plan.id)).toEqual([]);
    f.close();
  });
});

describe("checkDefinitionKey", () => {
  test("differs only when what the check proves differs, not item or ticket_id", () => {
    const base = { kind: "exists" as const, path: "a.md", pattern: null, negate: false, command: null, cwd: null, expect_exit: null, expect_stdout: null, timeout_sec: null };
    expect(checkDefinitionKey(base)).toBe(checkDefinitionKey({ ...base }));
    expect(checkDefinitionKey(base)).not.toBe(checkDefinitionKey({ ...base, path: "b.md" }));
    expect(checkDefinitionKey(base)).not.toBe(checkDefinitionKey({ ...base, negate: true }));
  });
});

describe("beginCheckRun / finishCheckRun", () => {
  test("first_passed_at is stamped once, on the first pass, and not moved by a later pass", async () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    const first = f.store.beginCheckRun(check.id, "user");
    f.store.finishCheckRun(first.id, { outcome: "fail", exitCode: null, detail: "missing", output: null });
    expect(f.store.getCheck(check.id).first_passed_at).toBeNull();

    const second = f.store.beginCheckRun(check.id, "user");
    f.store.finishCheckRun(second.id, { outcome: "pass", exitCode: null, detail: "ok", output: null });
    const stamped = f.store.getCheck(check.id).first_passed_at;
    expect(stamped).toBeString();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = f.store.beginCheckRun(check.id, "user");
    f.store.finishCheckRun(third.id, { outcome: "pass", exitCode: null, detail: "still ok", output: null });
    expect(f.store.getCheck(check.id).first_passed_at).toBe(stamped);
    f.close();
  });

  test("a run in flight shows as running, with no last_run yet", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    f.store.beginCheckRun(check.id, "user");
    const live = f.store.getCheck(check.id);
    expect(live.running).toBe(true);
    expect(live.last_run).toBeNull();
    f.close();
  });

  test("prunes to CHECK_RUNS_KEPT, oldest dropped first", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    for (let i = 0; i < CHECK_RUNS_KEPT + 3; i++) {
      const run = f.store.beginCheckRun(check.id, "user");
      f.store.finishCheckRun(run.id, { outcome: "fail", exitCode: null, detail: `attempt ${i}`, output: null });
    }
    const left = f.store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM acceptance_check_runs WHERE check_id = ?`).get(check.id)!.n;
    expect(left).toBe(CHECK_RUNS_KEPT);
    expect(f.store.getCheck(check.id).last_run?.detail).toBe(`attempt ${CHECK_RUNS_KEPT + 2}`);
    f.close();
  });

  test("truncates detail and output to their limits", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    const run = f.store.beginCheckRun(check.id, "user");
    const finished = f.store.finishCheckRun(run.id, { outcome: "fail", exitCode: 1, detail: "x".repeat(500), output: "y".repeat(3000) });
    expect(finished.detail.length).toBeLessThanOrEqual(300);
    expect(finished.output!.length).toBeLessThanOrEqual(2000);
    f.close();
  });
});

describe("recoverInterruptedCheckRuns", () => {
  test("a run still open when the daemon starts closes as error", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    const run = f.store.beginCheckRun(check.id, "user");
    f.store.recoverInterruptedCheckRuns();
    expect(f.store.getCheckRun(run.id)).toMatchObject({ outcome: "error", finished_at: expect.any(String) });
    expect(f.store.getCheck(check.id).running).toBe(false);
    f.close();
  });
});

describe("rebindCheckItems", () => {
  test("a check follows its line to the same position when reworded", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
    f.store.rebindCheckItems(f.plan.id, ["交出 report.md", "第二条"], ["交出季度报表 report.md", "第二条"]);
    expect(f.store.getCheck(check.id).item).toBe("交出季度报表 report.md");
    f.close();
  });

  test("does nothing when the list length changed", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "交出 report.md", kind: "exists", path: "report.md" });
    f.store.rebindCheckItems(f.plan.id, ["交出 report.md"], ["交出 report.md", "新增一条"]);
    expect(f.store.getCheck(check.id).item).toBe("交出 report.md");
    f.close();
  });

  test("a reshuffle (the new line already existed) is left alone, not treated as a rename", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "第一条", kind: "exists", path: "a.md" });
    // "第一条" moved to slot 1 and "第二条" moved to slot 0: the check's line is still there, so
    // it is not touched even though the slot it used to sit in now says something else.
    f.store.rebindCheckItems(f.plan.id, ["第一条", "第二条"], ["第二条", "第一条"]);
    expect(f.store.getCheck(check.id).item).toBe("第一条");
    f.close();
  });

  test("an item that was already an orphan (not in before either) is left alone", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "对不上的条目", kind: "exists", path: "a.md" });
    f.store.rebindCheckItems(f.plan.id, ["别的条目"], ["改写后的条目"]);
    expect(f.store.getCheck(check.id).item).toBe("对不上的条目");
    f.close();
  });

  test("setPlanSpecByUser rebinds a reworded acceptance line automatically", () => {
    const f = fixture();
    const initialSpec = {
      kind: "周报" as const,
      goal: "写一份周报",
      acceptance: ["交到 report.md"],
      rules: [],
      process: [],
      progress: { done: [], open: [], blocked: [] },
      status: "active" as const,
    };
    f.store.setPlanSpecByUser(f.plan.id, initialSpec);
    const check = f.store.createCheckByUser(f.plan.id, { item: "交到 report.md", kind: "exists", path: "report.md" });
    f.store.setPlanSpecByUser(f.plan.id, { ...initialSpec, acceptance: ["交到季度 report.md"] }, 1);
    expect(f.store.getCheck(check.id).item).toBe("交到季度 report.md");
    f.close();
  });
});

describe("commandSeenInPlan", () => {
  test("true when a turn of this plan ran it, ok, exit 0, cwd equal", () => {
    const f = fixture();
    const trigger = f.store.postMessage(f.session.id, { body: "go" });
    const turn = f.store.createTurn({ sessionId: f.session.id, botId: f.bot.id, triggerMessageId: trigger.id });
    f.store.db.run(`UPDATE turns SET task_id = ? WHERE id = ?`, [f.plan.id, turn.id]);
    f.store.recordTurnRun({ turnId: turn.id, tool: "shell", command: "bun test", exitCode: 0, ok: true, cwd: f.plan.dir });
    expect(f.store.commandSeenInPlan(f.plan.id, "bun   test", f.plan.dir)).toBe(true);
    expect(f.store.commandSeenInPlan(f.plan.id, "bun test", "elsewhere")).toBe(false);
    expect(f.store.commandSeenInPlan(f.plan.id, "bun run build", f.plan.dir)).toBe(false);
    f.close();
  });

  test("a run with no recorded cwd matches leniently", () => {
    const f = fixture();
    const trigger = f.store.postMessage(f.session.id, { body: "go" });
    const turn = f.store.createTurn({ sessionId: f.session.id, botId: f.bot.id, triggerMessageId: trigger.id });
    f.store.db.run(`UPDATE turns SET task_id = ? WHERE id = ?`, [f.plan.id, turn.id]);
    f.store.recordTurnRun({ turnId: turn.id, tool: "shell", command: "bun test", exitCode: 0, ok: true });
    expect(f.store.commandSeenInPlan(f.plan.id, "bun test", f.plan.dir)).toBe(true);
    f.close();
  });

  test("a failed or non-zero run does not count", () => {
    const f = fixture();
    const trigger = f.store.postMessage(f.session.id, { body: "go" });
    const turn = f.store.createTurn({ sessionId: f.session.id, botId: f.bot.id, triggerMessageId: trigger.id });
    f.store.db.run(`UPDATE turns SET task_id = ? WHERE id = ?`, [f.plan.id, turn.id]);
    f.store.recordTurnRun({ turnId: turn.id, tool: "shell", command: "bun test", exitCode: 1, ok: true, cwd: f.plan.dir });
    expect(f.store.commandSeenInPlan(f.plan.id, "bun test", f.plan.dir)).toBe(false);
    f.close();
  });

  test("true when the user typed the exact command in a message filed under the plan", () => {
    const f = fixture();
    const said = f.store.postMessage(f.session.id, { body: "先跑一下 `bun test` 看看" });
    f.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [f.plan.id, said.id]);
    expect(f.store.commandSeenInPlan(f.plan.id, "bun test", null)).toBe(true);
    expect(f.store.commandSeenInPlan(f.plan.id, "bun run build", null)).toBe(false);
    f.close();
  });
});

describe("cascade", () => {
  test("deleting the plan drops its checks and runs", () => {
    const f = fixture();
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    const run = f.store.beginCheckRun(check.id, "user");
    f.store.db.run(`DELETE FROM tasks WHERE id = ?`, [f.plan.id]);
    expect(f.store.db.query(`SELECT id FROM acceptance_checks WHERE id = ?`).get(check.id)).toBeNull();
    expect(f.store.db.query(`SELECT id FROM acceptance_check_runs WHERE id = ?`).get(run.id)).toBeNull();
    f.close();
  });

  test("deleting a ticket clears ticket_id rather than the check", () => {
    const f = fixture();
    const ticket = f.store.createTicket({ taskId: f.plan.id, title: "初稿", worker: null });
    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md", ticket_id: ticket.id });
    f.store.db.run(`DELETE FROM tickets WHERE id = ?`, [ticket.id]);
    expect(f.store.getCheck(check.id).ticket_id).toBeNull();
    f.close();
  });
});

describe("task.upsert carries checks", () => {
  test("creating, patching, running, and removing a check all raise task.upsert with the new checks", () => {
    const f = fixture();
    const seen: ClientEvent[] = [];
    f.store.onCommit((event) => seen.push(event));

    const check = f.store.createCheckByUser(f.plan.id, { item: "x", kind: "exists", path: "a.md" });
    let upserts = seen.filter((event) => event.event === "task.upsert");
    expect(upserts.length).toBeGreaterThan(0);
    expect(upserts.at(-1)).toMatchObject({ id: f.plan.id, checks: [{ id: check.id, item: "x" }] });

    seen.length = 0;
    const run = f.store.beginCheckRun(check.id, "user");
    upserts = seen.filter((event) => event.event === "task.upsert");
    expect(upserts.at(-1)).toMatchObject({ checks: [{ id: check.id, running: true }] });

    seen.length = 0;
    f.store.finishCheckRun(run.id, { outcome: "pass", exitCode: null, detail: "ok", output: null });
    upserts = seen.filter((event) => event.event === "task.upsert");
    expect(upserts.at(-1)).toMatchObject({ checks: [{ id: check.id, running: false, last_run: { outcome: "pass" } }] });

    seen.length = 0;
    f.store.removeCheckByUser(check.id);
    upserts = seen.filter((event) => event.event === "task.upsert");
    expect(upserts.at(-1)).toMatchObject({ checks: [] });

    f.close();
  });
});
