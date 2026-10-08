import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_DROP_SESSION_ID, LOCAL_API_NAME } from "@real-bot/protocol";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { noisePng } from "./test-images";
import { warmDisplayAvatar } from "./avatar-display";
import { Store } from "./store";
import { ENGINE_LEVEL, SCHEMA_LEVEL } from "./store/schema-gate";
import { auth, registerLocalApiCleanup, startLocalApi, type Harness } from "./test-kit/local-api-harness";

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

  test("patching theme to dark or light succeeds, invalid theme is 422", async () => {
    const h = await start();
    const patchDark = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(patchDark.status).toBe(200);
    const bodyDark = (await patchDark.json()) as { theme: string };
    expect(bodyDark.theme).toBe("dark");

    const patchBad = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ theme: "neon" }),
    });
    expect(patchBad.status).toBe(422);
    const err = (await patchBad.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("invalid_args");
    expect(err.error.message).toContain("theme must be system, light, or dark");
  });

  test("settings never echo the key; endpoint_key_set flips after PATCH", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    const patched = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        workspace_path: workspace,
        endpoint_base_url: "https://api.example/v1",
        endpoint_api_key: "sk-secret",
      }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      endpoint_key_set: boolean;
      wizard_complete: boolean;
      workspace_path: string;
    };
    expect(body.endpoint_key_set).toBe(true);
    expect(body.wizard_complete).toBe(true);
    expect(body.workspace_path).toBe(realpathSync(workspace));
    expect(JSON.stringify(body)).not.toContain("sk-secret");
    expect(JSON.stringify(body)).not.toContain("keychain:");
    rmSync(workspace, { recursive: true, force: true });
  });

  test("workspace tree and file are read-only inside the jail", async () => {
    const h = await start();
    const unset = await fetch(`${h.origin}/v1/workspace/tree`, { headers: auth(h) });
    expect(unset.status).toBe(422);

    const ws = mkdtempSync(join(tmpdir(), "real-bot-ws-tree-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "brief.md"), "# brief\n");
    writeFileSync(join(ws, "src", "app.ts"), "export {}\n");
    writeFileSync(join(ws, ".hidden"), "nope");
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });

    const treeRes = await fetch(`${h.origin}/v1/workspace/tree`, { headers: auth(h) });
    expect(treeRes.status).toBe(200);
    const tree = (await treeRes.json()) as {
      path: string;
      truncated: boolean;
      items: Array<{ name: string; path: string; kind: string }>;
    };
    expect(tree.path).toBe(".");
    expect(tree.items.map((row) => row.path)).toEqual(["src", "brief.md"]);

    const nested = await fetch(`${h.origin}/v1/workspace/tree?path=${encodeURIComponent("src")}`, {
      headers: auth(h),
    });
    expect((await nested.json() as { items: Array<{ path: string }> }).items.map((row) => row.path)).toEqual([
      "src/app.ts",
    ]);

    const fileRes = await fetch(`${h.origin}/v1/workspace/file?path=${encodeURIComponent("brief.md")}`, {
      headers: auth(h),
    });
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("Content-Length")).toBe(String(Buffer.byteLength("# brief\n")));
    expect(await fileRes.text()).toBe("# brief\n");

    writeFileSync(join(ws, "clip.mp4"), Buffer.alloc(1_000_001, 7));
    const bigRes = await fetch(`${h.origin}/v1/workspace/file?path=${encodeURIComponent("clip.mp4")}`, {
      headers: auth(h),
    });
    expect(bigRes.status).toBe(200);
    expect((await bigRes.arrayBuffer()).byteLength).toBe(1_000_001);

    const escapeRes = await fetch(`${h.origin}/v1/workspace/tree?path=${encodeURIComponent("../")}`, {
      headers: auth(h),
    });
    expect(escapeRes.status).toBe(422);

    const dirFile = await fetch(`${h.origin}/v1/workspace/file?path=${encodeURIComponent("src")}`, {
      headers: auth(h),
    });
    expect(dirFile.status).toBe(422);

    const put = await fetch(`${h.origin}/v1/workspace/file`, {
      method: "PUT",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "brief.md", content: "# saved\n" }),
    });
    expect(put.status).toBe(204);
    expect(readFileSync(join(ws, "brief.md"), "utf8")).toBe("# saved\n");

    const putMissing = await fetch(`${h.origin}/v1/workspace/file`, {
      method: "PUT",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "nope.md", content: "x" }),
    });
    expect(putMissing.status).toBe(404);

    const putOutside = await fetch(`${h.origin}/v1/workspace/file`, {
      method: "PUT",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "../secret", content: "x" }),
    });
    expect(putOutside.status).toBe(422);

    rmSync(ws, { recursive: true, force: true });
  });

  test("workspace files and folders move to the Trash, and nothing outside the workspace does", async () => {
    const asked: string[][] = [];
    const h = await start({ trash: async (abs) => {
      asked.push(abs);
      for (const path of abs) rmSync(path, { recursive: true });
      return abs.map(() => "");
    } });
    const trash = (paths: unknown) => fetch(`${h.origin}/v1/workspace/trash`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ paths }),
    });
    expect((await trash(["brief.md"])).status).toBe(422);

    const ws = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-ws-trash-")));
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "app.ts"), "export {}\n");
    writeFileSync(join(ws, "brief.md"), "# brief\n");
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });

    const receipts = () => h.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request_receipts").get()!.n;
    const before = receipts();
    const moved = await trash(["src/app.ts", "src", "brief.md"]);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ trashed: ["src", "brief.md"], failed: [] });
    expect(asked).toEqual([[join(ws, "src"), join(ws, "brief.md")]]);
    expect(((await (await fetch(`${h.origin}/v1/workspace/tree`, { headers: auth(h) })).json()) as { items: unknown[] }).items).toEqual([]);
    // Asked again after a lost answer: already gone, so the same answer and nothing handed over.
    expect(await (await trash(["src", "brief.md"])).json()).toEqual({ trashed: ["src", "brief.md"], failed: [] });
    expect(asked).toHaveLength(1);
    // No receipt, so a second request is never refused as a replay of the first.
    expect(receipts()).toBe(before);

    for (const paths of [[], ["."], ["../secret"], "brief.md"]) expect((await trash(paths)).status).toBe(422);
    expect(asked).toHaveLength(1);
    rmSync(ws, { recursive: true, force: true });
  });

  test("illegal locale is 422", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ locale: "zh-Hans" }),
    });
    expect(res.status).toBe(422);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("invalid_args");
  });

  test("blank workspace path is 422", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: "   " }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "workspace_path cannot be empty" },
    });
  });

  test("relative workspace path is 422 and does not write", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: "relative/ws" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "workspace_path must be an absolute directory" },
    });
    const settings = (await (await fetch(`${h.origin}/v1/settings`, { headers: auth(h) })).json()) as {
      workspace_path: string | null;
    };
    expect(settings.workspace_path).toBeNull();
  });

  test("missing workspace directory is created", async () => {
    const h = await start();
    const dir = join(tmpdir(), `real-bot-missing-${process.pid}-${Date.now()}`);
    const nested = join(dir, "workspace");
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: nested }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_path: string };
    expect(body.workspace_path).toBe(realpathSync(nested));
    expect(statSync(nested).isDirectory()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("file used as workspace path is 422", async () => {
    const h = await start();
    const dir = mkdtempSync(join(tmpdir(), "real-bot-file-"));
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: file }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "workspace_path must be a directory" },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing tilde workspace path is created", async () => {
    const h = await start();
    const home = process.env.HOME!;
    const name = `real-bot-tilde-missing-${process.pid}-${Date.now()}`;
    const real = join(home, name);
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: `~/${name}` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_path: string };
    expect(body.workspace_path).toBe(realpathSync(real));
    expect(statSync(real).isDirectory()).toBe(true);
    rmSync(real, { recursive: true, force: true });
  });

  test("tilde workspace path expands, realpath-resolves, and stores the absolute directory", async () => {
    const h = await start();
    const home = process.env.HOME!;
    const name = `real-bot-tilde-${process.pid}`;
    const real = join(home, name);
    const link = join(home, `${name}-link`);
    mkdirSync(real);
    symlinkSync(real, link);
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: `~/${name}-link` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_path: string };
    expect(body.workspace_path).toBe(real);
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  });

  test("non-http endpoint URL is 422 and does not write", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_base_url: "ftp://api.example/v1" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "endpoint_base_url must be an http or https URL" },
    });
    const settings = (await (await fetch(`${h.origin}/v1/settings`, { headers: auth(h) })).json()) as {
      endpoint_base_url: string | null;
    };
    expect(settings.endpoint_base_url).toBeNull();
  });

  test("blank endpoint URL is 422", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_base_url: "   " }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "endpoint_base_url cannot be empty" },
    });
  });

  test("http endpoint URL is stored after URL normalization", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_base_url: "HTTP://API.EXAMPLE/v1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoint_base_url: string };
    expect(body.endpoint_base_url).toBe("http://api.example/v1");
  });

  test("endpoint models trim, drop duplicates, and pick the first as default when omitted", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: [" grok-4.5 ", "deepseek-v4-pro", "grok-4.5"],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
      endpoint_default_model: "grok-4.5",
    });
  });

  test("default model must be in the list; unknown bot model is 422", async () => {
    const h = await start();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
        endpoint_default_model: "grok-4.5",
      }),
    });
    const badDefault = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_default_model: "nope" }),
    });
    expect(badDefault.status).toBe(422);
    expect(await badDefault.json()).toEqual({
      error: { code: "invalid_args", message: "endpoint_default_model must be one of endpoint_models" },
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "nope",
      }),
    });
    expect(created.status).toBe(422);
    expect(await created.json()).toEqual({
      error: { code: "invalid_args", message: "model must be one of endpoint_models" },
    });
    const ok = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "deepseek-v4-pro",
      }),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { bot: { model: string | null } };
    expect(body.bot.model).toBe("deepseek-v4-pro");
  });

  test("a bot thinking_level pin is validated against the pinned model and round-trips through PATCH", async () => {
    const h = await start();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: [
          { name: "grok-4.5", thinking_levels: ["low", "high"] },
          { name: "deepseek-v4-pro", thinking_levels: ["none"] },
        ],
        endpoint_default_model: "grok-4.5",
      }),
    });
    const badLevel = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay", thinking_level: "high!" }),
    });
    expect(badLevel.status).toBe(422);
    expect(await badLevel.json()).toEqual({
      error: { code: "invalid_args", message: "thinking_level must be a reasoning_effort name" },
    });
    const unsupported = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "deepseek-v4-pro",
        thinking_level: "high",
      }),
    });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({
      error: { code: "invalid_args", message: "thinking_level must be one the pinned model supports" },
    });
    const orphanLevel = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay", thinking_level: "high" }),
    });
    expect(orphanLevel.status).toBe(422);
    expect(await orphanLevel.json()).toEqual({
      error: { code: "invalid_args", message: "thinking_level needs a pinned model" },
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "grok-4.5",
        thinking_level: "high",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { bot: { id: string; thinking_level: string | null } };
    expect(body.bot.thinking_level).toBe("high");

    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    const patched = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "grok-4.5", thinking_level: "low" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ model: "grok-4.5", thinking_level: "low" });
    // A pinned model always carries a level: clearing it falls back to that model's default.
    const cleared = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ thinking_level: null }),
    });
    expect(await cleared.json()).toMatchObject({ model: "grok-4.5", thinking_level: "low" });
    // Unpinning the model unpins the level with it: automatic is both or neither.
    const unpinned = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ model: null }),
    });
    expect(await unpinned.json()).toMatchObject({ model: null, thinking_level: null });
    const orphanPatch = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ thinking_level: "high" }),
    });
    expect(orphanPatch.status).toBe(422);
    await Bun.sleep(20);
    expect(
      events.some((e) => e.event === "bot.upsert" && e.id === body.bot.id && e.thinking_level === "low"),
    ).toBe(true);
    ws.close();
  });

  test("dropping a model from the list clears bots that used it", async () => {
    const h = await start();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
        endpoint_default_model: "grok-4.5",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "deepseek-v4-pro",
      }),
    });
    const bot = (await created.json()) as { bot: { id: string } };
    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_models: ["grok-4.5"] }),
    });
    const row = await fetch(`${h.origin}/v1/bots/${bot.bot.id}`, { headers: auth(h) });
    expect(await row.json()).toMatchObject({ id: bot.bot.id, model: null });
    expect(events.some((e) => e.event === "bot.upsert" && e.id === bot.bot.id && e.model === null)).toBe(
      true,
    );
    ws.close();
    const settings = await fetch(`${h.origin}/v1/settings`, { headers: auth(h) });
    expect(await settings.json()).toMatchObject({
      endpoint_models: ["grok-4.5"],
      endpoint_default_model: "grok-4.5",
    });
  });

  test("providers can be added, patched, and listed without echoing keys", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: workspace }),
    });
    const created = await fetch(`${h.origin}/v1/providers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
        models: ["gpt-4o"],
        available_models: ["gpt-4o", " gpt-4o-mini ", "gpt-4o", "o3"],
        default_model: "gpt-4o",
      }),
    });
    expect(created.status).toBe(201);
    const openai = (await created.json()) as {
      id: string;
      key_set: boolean;
      models: string[];
      available_models: string[];
    };
    expect(openai.key_set).toBe(true);
    expect(openai.available_models).toEqual(["gpt-4o", "gpt-4o-mini", "o3"]);
    expect(JSON.stringify(openai)).not.toContain("sk-openai");
    const second = await fetch(`${h.origin}/v1/providers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-deepseek",
        models: ["deepseek-chat"],
      }),
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { available_models: string[] }).available_models).toEqual([]);
    const listed = await fetch(`${h.origin}/v1/providers`, { headers: auth(h) });
    const page = (await listed.json()) as {
      items: Array<{ name: string; key_set: boolean; available_models: string[] }>;
    };
    expect(page.items.map((item) => item.name).sort()).toEqual(["DeepSeek", "OpenAI"]);
    expect(page.items.every((item) => item.key_set)).toBe(true);
    expect(page.items.find((item) => item.name === "OpenAI")?.available_models).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
    ]);
    const settings = await fetch(`${h.origin}/v1/settings`, { headers: auth(h) });
    expect(await settings.json()).toMatchObject({
      default_provider_id: openai.id,
      endpoint_models: ["gpt-4o"],
      wizard_complete: true,
    });
    const patched = await fetch(`${h.origin}/v1/providers/${openai.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ models: ["gpt-4o", "gpt-4o-mini"], default_model: "gpt-4o-mini" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      models: ["gpt-4o", "gpt-4o-mini"],
      available_models: ["gpt-4o", "gpt-4o-mini", "o3"],
      default_model: "gpt-4o-mini",
    });
    const refetched = await fetch(`${h.origin}/v1/providers/${openai.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ available_models: ["gpt-4o", "gpt-4o-mini"] }),
    });
    expect(refetched.status).toBe(200);
    expect(await refetched.json()).toMatchObject({
      models: ["gpt-4o", "gpt-4o-mini"],
      available_models: ["gpt-4o", "gpt-4o-mini"],
    });
    const rejected = await fetch(`${h.origin}/v1/providers/${openai.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ available_models: "gpt-4o" }),
    });
    expect(rejected.status).toBe(422);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("provider model catalog round-trips price, thinking levels, and strengths", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: workspace }),
    });
    const created = await fetch(`${h.origin}/v1/providers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
        models: [
          {
            name: "gpt-4o",
            price: 2.5,
            thinking_levels: ["low", "medium", "high"],
            strengths: ["code", "writing"],
          },
        ],
        default_model: "gpt-4o",
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      models: ["gpt-4o"],
      model_catalog: [
        {
          name: "gpt-4o",
          price: 2.5,
          thinking_levels: ["low", "medium", "high"],
          strengths: ["code", "writing"],
        },
      ],
      default_model: "gpt-4o",
    });
    const listed = await fetch(`${h.origin}/v1/providers`, { headers: auth(h) });
    const page = (await listed.json()) as {
      items: Array<{
        id: string;
        models: string[];
        model_catalog: unknown[];
      }>;
    };
    expect(page.items[0]?.models).toEqual(["gpt-4o"]);
    expect(page.items[0]?.model_catalog).toEqual([
      {
        name: "gpt-4o",
        price: 2.5,
        thinking_levels: ["low", "medium", "high"],
        strengths: ["code", "writing"],
      },
    ]);
    const settings = await fetch(`${h.origin}/v1/settings`, { headers: auth(h) });
    expect(await settings.json()).toMatchObject({
      endpoint_models: ["gpt-4o"],
      endpoint_model_catalog: [
        {
          name: "gpt-4o",
          price: 2.5,
          thinking_levels: ["low", "medium", "high"],
          strengths: ["code", "writing"],
        },
      ],
    });
    const patched = await fetch(`${h.origin}/v1/providers/${page.items[0]!.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        models: [
          {
            name: "gpt-4o",
            price: 2.5,
            thinking_levels: ["low", "medium", "high"],
            strengths: ["code", "writing"],
          },
          {
            name: "gpt-4o-mini",
            price: 0.15,
            thinking_levels: ["none"],
            strengths: ["chat"],
          },
        ],
        default_model: "gpt-4o-mini",
      }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      models: ["gpt-4o", "gpt-4o-mini"],
      model_catalog: [
        {
          name: "gpt-4o",
          price: 2.5,
          thinking_levels: ["low", "medium", "high"],
          strengths: ["code", "writing"],
        },
        {
          name: "gpt-4o-mini",
          price: 0.15,
          thinking_levels: ["none"],
          strengths: ["chat"],
        },
      ],
      default_model: "gpt-4o-mini",
    });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("POST /v1/models/probe requires baseUrl and returns probed models", async () => {
    const h = await start();
    const missing = await fetch(`${h.origin}/v1/models/probe`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(422);

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "mock-model-1", reasoning_efforts: ["low", "high", "xhigh"] },
                { id: "mock-model-2" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url);
      }) as unknown as typeof fetch;

      const res = await originalFetch(`${h.origin}/v1/models/probe`, {
        method: "POST",
        headers: auth(h, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          endpoint_base_url: "https://api.example.com/v1",
          endpoint_api_key: "test-key",
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        models: ["mock-model-1", "mock-model-2"],
        catalog: [
          { name: "mock-model-1", thinking_levels: ["low", "high", "xhigh"] },
          { name: "mock-model-2", thinking_levels: [] },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("POST /v1/models/probe hands the scope's guard to the probe, so a revoke during key hydration sends nothing", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token: "test-token", schedule: false });
    await store.patchSettings({ endpoint_base_url: "https://api.example.com/v1", endpoint_api_key: "fixture-only" });
    let revoked = false;
    const original = store.endpointKey.bind(store);
    const hydrate = spyOn(store, "endpointKey").mockImplementation(async (...args) => {
      const key = await original(...args);
      revoked = true;
      return key;
    });
    let outbound = 0;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        outbound++;
        return Response.json({ data: [{ id: "never" }] });
      }) as unknown as typeof fetch;
      const probe = api.dispatchBusiness(
        new Request("http://fixture/v1/models/probe", { method: "POST", body: "{}" }),
        {
          deviceId: "paired-device",
          requestId: ulid(),
          guard: () => {
            if (revoked) throw new Error("revoked");
          },
        },
      );
      await expect(probe).rejects.toThrow("revoked");
      expect(outbound).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      hydrate.mockRestore();
      await api.engine.close();
      store.close();
    }
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

  test("DELETE /v1/sessions/:id and POST /v1/sessions/:id/clear", async () => {
    const h = await start();
    // Create two bots
    const b1Res = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "B1", duties: "d1", boundaries: "b1" }),
    });
    const b1 = (await b1Res.json()) as { bot: { id: string }; direct_session: { id: string } };

    const b2Res = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "B2", duties: "d2", boundaries: "b2" }),
    });
    const b2 = (await b2Res.json()) as { bot: { id: string } };

    // Create a group
    const gRes = await fetch(`${h.origin}/v1/sessions`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "TestGroup", members: [b1.bot.id, b2.bot.id] }),
    });
    const group = (await gRes.json()) as { id: string };

    // Post a message in the group
    await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "Test message" }),
    });

    const msgsBefore = await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, { headers: auth(h) });
    const msgsBeforeJson = (await msgsBefore.json()) as { items: unknown[] };
    expect(msgsBeforeJson.items.length).toBeGreaterThan(0);

    // Clear history
    const clearRes = await fetch(`${h.origin}/v1/sessions/${group.id}/clear`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
    });
    expect(clearRes.status).toBe(204);

    const msgsAfter = await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, { headers: auth(h) });
    const msgsAfterJson = (await msgsAfter.json()) as { items: unknown[] };
    expect(msgsAfterJson.items.length).toBe(0);

    // Delete direct session fails (422)
    const delDirect = await fetch(`${h.origin}/v1/sessions/${b1.direct_session.id}`, {
      method: "DELETE",
      headers: auth(h),
    });
    expect(delDirect.status).toBe(422);

    // Delete group succeeds
    const delGroup = await fetch(`${h.origin}/v1/sessions/${group.id}`, {
      method: "DELETE",
      headers: auth(h),
    });
    expect(delGroup.status).toBe(204);

    const getGroup = await fetch(`${h.origin}/v1/sessions/${group.id}`, { headers: auth(h) });
    expect(getGroup.status).toBe(404);
  });

  test("clearing or deleting a conversation keeps what you said unless erase_quotes asks otherwise", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const editor = h.store.createBot({ name: "Editor", duties: "edit", boundaries: "none" });
    const group = h.store.createGroup({ name: "Team", members: [writer.bot.id, editor.bot.id] });
    const direct = writer.direct_session.id;
    const post = (session: string, body: string) =>
      fetch(`${h.origin}/v1/sessions/${session}/messages`, { method: "POST", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify({ body }) });
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${h.origin}${path}`, { method, headers: auth(h, { "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
    const words = (session: string) => h.store.listQuotes({ sessionId: session }).map((quote) => [quote.body, quote.message_id === null]);

    await post(direct, "片长两分钟左右");
    expect((await send("POST", `/v1/sessions/${direct}/clear`)).status).toBe(204);
    expect(words(direct)).toEqual([["片长两分钟左右", true]]);

    await post(direct, "机械臂是左手");
    // A wrong value is refused before anything is cleared.
    expect((await send("POST", `/v1/sessions/${direct}/clear`, { erase_quotes: "yes" })).status).toBe(422);
    expect(h.store.listMessages(direct).items.map((message) => message.body)).toContain("机械臂是左手");
    expect((await send("DELETE", `/v1/sessions/${direct}/messages`, { erase_quotes: true })).status).toBe(204);
    expect(words(direct)).toEqual([["", true], ["", true]]);

    await post(group.id, "背景要连贯");
    const [kept] = h.store.listQuotes({ sessionId: group.id });
    expect((await send("DELETE", `/v1/sessions/${group.id}`, {})).status).toBe(204);
    expect(h.store.listQuotes().find((quote) => quote.id === kept!.id)).toMatchObject({ body: "背景要连贯", session_id: null, message_id: null });
  });

  test("the board acts on an entry of the requirements ledger and gets the plan back; a moved-on entry is a 409", async () => {
    const h = await start();
    const { bot, direct_session: direct } = h.store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const line = h.store.postMessage(direct.id, { body: "做 EP01" });
    const plan = h.store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: line.id }).task_id!;
    const old = h.store.addRequirement({ scope: "plan", scopeId: plan, quote: "标题别太长", sourceKind: "legacy", addedBy: "import", status: "unverified" });
    const act = (id: string, body: unknown) =>
      fetch(`${h.origin}/v1/requirements/${id}/action`, { method: "POST", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify(body) });

    const confirmed = await act(old.id, { action: "confirm", task_id: plan });
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { requirements: Array<{ id: string; status: string }> }).requirements).toMatchObject([{ id: old.id, status: "open" }]);
    expect((await act(old.id, { action: "reject", task_id: plan })).status).toBe(409);
    const widened = await act(old.id, { action: "whole_project", task_id: plan });
    expect(((await widened.json()) as { requirements: Array<{ scope: string }> }).requirements).toMatchObject([{ scope: "project" }]);
    expect((await act(old.id, { action: "purge", task_id: plan })).status).toBe(422);
    expect((await act(old.id, { action: "waive" })).status).toBe(404);
    expect((await act(old.id, { action: "waive", task_id: plan })).status).toBe(200);
    expect(h.store.getRequirement(old.id).status).toBe("waived");
  });

  test("erasing what you said takes the checks made from it with it, at once", async () => {
    const h = await start();
    const { bot, direct_session: direct } = h.store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const reviewer = h.store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
    const group = h.store.createGroup({ name: "片组", members: [bot.id, reviewer.bot.id] });
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${h.origin}${path}`, { method, headers: auth(h, { "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
    /** A line of yours in `session` that opens a plan, and the check it gives. */
    const planFrom = (session: string) => {
      const line = h.store.postMessage(session, { body: "片长约2分钟" });
      const turn = h.store.createTurn({ sessionId: session, botId: bot.id, triggerMessageId: line.id });
      h.store.setTurnStatus(turn.id, "completed");
      h.store.syncDerivedChecks(turn.task_id!);
      // Something else of yours keeps the plan when the conversation's words go.
      h.store.addRequirement({ scope: "plan", scopeId: turn.task_id!, quote: "机械臂是左手", sourceKind: "board", addedBy: "user" });
      return () => h.store.listChecks(turn.task_id!).filter((check) => check.origin === "derived");
    };

    const inDirect = planFrom(direct.id);
    expect(inDirect()).toHaveLength(1);
    // Cleared with your words kept, the check stays; erased with them, it goes without waiting for the plan's next line.
    expect((await send("POST", `/v1/sessions/${direct.id}/clear`)).status).toBe(204);
    expect(inDirect()).toHaveLength(1);
    expect((await send("DELETE", `/v1/sessions/${direct.id}/messages`, { erase_quotes: true })).status).toBe(204);
    expect(inDirect()).toEqual([]);

    const inGroup = planFrom(group.id);
    expect(inGroup()).toHaveLength(1);
    expect((await send("DELETE", `/v1/sessions/${group.id}`, { erase_quotes: true })).status).toBe(204);
    expect(inGroup()).toEqual([]);
  });

  test("POST /v1/sessions/:id/archive and /v1/sessions/:id/restore", async () => {
    const h = await start();
    const b1 = h.store.createBot({ name: "Worker1", duties: "d", boundaries: "b" });
    const b2 = h.store.createBot({ name: "Worker2", duties: "d", boundaries: "b" });
    const group = h.store.createGroup({ name: "TeamAlpha", members: [b1.bot.id, b2.bot.id] });

    const archiveRes = await fetch(`${h.origin}/v1/sessions/${group.id}/archive`, {
      method: "POST",
      headers: auth(h),
    });
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as { archived_at: string | null };
    expect(archived.archived_at).toBeString();

    const getArchived = await fetch(`${h.origin}/v1/sessions/${group.id}`, { headers: auth(h) });
    const fetched = (await getArchived.json()) as { archived_at: string | null };
    expect(fetched.archived_at).toBe(archived.archived_at);

    const restoreRes = await fetch(`${h.origin}/v1/sessions/${group.id}/restore`, {
      method: "POST",
      headers: auth(h),
    });
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as { archived_at: string | null };
    expect(restored.archived_at).toBeNull();
  });

  test("POST /v1/sessions/:id/read clears unread_count", async () => {
    const h = await start();
    const createdRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Reader", duties: "d", boundaries: "b" }),
    });
    const created = (await createdRes.json()) as {
      bot: { id: string };
      direct_session: { id: string };
    };
    h.store.markSessionRead(created.direct_session.id, "2000-01-01T00:00:00.000Z");
    h.store.insertMessage({
      sessionId: created.direct_session.id,
      kind: "bot",
      author: created.bot.id,
      body: "hello from the bot",
    });
    const listed = await fetch(`${h.origin}/v1/sessions`, { headers: auth(h) });
    const listedBody = (await listed.json()) as {
      items: Array<{ id: string; unread_count: number; last_read_at: string | null }>;
    };
    const row = listedBody.items.find((s) => s.id === created.direct_session.id);
    expect(row?.unread_count).toBe(1);
    const readRes = await fetch(`${h.origin}/v1/sessions/${created.direct_session.id}/read`, {
      method: "POST",
      headers: auth(h),
    });
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { unread_count: number; last_read_at: string | null };
    expect(readBody.unread_count).toBe(0);
    expect(readBody.last_read_at).toBeString();
  });

  test("POST /v1/turns/stop refuses a group turn and skips group when no turn_id", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = h.store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const groupMsg = h.store.postMessage(group.id, { body: "go" });
    const groupTurn = h.store.createTurn({
      sessionId: group.id,
      botId: writer.bot.id,
      triggerMessageId: groupMsg.id,
    });
    const refused = await fetch(`${h.origin}/v1/turns/stop`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ turn_id: groupTurn.id }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      error: { code: "invalid_args", message: "group turns cannot be stopped" },
    });
    expect(h.store.getTurn(groupTurn.id).status).toBe("running");

    const skipped = await fetch(`${h.origin}/v1/turns/stop`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(skipped.status).toBe(204);
    expect(h.store.getTurn(groupTurn.id).status).toBe("running");

    const directMsg = h.store.postMessage(writer.direct_session.id, { body: "hi" });
    const directTurn = h.store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: directMsg.id,
    });
    const stopped = await fetch(`${h.origin}/v1/turns/stop`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ turn_id: directTurn.id }),
    });
    expect(stopped.status).toBe(200);
    expect(h.store.getTurn(directTurn.id).status).toBe("stopped");
    expect(h.store.getTurn(groupTurn.id).status).toBe("running");
  });

  test("POST /v1/turns/continue opens a new turn from an interrupted system note", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = h.store.postMessage(writer.direct_session.id, { body: "go" });
    const turn = h.store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    h.store.interruptRunningTurns();
    const note = h.store
      .listMainMessages(writer.direct_session.id, 10)
      .find((m) => m.kind === "system" && m.body === "中断");
    expect(note?.id).toBeString();

    const missing = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(422);

    const continued = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ message_id: note!.id }),
    });
    expect(continued.status).toBe(200);
    const body = (await continued.json()) as {
      id: string;
      bot_id: string;
      session_id: string;
      trigger_message_id: string;
      status: string;
    };
    expect(body.bot_id).toBe(writer.bot.id);
    expect(body.session_id).toBe(writer.direct_session.id);
    expect(body.trigger_message_id).toBe(note!.id);
    expect(body.status).toBe("running");
    expect(body.id).not.toBe(turn.id);
    expect(h.store.getMessage(note!.id).source_turn_id).toBe(body.id);

    const again = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ message_id: note!.id }),
    });
    expect(again.status).toBe(422);
    expect(h.store.getTurn(turn.id).status).toBe("interrupted");
  });

  test("workspace paths ride on a message as they are: no copy, nothing in inbox", async () => {
    const h = await start();
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-ref-ws-")));
    mkdirSync(join(ws, "docs"));
    mkdirSync(join(ws, "shots"));
    writeFileSync(join(ws, "docs", "brief.md"), "# brief");
    writeFileSync(join(ws, "shots", "a.png"), noisePng(4, 4));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const { direct_session: session } = h.store.createBot({ name: "Reader", duties: "read", boundaries: "stay" });
    const post = (body: BodyInit, json = true) => fetch(`${h.origin}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: auth(h, json ? { "Content-Type": "application/json" } : {}),
      body,
    });
    type Posted = { attachments: Array<{ workspace_relpath: string; original_filename: string; exists: boolean; is_dir: boolean }> };

    const posted = await post(JSON.stringify({ body: "看看这两个", paths: ["docs/brief.md", "./shots/a.png", "docs/brief.md", "shots"] }));
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as Posted;
    expect(message.attachments.map((row) => [row.workspace_relpath, row.original_filename, row.exists, row.is_dir])).toEqual([
      ["docs/brief.md", "brief.md", true, false],
      ["shots/a.png", "a.png", true, false],
      ["shots", "shots", true, true],
    ]);
    expect(existsSync(join(ws, "inbox"))).toBe(false);

    // Beside uploaded files, multipart carries the list as one JSON field.
    const form = new FormData();
    form.append("body", "");
    form.append("files", new File([new Uint8Array([1, 2])], "note.txt", { type: "text/plain" }));
    form.append("paths", JSON.stringify(["docs/brief.md"]));
    const mixed = await post(form, false);
    expect(mixed.status).toBe(201);
    const both = (await mixed.json()) as Posted;
    expect(both.attachments.map((row) => row.workspace_relpath)).toEqual([expect.stringMatching(/^inbox\//), "docs/brief.md"]);

    const before = h.store.listMessages(session.id).items.length;
    for (const paths of [["../outside.txt"], ["/etc/hosts"], ["."], [""], "docs/brief.md", [3]]) {
      expect((await post(JSON.stringify({ body: "x", paths }))).status).toBe(422);
    }
    expect(h.store.listMessages(session.id).items.length).toBe(before);
    const dropped = await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "", paths: ["docs/brief.md"] }),
    });
    expect(dropped.status).toBe(422);
  });

  test("workspace paths need a workspace to point into", async () => {
    const h = await start();
    const { direct_session: session } = h.store.createBot({ name: "Reader", duties: "read", boundaries: "stay" });
    const posted = await fetch(`${h.origin}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "x", paths: ["docs/brief.md"] }),
    });
    expect(posted.status).toBe(422);
    expect(h.store.listMessages(session.id).items).toEqual([]);
  });

  test("posting multipart/form-data with attachments saves to inbox and serves content", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-att-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });

    const botRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "AttBot", duties: "d", boundaries: "b" }),
    });
    const { direct_session } = (await botRes.json()) as { direct_session: { id: string } };

    const form = new FormData();
    form.append("body", "here is an image");
    const testFile = new File([new Uint8Array([1, 2, 3, 4])], "test-image.png", { type: "image/png" });
    form.append("files", testFile);

    const postRes = await fetch(`${h.origin}/v1/sessions/${direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: form,
    });
    expect(postRes.status).toBe(201);
    const msg = (await postRes.json()) as {
      id: string;
      body: string;
      attachments: Array<{ id: string; original_filename: string; workspace_relpath: string }>;
    };
    expect(msg.body).toBe("here is an image");
    expect(msg.attachments.length).toBe(1);
    expect(msg.attachments[0]!.original_filename).toBe("test-image.png");
    expect(msg.attachments[0]!.workspace_relpath).toStartWith("inbox/");

    // Test GET /v1/attachments/:id
    const attRes = await fetch(`${h.origin}/v1/attachments/${msg.attachments[0]!.id}`, {
      headers: auth(h),
    });
    expect(attRes.status).toBe(200);
    const attMeta = (await attRes.json()) as { id: string; original_filename: string };
    expect(attMeta.original_filename).toBe("test-image.png");

    // Test GET /v1/attachments/:id/content
    const contentRes = await fetch(`${h.origin}/v1/attachments/${msg.attachments[0]!.id}/content`, {
      headers: auth(h),
    });
    expect(contentRes.status).toBe(200);
    const buf = await contentRes.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));

    rmSync(ws, { recursive: true, force: true });
  });

  test("bot-cited workspace files serve content and search hits", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-cite-ws-"));
    mkdirSync(join(ws, "out"));
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "out", "mock.png"), new Uint8Array([9, 8, 7]));
    writeFileSync(join(ws, "report.md"), "# report\n");
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const botRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "CiteBot", duties: "d", boundaries: "b" }),
    });
    const { bot, direct_session } = (await botRes.json()) as {
      bot: { id: string };
      direct_session: { id: string };
    };
    const message = h.store.insertMessage({
      sessionId: direct_session.id,
      kind: "bot",
      author: bot.id,
      body: "稿在 [mock](out/mock.png)",
      paths: ["out/mock.png", "src"],
    });
    expect(message.attachments[0]?.workspace_relpath).toBe("out/mock.png");
    expect(message.attachments[0]?.exists).toBe(true);
    expect(message.attachments[1]?.is_dir).toBe(true);

    const contentRes = await fetch(`${h.origin}/v1/attachments/${message.attachments[0]!.id}/content`, {
      headers: auth(h),
    });
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await contentRes.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));

    const dirAtt = message.attachments[1]!;
    const dirRes = await fetch(`${h.origin}/v1/attachments/${dirAtt.id}/content`, { headers: auth(h) });
    expect(dirRes.status).toBe(422);

    const missing = h.store.insertMessage({
      sessionId: direct_session.id,
      kind: "bot",
      author: bot.id,
      body: "gone",
      paths: ["out/gone.png"],
    });
    const missingRes = await fetch(`${h.origin}/v1/attachments/${missing.attachments[0]!.id}/content`, {
      headers: auth(h),
    });
    expect(missingRes.status).toBe(404);

    const searchRes = await fetch(`${h.origin}/v1/search?q=${encodeURIComponent("report.md")}`, {
      headers: auth(h),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { items: Array<{ kind: string; path?: string }> };
    expect(searchBody.items.some((hit) => hit.kind === "file" && hit.path === "report.md")).toBe(true);

    rmSync(ws, { recursive: true, force: true });
  });

  test("skills CRUD publishes upsert and removed events", async () => {
    const h = await start();
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const bot = (await created.json()) as { bot: { id: string } };
    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    const posted = await fetch(`${h.origin}/v1/skills`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        bot_id: bot.bot.id,
        name: "commits",
        description: "when committing",
        body: "use conventional commits",
        uses: ["github", ""],
      }),
    });
    expect(posted.status).toBe(201);
    const skill = (await posted.json()) as { id: string; name: string; enabled: boolean; uses: string[] };
    expect(skill.name).toBe("commits");
    expect(skill.enabled).toBe(true);
    expect(skill.uses).toEqual(["github"]);
    const reUsed = await fetch(`${h.origin}/v1/skills/${skill.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ uses: ["github", "slack"] }),
    });
    expect(reUsed.status).toBe(200);
    expect(((await reUsed.json()) as { uses: string[] }).uses).toEqual(["github", "slack"]);
    await Bun.sleep(20);
    expect(events.some((e) => e.event === "skill.upsert" && e.id === skill.id)).toBe(true);
    const listed = await fetch(`${h.origin}/v1/skills`, { headers: auth(h) });
    const page = (await listed.json()) as { items: Array<{ id: string }> };
    expect(page.items.map((row) => row.id)).toEqual([skill.id]);
    const patched = await fetch(`${h.origin}/v1/skills/${skill.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    const deleted = await fetch(`${h.origin}/v1/skills/${skill.id}`, {
      method: "DELETE",
      headers: auth(h),
    });
    expect(deleted.status).toBe(204);
    await Bun.sleep(20);
    expect(events.some((e) => e.event === "skill.removed" && e.id === skill.id)).toBe(true);
    ws.close();
  });
});

describe("mcp servers", () => {
  test("usage_note round-trips through POST and PATCH and rejects an over-long note", async () => {
    const h = await start();
    const posted = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "github",
        command: "bun",
        args: ["run", "gh.ts"],
        enabled: false,
        usage_note: "  Only for the real-bot repo.  ",
      }),
    });
    expect(posted.status).toBe(201);
    const server = (await posted.json()) as { id: string; usage_note: string | null; instructions: string | null };
    expect(server.usage_note).toBe("Only for the real-bot repo.");
    expect(server.instructions).toBeNull();

    const patched = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ usage_note: "Read-only." }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { usage_note: string | null }).usage_note).toBe("Read-only.");

    const listed = await fetch(`${h.origin}/v1/mcp-servers`, { headers: auth(h) });
    const page = (await listed.json()) as { items: Array<{ id: string; usage_note: string | null }> };
    expect(page.items.find((row) => row.id === server.id)?.usage_note).toBe("Read-only.");

    const cleared = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ usage_note: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { usage_note: string | null }).usage_note).toBeNull();

    const tooLong = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ usage_note: "x".repeat(2001) }),
    });
    expect(tooLong.status).toBe(422);
    expect(await tooLong.json()).toEqual({
      error: { code: "invalid_args", message: "usage_note must be at most 2000 characters" },
    });
  });
});

describe("a Bot↔Bot direct is view-only", () => {
  async function twoBotsTalking(h: Harness) {
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = h.store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const direct = h.store.createBotDirect(writer.bot.id, researcher.bot.id, null);
    return { writer, researcher, direct };
  }

  test("posting into one is 403 not_a_member and writes nothing", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "let me in" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_a_member");
    expect(h.store.listMainMessages(direct.id, 10)).toEqual([]);
  });

  test("the multipart path is refused too", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    const form = new FormData();
    form.set("body", "notes attached");
    form.set("files", new File([Buffer.from("hi")], "note.txt", { type: "text/plain" }));
    const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: form,
    });
    expect(res.status).toBe(403);
    expect(h.store.listMainMessages(direct.id, 10)).toEqual([]);
  });

  test("posting into your own direct and into a group still works", async () => {
    const h = await start();
    const { writer } = await twoBotsTalking(h);
    const res = await fetch(`${h.origin}/v1/sessions/${writer.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "hello" }),
    });
    expect(res.status).toBe(201);
  });

  /** Read-only is about not joining in. Tidying your own view stays yours. */
  test("read, archive, restore and clear still work on one", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    for (const path of ["read", "archive", "restore", "clear"]) {
      const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/${path}`, {
        method: "POST",
        headers: auth(h),
      });
      expect([200, 204]).toContain(res.status);
    }
  });

  test("composer suggestions come back empty rather than failing", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/composer-suggestions`, {
      headers: auth(h),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("the session list carries where a direct came from", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = h.store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const group = h.store.createGroup({
      name: "Desk",
      members: [writer.bot.id, researcher.bot.id],
    });
    const trigger = h.store.postMessage(group.id, { body: "go ask" });
    const direct = h.store.createBotDirect(writer.bot.id, researcher.bot.id, {
      sessionId: group.id,
      messageId: trigger.id,
    });
    const res = await fetch(`${h.origin}/v1/sessions`, { headers: auth(h) });
    const body = (await res.json()) as {
      items: Array<{ id: string; origin_session_id: string | null; origin_message_id: string | null }>;
    };
    const listed = body.items.find((s) => s.id === direct.id);
    expect(listed).toBeDefined();
    expect(listed?.origin_session_id).toBe(group.id);
    expect(listed?.origin_message_id).toBe(trigger.id);
  });
});

describe("picture variants", () => {
  const etagOf = (bytes: Uint8Array) =>
    `"${(require("node:crypto") as typeof import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}"`;

  test.skipIf(process.platform !== "darwin")("size asks for a scaled copy and says what the original weighs", async () => {
    const h = await start();
    const ws = mkdtempSync(join(tmpdir(), "real-bot-variant-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const picture = noisePng(1200, 800);
    writeFileSync(join(ws, "frame.png"), picture);
    writeFileSync(join(ws, "notes.md"), "# notes\n");
    const file = (query: string) => fetch(`${h.origin}/v1/workspace/file?${query}`, { headers: auth(h) });

    const thumb = await file("path=frame.png&size=thumb");
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Content-Type")).toBe("image/jpeg");
    expect(thumb.headers.get("X-Original-Size")).toBe(String(picture.byteLength));
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(picture.byteLength / 10);
    // The ETag is the bytes sent, which is what a remote client checks them against.
    expect(thumb.headers.get("ETag")).toBe(etagOf(bytes));

    const original = await file("path=frame.png");
    expect(original.headers.get("X-Original-Size")).toBeNull();
    expect((await original.arrayBuffer()).byteLength).toBe(picture.byteLength);
    // Not a picture: the original, and nothing says otherwise.
    const note = await file("path=notes.md&size=preview");
    expect(note.headers.get("X-Original-Size")).toBeNull();
    expect(await note.text()).toBe("# notes\n");
    expect((await file("path=frame.png&size=full")).status).toBe(422);

    const botRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "PicBot", duties: "d", boundaries: "b" }),
    });
    const { direct_session } = (await botRes.json()) as { direct_session: { id: string } };
    const form = new FormData();
    form.append("body", "a keyframe");
    form.append("files", new File([picture], "frame.png", { type: "image/png" }));
    const posted = (await (await fetch(`${h.origin}/v1/sessions/${direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: form,
    })).json()) as { attachments: Array<{ id: string }> };
    const content = (size: string) => fetch(`${h.origin}/v1/attachments/${posted.attachments[0]!.id}/content?size=${size}`, { headers: auth(h) });
    const chip = await content("thumb");
    expect(chip.status).toBe(200);
    expect(chip.headers.get("Content-Type")).toBe("image/jpeg");
    expect(chip.headers.get("X-Original-Size")).toBe(String(picture.byteLength));
    // 1200 px is already within an enlargement's 1600: the original goes, unmarked.
    const enlarged = await content("preview");
    expect(enlarged.headers.get("Content-Type")).toBe("image/png");
    expect(enlarged.headers.get("X-Original-Size")).toBeNull();
    expect((await enlarged.arrayBuffer()).byteLength).toBe(picture.byteLength);
    expect((await fetch(`${h.origin}/v1/attachments/${posted.attachments[0]!.id}/content?size=full`, { headers: auth(h) })).status).toBe(422);
    rmSync(ws, { recursive: true, force: true });
  });
});

/** A phone opening a conversation used to get the whole transcript back from marking it read. */
test("marking a conversation read answers with its read state, not its transcript", async () => {
  const h = await start();
  const created = h.store.createBot({ name: "Reader", duties: "d", boundaries: "b" });
  const message = h.store.postMessage(created.direct_session.id, { body: "hello" });
  const res = await fetch(`${h.origin}/v1/sessions/${created.direct_session.id}/read`, {
    method: "POST",
    headers: auth(h, { "Content-Type": "application/json" }),
    body: JSON.stringify({ through_message_id: message.id }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.id).toBe(created.direct_session.id);
  expect(body.unread_count).toBe(0);
  expect(body.last_read_at).toBeString();
  expect(body).not.toHaveProperty("messages");
  expect(body).not.toHaveProperty("turns");
});

/**
 * A profile save sends back the portrait it was shown with every other edit. That is the small
 * copy clients are sent; saving it would have replaced the original with a thumbnail.
 */
test.skipIf(process.platform !== "darwin")("a profile save that sends back the shown portrait keeps the original", async () => {
  const h = await start();
  const original = `data:image/png;base64,${noisePng(256, 256).toString("base64")}`;
  const { bot } = h.store.createBot({ name: "Painter", duties: "d", boundaries: "b", avatar: original });
  await warmDisplayAvatar(original);
  const snapshot = await (await fetch(`${h.origin}/v1/snapshot`, { headers: auth(h) })).json() as { bots: Array<{ id: string; avatar: string }> };
  const shown = snapshot.bots.find((row) => row.id === bot.id)!.avatar;
  expect(shown).toMatch(/;rb-display=/);
  expect(shown.length).toBeLessThan(original.length / 4);

  const patch = (body: Record<string, unknown>) => fetch(`${h.origin}/v1/bots/${bot.id}`, {
    method: "PATCH",
    headers: auth(h, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const saved = await patch({ duties: "paints", avatar: shown });
  expect(saved.status).toBe(200);
  expect(h.store.getBot(bot.id).avatar).toBe(original);
  expect(h.store.getBot(bot.id).duties).toBe("paints");
  // A picture chosen in the editor is a new portrait and is stored.
  const chosen = "data:image/svg+xml;base64,PHN2Zy8+";
  expect((await patch({ avatar: chosen })).status).toBe(200);
  expect(h.store.getBot(bot.id).avatar).toBe(chosen);
});

/** A phone asks for the screenful it shows; older history comes a page at a time as it scrolls. */
test("a conversation snapshot pages its first history by limit", async () => {
  const h = await start();
  const created = h.store.createBot({ name: "Pager", duties: "d", boundaries: "b" });
  for (let i = 0; i < 25; i++) h.store.postMessage(created.direct_session.id, { body: `m${i}` });
  const snap = (query: string) => fetch(`${h.origin}/v1/sessions/${created.direct_session.id}/snapshot${query}`, { headers: auth(h) })
    .then(async (res) => ({ status: res.status, body: await res.json() as { session: { messages: { items: unknown[]; next: string | null } } } }));
  const paged = await snap("?limit=20");
  expect(paged.status).toBe(200);
  expect(paged.body.session.messages.items).toHaveLength(20);
  expect(paged.body.session.messages.next).toBeString();
  expect((await snap("")).body.session.messages.items).toHaveLength(25);
  expect((await snap("?limit=0")).status).toBe(422);
});

test("spend summary and detail pages filter, page, and stay out of the snapshot", async () => {
  const h = await start();
  const created = h.store.createBot({ name: "Writer", duties: "d", boundaries: "b" });
  const provider = h.store.createProviderSync({
    name: "Priced",
    base_url: "https://priced.invalid",
    models: [{ name: "fast", price: 1, pricing: { input: 1, output: 1 } }],
  });
  h.store.insertSpend({
    kind: "turn",
    sessionId: created.direct_session.id,
    botId: created.bot.id,
    turnId: created.bot.id,
    providerId: provider.id,
    model: "fast",
    inputTokens: 10,
    outputTokens: 2,
    costUsdTicks: 4,
  });
  h.store.insertSpend({
    kind: "composer_suggest",
    sessionId: created.direct_session.id,
    botId: null,
    providerId: provider.id,
    model: "fast",
    inputTokens: 3,
    outputTokens: 1,
  });
  const get = (path: string) => fetch(`${h.origin}${path}`, { headers: auth(h) });
  const summary = await get("/v1/spend/summary?group_by=kind&tz=UTC&kind=turn,composer_suggest");
  expect(summary.status).toBe(200);
  const body = await summary.json() as { totals: { calls: number; reported_usd_ticks: number | null; estimated_usd_ticks: number | null }; groups: Array<{ id: string }> };
  expect(body.totals.calls).toBe(2);
  expect(body.totals.reported_usd_ticks).toBe(4);
  expect(body.totals.estimated_usd_ticks).toBe(40_000);
  expect(body.groups.map((row) => row.id).sort()).toEqual(["composer_suggest", "turn"]);
  const unassigned = await get("/v1/spend/summary?bot_id=&group_by=bot");
  expect((await unassigned.json() as { totals: { calls: number } }).totals.calls).toBe(1);
  const page = await get("/v1/spend?limit=1&kind=turn&kind=composer_suggest");
  const first = await page.json() as { items: Array<{ kind: string }>; next: string | null };
  expect(first.items).toHaveLength(1);
  expect(first.next).toBeString();
  const rest = await get(`/v1/spend?limit=1&cursor=${encodeURIComponent(first.next!)}`);
  expect((await rest.json() as { items: unknown[]; next: string | null }).items).toHaveLength(1);
  expect((await get("/v1/spend?from=yesterday")).status).toBe(422);
  expect((await get("/v1/spend?from=2026-02-31T00:00:00.000Z")).status).toBe(422);
  expect((await get("/v1/spend?to=2026-04-31T00:00:00Z")).status).toBe(422);
  const noMillis = await get("/v1/spend?from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00.001Z");
  expect(noMillis.status).toBe(200);
  expect((await noMillis.json() as { items: unknown[] }).items).toHaveLength(0);
  expect((await get("/v1/spend/summary?tz=Not/AZone")).status).toBe(422);
  expect((await get("/v1/spend?limit=0")).status).toBe(422);
  // A purpose is a line of its own (ADR 0042): the scribe's call is not the organizer's.
  h.store.insertSpend({ kind: "organize", purpose: "scribe", sessionId: created.direct_session.id, botId: null, model: "fast", inputTokens: 5, outputTokens: 1 });
  const lines = await (await get("/v1/spend/summary?group_by=kind&tz=UTC&kind=scribe&kind=organize")).json() as { groups: Array<{ id: string; calls: number }> };
  expect(lines.groups.map((row) => [row.id, row.calls])).toEqual([["scribe", 1]]);
  const scribed = await (await get("/v1/spend?kind=scribe")).json() as { items: Array<{ kind: string; purpose: string | null }> };
  expect(scribed.items).toMatchObject([{ kind: "organize", purpose: "scribe" }]);
  expect((await get("/v1/spend?kind=scribble")).status).toBe(422);
  const snapshot = await (await get("/v1/snapshot")).json() as Record<string, unknown>;
  expect("spend" in snapshot).toBe(false);
});

test("media file GETs serve ranges through workspace and attachment paths", async () => {
  const h = await start();
  const dir = mkdtempSync(join(tmpdir(), "rb-media-api-"));
  try {
    await h.store.patchSettings({ workspace_path: dir });
    writeFileSync(join(dir, "clip.mp4"), "0123456789");
    const ask = (query: string, range?: string) => fetch(`${h.origin}/v1/workspace/file?path=clip.mp4${query}`, { headers: auth(h, range ? { Range: range } : {}) });
    for (const response of [await ask("", "bytes=2-5"), await ask("&range=bytes%3D2-5")]) {
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(await response.text()).toBe("2345");
    }
    expect((await ask("&size=preview&range=bytes%3D0-1")).status).toBe(422);
    expect((await ask("", "bytes=100-")).status).toBe(416);
    expect((await fetch(`${h.origin}/v1/workspace/file?path=..%2Foutside.mp4&range=bytes%3D0-1`, { headers: auth(h) })).status).toBe(422);
    expect((await fetch(`${h.origin}/v1/workspace/file?path=.&range=bytes%3D0-1`, { headers: auth(h) })).status).toBe(422);
    const form = new FormData();
    form.append("files", new File(["abcdefghij"], "audio.mp3", { type: "audio/mpeg" }));
    const uploaded = await fetch(`${h.origin}/v1/sessions/${FILE_DROP_SESSION_ID}/messages`, { method: "POST", headers: auth(h), body: form });
    expect(uploaded.status).toBe(201);
    const message = await uploaded.json() as { attachments: Array<{ id: string }> };
    const audio = await fetch(`${h.origin}/v1/attachments/${message.attachments[0]!.id}/content?range=bytes%3D-3`, { headers: auth(h) });
    expect(audio.status).toBe(206);
    expect(await audio.text()).toBe("hij");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe("lessons", () => {
  test("retiring a reflection's waiting proposal in Settings closes its card for every open chat at once", async () => {
    const h = await start();
    h.store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '8')");
    const maker = h.store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" }).bot;
    const reviewer = h.store.createBot({ name: "审片员", duties: "审片", boundaries: "none" }).bot;
    const room = h.store.createGroup({ name: "Studio", members: [maker.id, reviewer.id] });
    const plan = h.store.openTask({ sessionId: room.id, title: "EP01" });
    const ticket = h.store.createTicket({ taskId: plan.id, title: "第七镜", worker: maker.id });
    h.store.recordWorkEvent({ kind: "review.miss", actor: "user", botId: reviewer.id, taskId: plan.id, ticketId: ticket.id,
      payload: { reviewer_bot_id: reviewer.id, reviewer_model: "m", message_id: null, card_id: "c1" } });
    const { lesson, message } = h.store.recordReflection(h.store.claimDueReflection()!, { kind: "checklist", hook: "before_review", text: "逐帧比对" });

    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => events.push(JSON.parse(String(ev.data)) as Record<string, unknown>));
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    const res = await fetch(`${h.origin}/v1/lessons/${lesson!.id}`, { method: "PATCH", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify({ status: "retired" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: lesson!.id, status: "retired" });
    await Bun.sleep(50);
    ws.close();
    const upserts = events.filter((event) => event.event === "message.upsert" && event.id === message!.id);
    expect(upserts.at(-1)).toMatchObject({ control: { kind: "lesson", acted: ["decline"] } });
  });
});
