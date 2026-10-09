import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_DROP_SESSION_ID, LOCAL_API_NAME } from "@real-bot/protocol";
import { ulid } from "./ids";
import { noisePng } from "./test-images";
import { ENGINE_LEVEL, SCHEMA_LEVEL } from "./store/schema-gate";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const start = (opts: Parameters<typeof startLocalApi>[0] = {}) => startLocalApi(opts);

describe("routine write boundaries", () => {
  test("PATCH and DELETE compare the current updated_at and remain legacy compatible", async () => {
    const h = await start();
    const { bot } = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const request = (method: string, path: string, body?: unknown) => fetch(`${h.origin}/v1/routines${path}`, { method, headers: auth(h, { 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
    const created = await request('POST', '', { bot_id: bot.id, title: 'Daily', instruction: '', enabled: false, schedule: { kind: 'daily', time: '23:59' } });
    expect(created.status).toBe(201);
    const row = await created.json() as import('@real-bot/protocol').Routine;
    const updated = await request('PATCH', `/${row.id}`, { if_revision: row.updated_at, schedule: { kind: 'weekly', time: '07:15', weekdays: ['mon', 'fri'] } });
    expect(updated.status).toBe(200);
    const next = await updated.json() as import('@real-bot/protocol').Routine;
    expect(next.schedule).toEqual({ kind: 'weekly', time: '07:15', weekdays: ['mon', 'fri'] });
    expect((await request('PATCH', `/${row.id}`, { title: 'Stale', if_revision: row.updated_at })).status).toBe(409);
    expect((await request('DELETE', `/${row.id}`, { if_revision: row.updated_at })).status).toBe(409);
    expect(h.store.getRoutine(row.id).title).toBe('Daily');
    for (const body of [null, [], { enabled: 'false' }, { schedule: null }, { schedule: { kind: 'daily', time: ['09:00'] } }, { schedule: { kind: 'daily', time: '24:00' } }, { schedule: { kind: 'weekly', time: '09:00', weekdays: [] } }, { if_revision: 3 }]) {
      expect((await request('PATCH', `/${row.id}`, body)).status).toBe(422);
    }
    expect((await request('DELETE', `/${row.id}`, { if_revision: next.updated_at })).status).toBe(204);
    expect((await request('PATCH', `/${row.id}`, {})).status).toBe(404);
    expect((await request('DELETE', `/${row.id}`)).status).toBe(404);
    const legacy = h.store.createRoutine({ bot_id: bot.id, title: 'Legacy', instruction: '', enabled: false, schedule: { kind: 'daily', time: '09:00' } });
    expect((await request('PATCH', `/${legacy.id}`, { title: 'No revision' })).status).toBe(200);
    expect((await request('DELETE', `/${legacy.id}`)).status).toBe(204);
    expect((await request('POST', '', null)).status).toBe(422);
    expect((await request('POST', '', { bot_id: 'missing', title: 'x', instruction: '', schedule: { kind: 'daily', time: '09:00' } })).status).toBe(404);
  });
});

describe("local api auth", () => {
  test("health is unauthenticated and named real-bot", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: LOCAL_API_NAME });
  });

  test("missing bearer is 401 unauthorized", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/bots`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "missing or invalid token" },
    });
  });

  test("wrong bearer is 401", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/bots`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  test("forbidden origin is 403 even with a token", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/bots`, {
      headers: auth(h, { Origin: "https://evil.example" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden_origin", message: "origin is not allowed" },
    });
  });

  test("localhost origin is allowed and CORS echoes it, never *", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/bots`, {
      headers: auth(h, { Origin: "http://localhost:5173" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
  });

  test("IPv6 loopback origin is allowed and CORS echoes it", async () => {
    const h = await start();
    const origin = "http://[::1]:5173";
    const health = await fetch(`${h.origin}/v1/health`, { headers: { Origin: origin } });
    expect(health.status).toBe(200);
    expect(health.headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const res = await fetch(`${h.origin}/v1/bots`, { headers: auth(h, { Origin: origin }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const preflight = await fetch(`${h.origin}/v1/bots`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });

  test("websocket first frame must be auth; wrong token closes", async () => {
    const h = await start();
    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (ev) => resolve({ code: ev.code }));
    });
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
    const { code } = await closed;
    expect(code).toBe(4001);
  });

  test("websocket first frame with the token stays open", async () => {
    const h = await start();
    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(50);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("authenticated socket receives settings.changed after PATCH", async () => {
    const h = await start();
    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const got = new Promise<string>((resolve) => {
      ws.addEventListener("message", (ev) => resolve(String(ev.data)));
    });
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ locale: "en" }),
    });
    expect(res.status).toBe(200);
    const payload = JSON.parse(await got) as { event: string; locale: string };
    expect(payload.event).toBe("settings.changed");
    expect(payload.locale).toBe("en");
    ws.close();
  });
});

describe("a job's files", () => {
  test("a cited file deleted since is gone from the list, and the trace says so", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-ws-job-"));
    await h.store.patchSettings({ workspace_path: ws });
    const { bot, direct_session: session } = h.store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const trigger = h.store.postMessage(session.id, { body: "出图" });
    const turn = h.store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id });
    mkdirSync(join(ws, "out"));
    writeFileSync(join(ws, "out", "kept.png"), noisePng(4, 4));
    h.store.insertMessage({
      sessionId: session.id,
      turnId: turn.id,
      kind: "bot",
      author: bot.id,
      body: "两张",
      paths: ["out/kept.png", "out/deleted.png"],
    });

    const listed = await fetch(`${h.origin}/v1/tasks/${turn.task_id}/artifacts`, { headers: auth(h) });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: Array<{ path: string }> }).items.map((row) => row.path)).toEqual(["out/kept.png"]);

    const traced = await fetch(`${h.origin}/v1/tasks/${turn.task_id}/trace`, { headers: auth(h) });
    const trace = (await traced.json()) as { nodes: Array<{ artifacts: Array<{ path: string; exists?: boolean }> }> };
    const files = trace.nodes.flatMap((node) => node.artifacts);
    expect(Object.fromEntries(files.map(({ path, exists }) => [path, exists]))).toEqual({
      "out/kept.png": true,
      "out/deleted.png": false,
    });
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("empty roster and settings", () => {
  test("GET bots is an empty items list", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/bots`, { headers: auth(h) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  test("a file posted to the file drop lands in inbox and wakes nobody", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-file-drop-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const bot = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const form = new FormData();
    form.append("body", "");
    form.append("files", new File([new Uint8Array([9, 8, 7])], "from-phone.txt", { type: "text/plain" }));
    const posted = await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}/messages`, {
      method: "POST",
      headers: auth(h),
      body: form,
    });
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as { attachments: Array<{ workspace_relpath: string; original_filename: string }> };
    expect(message.attachments[0]?.original_filename).toBe("from-phone.txt");
    expect(message.attachments[0]?.workspace_relpath).toStartWith("inbox/");
    expect(readFileSync(join(ws, message.attachments[0]!.workspace_relpath))).toEqual(Buffer.from([9, 8, 7]));
    await Bun.sleep(20);
    expect(h.store.listLiveTurns()).toEqual([]);
    expect(h.store.listLiveTurns({ sessionId: bot.direct_session.id })).toEqual([]);
    const again = h.store.ensureFileDropSession();
    expect(again.id).toBe(FILE_DROP_SESSION_ID);
    expect(h.store.listSessions().filter((row) => row.id === FILE_DROP_SESSION_ID)).toHaveLength(1);
    expect((await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}/archive`, { method: "POST", headers: auth(h) })).status).toBe(422);
    expect((await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}`, { method: "DELETE", headers: auth(h) })).status).toBe(422);
  });

  test("text posted to the file drop stays there and wakes nobody", async () => {
    const h = await start();
    const bot = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const posted = await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "@Writer 回家路上想到的" }),
    });
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as { body: string; attachments: unknown[] };
    expect(message.body).toBe("@Writer 回家路上想到的");
    expect(message.attachments).toEqual([]);
    await Bun.sleep(20);
    expect(h.store.listLiveTurns()).toEqual([]);
    expect(h.store.listLiveTurns({ sessionId: bot.direct_session.id })).toEqual([]);
  });

  test("unconfigured settings: endpoint_key_set is false, locale zh, wizard incomplete", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, { headers: auth(h) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings_rev: 0,
      workspace_path: null,
      endpoint_base_url: null,
      endpoint_key_set: false,
      endpoint_models: [],
      endpoint_model_catalog: [],
      endpoint_default_model: null,
      default_provider_id: null,
      reader_model: null,
      speech: null,
      launch_at_login: true,
      locale: "zh",
      theme: "system",
      wizard_complete: false,
    });
  });

  test("GET capabilities reports the engine level a fresh database opens at", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/capabilities`, { headers: auth(h) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: 0, features: [] });
  });

  test("POST capabilities/raise needs accept_older_app: true, then takes the level past the older installed app at once", async () => {
    const logged: string[] = [];
    const installed = { version: "0.1.0-rc.11" };
    const h = await start({ installedApp: () => installed, log: (line) => logged.push(line) });
    // Boot found the installed app from before the gate and kept the level where it was.
    expect(h.store.catchUpEngineLevel(installed)[0]).toContain("engine level stays at 0");
    // A plan stopped the old way, which holds take over once they are on.
    const bot = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const stopped = h.store.openTask({ sessionId: bot.direct_session.id, title: "写周报", spec: { kind: "文案", goal: "写周报", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "parked" } });
    const raise = (body: unknown) =>
      fetch(`${h.origin}/v1/capabilities/raise`, { method: "POST", headers: auth(h, { "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });

    for (const body of [undefined, {}, { accept_older_app: false }, { accept_older_app: "true" }, { accept_older_app: true, by: "phone" }]) {
      const refused = await raise(body);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_args");
    }
    expect(h.store.capabilities().engine_level).toBe(0);
    expect(h.store.engineGateOptIn()).toBeNull();
    expect(logged).toEqual([]);

    const frames: string[] = [];
    h.api.subscribeSync((frame) => frames.push(frame.type));
    const accepted = await raise({ accept_older_app: true });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL, features: ["holds", "work_items", "delegation", "supervision", "submissions", "jobs", "routing", "learning"] });
    expect(h.store.engineGateOptIn()).toMatchObject({ by: "api", level: ENGINE_LEVEL });
    expect(h.store.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe(String(SCHEMA_LEVEL));
    // Open windows take a fresh snapshot, which now carries the holds that show the stop menus.
    expect(frames).toContain("resnapshot");
    const snapshot = (await (await fetch(`${h.origin}/v1/snapshot`, { headers: auth(h) })).json()) as { holds?: unknown[] };
    expect(snapshot.holds).toHaveLength(1);
    // Now, not at the next start: holds are on, and the plan stopped the old way is one.
    expect(h.store.listHolds({ inForce: true }).map((hold) => [hold.scope_id, hold.source])).toEqual([[stopped.id, "legacy"]]);
    expect(logged[0]).toContain("past the installed app (0.1.0-rc.11)");
    expect(logged[0]).toContain("(api, ");
    expect(logged[1]).toContain(`took over 1 parked plan(s) as holds: ${stopped.id}`);
  });

  test("DELETE capabilities/raise takes the opt-in back and leaves the level where it is", async () => {
    const h = await start({ installedApp: () => ({ version: "0.1.0-rc.11" }) });
    const post = await fetch(`${h.origin}/v1/capabilities/raise`, { method: "POST", headers: auth(h), body: JSON.stringify({ accept_older_app: true, by: "script" }) });
    expect(((await post.json()) as { engine_level: number }).engine_level).toBe(ENGINE_LEVEL);
    expect(h.store.engineGateOptIn()?.by).toBe("script");
    const frames: string[] = [];
    h.api.subscribeSync((frame) => frames.push(frame.type));
    const withdrawn = await fetch(`${h.origin}/v1/capabilities/raise`, { method: "DELETE", headers: auth(h) });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL, features: ["holds", "work_items", "delegation", "supervision", "submissions", "jobs", "routing", "learning"] });
    expect(h.store.engineGateOptIn()).toBeNull();
    expect(h.store.catchUpEngineLevel({ version: "0.1.0-rc.11" })).toEqual([]);
    expect(h.store.capabilities().engine_level).toBe(ENGINE_LEVEL);
    // Nothing a window shows changed.
    expect(frames).not.toContain("resnapshot");
  });

  test("capabilities/raise is local only: the token guards it, and the dispatch a phone reaches never serves it", async () => {
    const h = await start({ installedApp: () => ({ version: "0.1.0-rc.11" }) });
    const body = JSON.stringify({ accept_older_app: true });
    expect((await fetch(`${h.origin}/v1/capabilities/raise`, { method: "POST", body })).status).toBe(401);
    for (const method of ["POST", "DELETE"]) {
      const remote = await h.api.dispatchBusiness(
        new Request("http://remote.invalid/v1/capabilities/raise", { method, body: method === "POST" ? body : undefined }),
        { deviceId: "paired-device", requestId: ulid() },
      ).catch((error: unknown) => error);
      expect(remote).toBeInstanceOf(Error);
      expect((remote as { status?: number }).status).toBe(404);
    }
    expect(h.store.engineGateOptIn()).toBeNull();
    expect(h.store.capabilities().engine_level).toBe(0);
  });

  test("GET debug organizer-runs reads a plan's runs, newest first, and requires a task_id", async () => {
    const h = await start();
    const bot = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const plan = h.store.openTask({ sessionId: bot.direct_session.id, title: "写周报" });
    const older = h.store.recordOrganizerRun({
      sessionId: bot.direct_session.id,
      taskId: plan.id,
      mode: "message",
      messageId: null,
      spendId: null,
      rawAnswer: "我不知道",
      failKind: "unparseable",
      decision: null,
      candidatesPayload: { recent_plan_ids: [], elsewhere_plan_ids: [], existing_check_ids: [] },
      candidatesApply: null,
      candidatesAtParse: { recent_plan_ids: [], elsewhere_plan_ids: [], existing_check_ids: [] },
      downgradeReason: null,
      applied: false,
      rejectReason: "the answer did not read as a plan",
      held: null,
      appliedTaskId: null,
      appliedTicketId: null,
    });
    const newer = h.store.recordOrganizerRun({
      sessionId: bot.direct_session.id,
      taskId: plan.id,
      mode: "settle",
      messageId: null,
      spendId: null,
      rawAnswer: '{"decision":"continue","plan":{"goal":"写周报"}}',
      failKind: null,
      decision: "continue",
      candidatesPayload: { recent_plan_ids: [], elsewhere_plan_ids: [], existing_check_ids: [] },
      candidatesApply: { decision: "continue", resume_plan_id: null, join_plan_id: null, ticket_ids: [], message_ticket: null, check_ids: [] },
      candidatesAtParse: { recent_plan_ids: [], elsewhere_plan_ids: [], existing_check_ids: [] },
      downgradeReason: null,
      applied: true,
      rejectReason: null,
      held: null,
      appliedTaskId: plan.id,
      appliedTicketId: null,
    });
    const res = await fetch(`${h.origin}/v1/debug/organizer-runs?task_id=${plan.id}`, { headers: auth(h) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [newer, older] });

    expect((await fetch(`${h.origin}/v1/debug/organizer-runs`, { headers: auth(h) })).status).toBe(422);
    expect((await fetch(`${h.origin}/v1/debug/organizer-runs?task_id=not-a-ulid`, { headers: auth(h) })).status).toBe(422);
  });

  test("runtime drain and quiesce never exit", async () => {
    let quit = 0;
    const h = await start({ onQuit: () => quit++ });
    const denied = await fetch(`${h.origin}/v1/runtime/drain`);
    expect(denied.status).toBe(401);
    const drain = await fetch(`${h.origin}/v1/runtime/drain`, { headers: auth(h) });
    expect(drain.status).toBe(200);
    expect(await drain.json()).toEqual({ phase: "running", remaining: [], forced: false });
    const begin = await fetch(`${h.origin}/v1/runtime/quiesce`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "begin" }),
    });
    expect(begin.status).toBe(200);
    expect(await begin.json()).toEqual({ phase: "drained", remaining: [], forced: false });
    const cancel = await fetch(`${h.origin}/v1/runtime/quiesce`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "cancel" }),
    });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ phase: "running", remaining: [], forced: false });
    expect(quit).toBe(0);
  });

  test("quiesce begin waits on a live turn and force does not exit", async () => {
    let quit = 0;
    const h = await start({ onQuit: () => quit++ });
    const bot = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = h.store.postMessage(bot.direct_session.id, { body: "go" });
    const turn = h.store.createTurn({
      sessionId: bot.direct_session.id,
      botId: bot.bot.id,
      triggerMessageId: trigger.id,
    });
    const begin = await fetch(`${h.origin}/v1/runtime/quiesce`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "begin" }),
    });
    expect(begin.status).toBe(200);
    expect(await begin.json()).toEqual({ phase: "draining", remaining: [turn.id], forced: false });
    const force = await fetch(`${h.origin}/v1/runtime/quiesce`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "force" }),
    });
    const body = (await force.json()) as { phase: string; remaining: string[]; forced: boolean };
    expect(force.status).toBe(200);
    expect(body.forced).toBe(true);
    expect(quit).toBe(0);
  });

  test("POST /v1/runtime/quit is authenticated and invokes onQuit", async () => {
    let quit = 0;
    const h = await start({ onQuit: () => quit++ });
    const denied = await fetch(`${h.origin}/v1/runtime/quit`, { method: "POST" });
    expect(denied.status).toBe(401);
    const res = await fetch(`${h.origin}/v1/runtime/quit`, { method: "POST", headers: auth(h) });
    expect(res.status).toBe(204);
    await Bun.sleep(10);
    expect(quit).toBe(1);
  });

  test("GET runtime needs a token and never includes it", async () => {
    const h = await start();
    const denied = await fetch(`${h.origin}/v1/runtime`);
    expect(denied.status).toBe(401);
    const res = await fetch(`${h.origin}/v1/runtime`, { headers: auth(h) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bind: string; pid: number };
    expect(body.bind).toBe("127.0.0.1:17890");
    expect(body.pid).toBe(process.pid);
    expect(JSON.stringify(body)).not.toContain(h.token);
  });
});
