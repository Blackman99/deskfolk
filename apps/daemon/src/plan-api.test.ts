import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDetail, Ticket } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { PLAN_MAP_FILE, Store, TICKET_FILE, type PlanSpec } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

const spec: PlanSpec = {
  kind: "周报",
  goal: "写一份周报",
  acceptance: ["交到 report.md"],
  rules: [],
  process: [],
  progress: { done: [], open: [], blocked: [] },
  status: "active",
};

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "plan-api-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  await store.patchSettings({ workspace_path: root });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const origin = `http://127.0.0.1:${server.port}`;
  closes.push(async () => {
    await api.engine.close();
    await server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return { root, store, call };
}

test("a plan is read whole, its spec and tickets are edited under a revision guard, and the mirrors follow", async () => {
  const h = await harness();
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const opener = h.store.postMessage(session, { body: "写一份周报" });
  const applied = h.store.applyOrganizerResult({
    sessionId: session,
    current: null,
    result: {
      decision: "new",
      resumePlanId: null,
      spec,
      tickets: [{ id: "new-1", title: "初稿", spec: "", status: "doing", worker: writer.bot.id }],
      messageTicket: "new-1",
    },
    source: { messageId: opener.id, turnId: null, messageBody: opener.body },
  });
  const plan = applied.task;
  const ticket = applied.tickets[0]!;

  const detail = await h.call("GET", `/v1/tasks/${plan.id}`);
  expect(detail.status).toBe(200);
  expect(detail.json).toMatchObject({ id: plan.id, goal: "写一份周报", kind: "周报", status: "active", brief: "写一份周报", revision: 1, revision_actor: "app", spec, tickets: [{ id: ticket.id, artifacts: [] }] });
  expect((await h.call("GET", `/v1/tasks/${plan.id}/tickets`)).json).toMatchObject({ items: [{ id: ticket.id, status: "doing", worker: writer.bot.id }] });
  expect((await h.call("GET", `/v1/tasks/${plan.id}/spec-revisions`)).json).toMatchObject({
    items: [{ revision: 1, actor: "app", source_message_id: opener.id, session_id: session, tickets_snapshot: [{ id: ticket.id }] }],
  });
  expect((await h.call("GET", "/v1/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status).toBe(404);
  expect((await h.call("GET", `/v1/sessions/${session}/tasks`)).json).toMatchObject({ items: [{ id: plan.id, goal: "写一份周报", ticket_counts: { doing: 1 } }] });

  // Your edit of the spec is the whole spec, guarded by the revision you saw; it is recorded as yours.
  const edited = await h.call("PATCH", `/v1/tasks/${plan.id}/spec`, { spec: { ...spec, rules: ["不要口语"] }, if_revision: 1 });
  expect(edited.status).toBe(200);
  expect(edited.json).toMatchObject({ id: plan.id, revision: 2, revision_actor: "user", spec: { ...spec, rules: ["不要口语"] } });
  expect((await h.call("PATCH", `/v1/tasks/${plan.id}/spec`, { spec, if_revision: 1 })).status).toBe(409);
  expect((await h.call("PATCH", `/v1/tasks/${plan.id}/spec`, { spec: { kind: "周报" } })).status).toBe(422);
  expect((await h.call("PATCH", "/v1/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/spec", { spec })).status).toBe(404);
  expect(readFileSync(join(h.root, plan.dir, PLAN_MAP_FILE), "utf8")).toContain("- 不要口语");

  // Your edit of a ticket changes only the fields you send and is a revision of the plan too.
  const moved = await h.call("PATCH", `/v1/tickets/${ticket.id}`, { status: "done", if_revision: 2 });
  expect(moved.status).toBe(200);
  expect(moved.json).toMatchObject({ id: ticket.id, title: "初稿", status: "done", worker: writer.bot.id });
  expect((moved.json as unknown as Ticket).closed_at).toBeString();
  expect((await h.call("GET", `/v1/tasks/${plan.id}`)).json).toMatchObject({ revision: 3, revision_actor: "user", ticket_counts: { doing: 0, done: 1 } });
  expect((await h.call("PATCH", `/v1/tickets/${ticket.id}`, { status: "later" })).status).toBe(422);
  expect((await h.call("PATCH", `/v1/tickets/${ticket.id}`, { title: "x", if_revision: 1 })).status).toBe(409);
  expect((await h.call("PATCH", "/v1/tickets/01ARZ3NDEKTSV4RRFFQ69G5FAV", { status: "done" })).status).toBe(404);
  expect(readFileSync(join(h.root, ticket.dir, TICKET_FILE), "utf8")).toContain("- 状态：已完成");
  expect(h.store.listSpecRevisions(plan.id).map((row) => [row.revision, row.actor])).toEqual([[3, "user"], [2, "user"], [1, "app"]]);
});

/** Polls until `fn` returns truthy or the timeout passes, for a check run kicked off after commit. */
async function until<T>(fn: () => T, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("acceptance checks: create, patch, run, delete, mirrors, and TaskDetail.checks", async () => {
  const h = await harness();
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const opener = h.store.postMessage(session, { body: "写一份周报" });
  const applied = h.store.applyOrganizerResult({
    sessionId: session,
    current: null,
    result: { decision: "new", resumePlanId: null, spec, tickets: [], messageTicket: null },
    source: { messageId: opener.id, turnId: null, messageBody: opener.body },
  });
  const plan = applied.task;

  // 422: an unknown kind is refused.
  expect((await h.call("POST", `/v1/tasks/${plan.id}/checks`, { item: "x", kind: "verify" })).status).toBe(422);

  // Create: 201, whole TaskDetail with the new check.
  const created = await h.call("POST", `/v1/tasks/${plan.id}/checks`, { item: "交到 report.md", kind: "exists", path: "missing.md" });
  expect(created.status).toBe(201);
  const detail = created.json as unknown as TaskDetail;
  expect(detail.checks).toHaveLength(1);
  const check = detail.checks![0]!;
  expect(check).toMatchObject({ item: "交到 report.md", kind: "exists", path: "missing.md", source: "user" });

  // A create runs the check itself (cause edit): it starts as missing, so it settles as fail.
  await until(() => h.store.getCheck(check.id).last_run !== null);
  expect(h.store.getCheck(check.id).last_run).toMatchObject({ outcome: "fail" });
  const mapAfterCreate = readFileSync(join(h.root, plan.dir, PLAN_MAP_FILE), "utf8");
  expect(mapAfterCreate).toContain("交到 report.md");
  expect(mapAfterCreate).toContain("文件存在：missing.md");

  // Patch: redefining the check (a new path) re-runs it; this time the file is there, so it passes.
  writeFileSync(join(h.root, "report.md"), "hello");
  const patched = await h.call("PATCH", `/v1/checks/${check.id}`, { path: "report.md" });
  expect(patched.status).toBe(200);
  await until(() => h.store.getCheck(check.id).last_run?.outcome === "pass");

  // 409: a stale if_revision is refused.
  expect((await h.call("PATCH", `/v1/checks/${check.id}`, { item: "y", if_revision: "not-the-revision" })).status).toBe(409);

  // Manual run: 202, and it runs even though nothing changed.
  const before = h.store.getCheck(check.id).last_run!.id;
  const ran = await h.call("POST", `/v1/tasks/${plan.id}/checks/run`, { check_id: check.id });
  expect(ran.status).toBe(202);
  await until(() => h.store.getCheck(check.id).last_run!.id !== before);
  expect(h.store.getCheck(check.id).last_run).toMatchObject({ outcome: "pass", cause: "user" });

  // Delete: 200, tombstoned, gone from TaskDetail.checks and from the mirror.
  const deleted = await h.call("DELETE", `/v1/checks/${check.id}`);
  expect(deleted.status).toBe(200);
  expect((deleted.json as unknown as TaskDetail).checks).toEqual([]);
  expect(readFileSync(join(h.root, plan.dir, PLAN_MAP_FILE), "utf8")).not.toContain("文件存在：report.md");
  expect((await h.call("DELETE", `/v1/checks/${check.id}`)).status).toBe(409);
  expect((await h.call("PATCH", `/v1/checks/${check.id}`, { item: "z" })).status).toBe(409);

  expect((await h.call("GET", `/v1/tasks/${plan.id}`)).json).toMatchObject({ checks: [] });
});

test("acceptance checks: too many active checks is refused, and an unknown plan 404s", async () => {
  const h = await harness();
  const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const plan = h.store.openTask({ sessionId: writer.direct_session.id, title: "写周报" });
  for (let i = 0; i < 10; i++) {
    const res = await h.call("POST", `/v1/tasks/${plan.id}/checks`, { item: `第 ${i} 条`, kind: "exists", path: `f${i}.md` });
    expect(res.status).toBe(201);
  }
  const over = await h.call("POST", `/v1/tasks/${plan.id}/checks`, { item: "超额", kind: "exists", path: "over.md" });
  expect(over.status).toBe(422);
  expect((await h.call("POST", "/v1/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/checks", { item: "x", kind: "exists", path: "a.md" })).status).toBe(404);
});
