import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL_API_BIND, LOCAL_API_NAME } from "@real-bot/protocol";
import { stateDbPath } from "./descriptor";
import { recordLiveProc } from "./live-procs";
import { startRuntime, type RuntimeHandle } from "./runtime";
import { memoryKeyStore } from "./secrets";
import { startupLogPath } from "./startup-log";
import { Store } from "./store";
import { ENGINE_LEVEL_BY_DEFAULT, SCHEMA_LEVEL } from "./store/schema-gate";

const handles: RuntimeHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()?.stop();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** The persisted shutdown flag, through a separate readonly handle, synchronously. */
function shutdownFlag(dataDir: string): string | null {
  const probe = new Database(stateDbPath(dataDir), { readonly: true });
  try {
    return probe.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'last_shutdown'").get()?.value ?? null;
  } finally {
    probe.close();
  }
}

async function start(overrides: Parameters<typeof startRuntime>[0] extends infer T ? Partial<T> : never = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "real-bot-"));
  dirs.push(dataDir);
  chmodSync(dataDir, 0o700);
  const handle = await startRuntime({
    dataDir,
    bind: "127.0.0.1:0",
    endpointKey: memoryKeyStore(),
    ...overrides,
  });
  handles.push(handle);
  return handle;
}

describe("local API runtime", () => {
  test("health is unauthenticated and names real-bot", async () => {
    const rt = await start();
    const res = await fetch(`${rt.origin}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: LOCAL_API_NAME });
  });

  test("writes local-api.json with 0600 and live pid/port/token", async () => {
    const rt = await start();
    expect(existsSync(rt.discoveryPath)).toBe(true);
    expect(statSync(rt.discoveryPath).mode & 0o777).toBe(0o600);
    expect(statSync(rt.dataDir).mode & 0o777).toBe(0o700);
    const body = JSON.parse(await Bun.file(rt.discoveryPath).text()) as {
      pid: number;
      port: number;
      token: string;
      started_at: string;
    };
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBe(rt.port);
    expect(body.token).toBe(rt.token);
    expect(body.token.length).toBeGreaterThanOrEqual(64);
    expect(Number.isNaN(Date.parse(body.started_at))).toBe(false);
  });

  test("a normal stop records a clean shutdown; the next boot reads it before resetting to crash", async () => {
    const rt = await start();
    const stopped = rt.stop();
    // Written before stop() awaits anything, so a kill that lands mid-shutdown still reads as clean.
    expect(shutdownFlag(rt.dataDir)).toBe("clean");
    await stopped;
    const reopened = new Store({ filename: stateDbPath(rt.dataDir) });
    expect(reopened.previousShutdown).toBe("clean");
    reopened.close();
  });

  test("a process that never calls stop leaves the flag at crash for the next boot", async () => {
    const rt = await start();
    // Simulates a crash without disturbing the live runtime: a real crash kills the whole process,
    // it does not leave this same runtime's engine/scheduler/terminals running against a store this
    // test closed out from under them (closing `rt.store` directly here used to abort `stop()`
    // partway through at `quiesce.close()`, on the now-closed store, which then left the engine's
    // and scheduler's timers running into later test files). Read the persisted flag through a
    // separate handle instead, and let afterEach's `stop()` shut this runtime down normally.
    expect(shutdownFlag(rt.dataDir)).toBe("crash");
  });

  test("POST /v1/runtime/quit records a clean shutdown before its stop() awaits anything", async () => {
    // Quit calls onQuit, then books stop() on a zero-delay timer. A timer booked from onQuit fires
    // first, so this test's own stop() is the one that starts the shutdown, and the flag is read while
    // that shutdown has done nothing but run its first synchronous statements: the window's quit
    // handler kills the daemon 200ms after asking, so a write placed after anything slow in stop()
    // would lose that race and the next boot would read a crash.
    // Assigned from the timer below; typed by cast so the checks after it are not narrowed away.
    let stopping = undefined as Promise<void> | undefined;
    let flagAtStop = undefined as string | null | undefined;
    const rt: RuntimeHandle = await start({
      onQuit: () => {
        setTimeout(() => {
          const p = rt.stop();
          flagAtStop = shutdownFlag(rt.dataDir);
          stopping = p;
        }, 0);
      },
    });
    const res = await fetch(`${rt.origin}/v1/runtime/quit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(res.status).toBe(204);
    while (!stopping) await Bun.sleep(1);
    expect(flagAtStop).toBe("clean");
    await stopping;
    const reopened = new Store({ filename: stateDbPath(rt.dataDir) });
    expect(reopened.previousShutdown).toBe("clean");
    reopened.close();
  });

  test("GET /v1/runtime requires a bearer token", async () => {
    const rt = await start();
    const missing = await fetch(`${rt.origin}/v1/runtime`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: "unauthorized", message: "missing or invalid token" },
    });

    const wrong = await fetch(`${rt.origin}/v1/runtime`, {
      headers: { Authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${rt.origin}/v1/runtime`, {
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ pid: process.pid, bind: LOCAL_API_BIND, mode: "none", restart: "unavailable" });
  });

  test("window restart is unavailable when the setup channel never attaches", async () => {
    const rt = await start({ supervisor: "window", desktopRemoteChannel: true });
    const res = await fetch(`${rt.origin}/v1/runtime`, {
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "window", restart: "unavailable" });

    const standalone = await start({ supervisor: "standalone", desktopRemoteChannel: true });
    const stand = await fetch(`${standalone.origin}/v1/runtime`, {
      headers: { Authorization: `Bearer ${standalone.token}` },
    });
    expect(stand.status).toBe(200);
    expect(await stand.json()).toMatchObject({ mode: "standalone", restart: "available" });
  });

  test("rejects a disallowed Origin and allows tauri and localhost", async () => {
    const rt = await start();
    const forbidden = await fetch(`${rt.origin}/v1/runtime`, {
      headers: {
        Authorization: `Bearer ${rt.token}`,
        Origin: "https://evil.example",
      },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: "forbidden_origin", message: "origin is not allowed" },
    });

    const tauri = await fetch(`${rt.origin}/v1/runtime`, {
      headers: {
        Authorization: `Bearer ${rt.token}`,
        Origin: "tauri://localhost",
      },
    });
    expect(tauri.status).toBe(200);

    const vite = await fetch(`${rt.origin}/v1/runtime`, {
      headers: {
        Authorization: `Bearer ${rt.token}`,
        Origin: "http://localhost:5173",
      },
    });
    expect(vite.status).toBe(200);
    expect(vite.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(vite.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");

    const ipv6 = await fetch(`${rt.origin}/v1/runtime`, {
      headers: {
        Authorization: `Bearer ${rt.token}`,
        Origin: "http://[::1]:5173",
      },
    });
    expect(ipv6.status).toBe(200);
    expect(ipv6.headers.get("Access-Control-Allow-Origin")).toBe("http://[::1]:5173");
    expect(ipv6.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
  });

  test("a 127.0.0.1 bind also answers on IPv6 loopback at the same port", async () => {
    const rt = await start();
    const res = await fetch(`http://[::1]:${rt.port}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: LOCAL_API_NAME });
  });

  test("standalone start refuses a stop latch and never serves", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "real-bot-stopped-"));
    dirs.push(dataDir);
    chmodSync(dataDir, 0o700);
    writeFileSync(join(dataDir, "runtime.stop"), "stopped\n", { mode: 0o600 });
    await expect(
      startRuntime({
        dataDir,
        bind: "127.0.0.1:0",
        endpointKey: memoryKeyStore(),
        supervisor: "standalone",
      }),
    ).rejects.toThrow("runtime is stopped");
  });

  test("window start still serves when a leftover latch exists", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "real-bot-window-latch-"));
    dirs.push(dataDir);
    chmodSync(dataDir, 0o700);
    writeFileSync(join(dataDir, "runtime.stop"), "stopped\n", { mode: 0o600 });
    const rt = await startRuntime({
      dataDir,
      bind: "127.0.0.1:0",
      endpointKey: memoryKeyStore(),
      supervisor: "window",
    });
    handles.push(rt);
    const res = await fetch(`${rt.origin}/v1/health`);
    expect(res.status).toBe(200);
    expect(rt.lifecycle.isStopped()).toBe(true);
  });

  test("handoff exit does not write the latch", async () => {
    let handoffs = 0;
    const rt = await start({
      supervisor: "standalone",
      onHandoff: () => {
        handoffs += 1;
      },
    });
    const denied = await fetch(`${rt.origin}/v1/runtime/handoff`, { method: "POST" });
    expect(denied.status).toBe(401);
    const handoff = await fetch(`${rt.origin}/v1/runtime/handoff`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(handoff.status).toBe(204);
    expect(handoffs).toBe(1);
    expect(rt.lifecycle.isStopped()).toBe(false);
  });

  test("runtime stop writes the latch then exits", async () => {
    let stops = 0;
    const rt = await start({
      supervisor: "standalone",
      onRuntimeStop: () => {
        stops += 1;
      },
    });
    const denied = await fetch(`${rt.origin}/v1/runtime/stop`, { method: "POST" });
    expect(denied.status).toBe(401);
    const stop = await fetch(`${rt.origin}/v1/runtime/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(stop.status).toBe(204);
    expect(stops).toBe(1);
    expect(rt.lifecycle.isStopped()).toBe(true);
  });

  test("POST /v1/runtime/quit needs a token, deletes discovery, and stops", async () => {
    let quits = 0;
    const rt = await start({
      onQuit: () => {
        quits += 1;
      },
    });
    const denied = await fetch(`${rt.origin}/v1/runtime/quit`, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(existsSync(rt.discoveryPath)).toBe(true);
    expect(quits).toBe(0);

    const res = await fetch(`${rt.origin}/v1/runtime/quit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(res.status).toBe(204);
    expect(quits).toBe(1);
    expect(existsSync(rt.discoveryPath)).toBe(false);
    await rt.stop();
    await expect(fetch(`${rt.origin}/v1/health`)).rejects.toThrow();
  });

  test("authenticated GET roster is empty and settings have no key", async () => {
    const rt = await start();
    const bots = await fetch(`${rt.origin}/v1/bots`, {
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(bots.status).toBe(200);
    expect(await bots.json()).toEqual({ items: [] });

    const settings = await fetch(`${rt.origin}/v1/settings`, {
      headers: { Authorization: `Bearer ${rt.token}` },
    });
    expect(settings.status).toBe(200);
    expect(await settings.json()).toEqual({
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

  test("a second runtime that cannot bind does not interrupt live turns", async () => {
    const rt = await start();
    const writer = rt.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = rt.store.postMessage(writer.direct_session.id, { body: "go" });
    const turn = rt.store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });

    await expect(
      startRuntime({
        dataDir: rt.dataDir,
        bind: `127.0.0.1:${rt.port}`,
        endpointKey: memoryKeyStore(),
      }),
    ).rejects.toThrow();

    expect(rt.store.getTurn(turn.id).status).toBe("running");
    expect(
      rt.store.listMainMessages(writer.direct_session.id, 20).some((m) => m.body === "中断"),
    ).toBe(false);
  });

  test("start recovers leftover running turns after the port is bound", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "real-bot-"));
    dirs.push(dataDir);
    chmodSync(dataDir, 0o700);
    const filename = join(dataDir, "state.sqlite");
    const keys = memoryKeyStore();
    const prep = new Store({ filename, endpointKey: keys });
    const writer = prep.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = prep.postMessage(writer.direct_session.id, { body: "go" });
    const turn = prep.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    prep.close();

    const rt = await startRuntime({
      dataDir,
      bind: "127.0.0.1:0",
      endpointKey: keys,
    });
    handles.push(rt);

    expect(rt.store.getTurn(turn.id).status).toBe("interrupted");
    expect(
      rt.store.listMainMessages(writer.direct_session.id, 20).some((m) => m.body === "中断"),
    ).toBe(true);
  });

  /**
   * A data folder whose last run died with Writer's turn running in its direct; `prepare` adds to
   * the database before it closes. The runs below are pinned to a plain one, so `bun test --watch`
   * or `REAL_BOT_DEV=1` does not turn the crash into a development restart.
   */
  function crashedMidTurn(prepare: (store: Store, direct: string, botId: string) => void = () => {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "real-bot-"));
    dirs.push(dataDir);
    chmodSync(dataDir, 0o700);
    const keys = memoryKeyStore();
    const prep = new Store({ filename: join(dataDir, "state.sqlite"), endpointKey: keys });
    const writer = prep.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const direct = writer.direct_session.id;
    const trigger = prep.postMessage(direct, { body: "go" });
    const turn = prep.createTurn({ sessionId: direct, botId: writer.bot.id, triggerMessageId: trigger.id });
    prepare(prep, direct, writer.bot.id);
    prep.close();
    const plain = { execArgv: [], env: {} };
    return { dataDir, keys, direct, turn, run: plain };
  }

  /** Every line in a conversation, the ones kept from the Bots included, in the order written. */
  function linesIn(rt: RuntimeHandle, sessionId: string) {
    return rt.store.db
      .query<{ id: string }, [string]>("SELECT id FROM messages WHERE session_id = ? ORDER BY rowid")
      .all(sessionId)
      .map((row) => rt.store.getMessage(row.id));
  }

  test("start tells you, where the job belongs, what the crash before it cut off", async () => {
    const { dataDir, keys, direct, turn, run } = crashedMidTurn();

    const rt = await startRuntime({ dataDir, bind: "127.0.0.1:0", endpointKey: keys, run });
    handles.push(rt);

    const lines = linesIn(rt, direct);
    const note = lines.find((m) => m.body === "中断")!;
    expect(lines.filter((m) => m.control?.kind === "restart").map((m) => m.control)).toEqual([
      { kind: "restart", cause: "crash", notes: [note.id], offer: ["resume", "leave"] },
    ]);
    expect(rt.store.listWorkEvents({ kind: "daemon.restart" }).map((row) => row.payload)).toEqual([{ cause: "crash", cut: [turn.id], boot_id: expect.any(String) }]);
  });

  test("start tells what the restart cut off before a check-back that fell due meanwhile can wake its Bot", async () => {
    const { dataDir, keys, direct, run } = crashedMidTurn((store, sessionId, botId) => {
      store.scheduleCheckBack({ botId, sessionId, turnId: null, note: "看看渲染好了没有", afterMinutes: 1, now: new Date(Date.now() - 10 * 60_000) });
    });
    const offline = async () => {
      throw new Error("offline");
    };

    const rt = await startRuntime({ dataDir, bind: "127.0.0.1:0", endpointKey: keys, run, completions: { complete: offline, judge: offline } });
    handles.push(rt);

    const lines = linesIn(rt, direct);
    const notice = lines.findIndex((m) => m.control?.kind === "restart");
    const woke = lines.findIndex((m) => m.body.includes("看看渲染好了没有"));
    // The scheduler's first tick, at start, fired the check-back; the notice was already there.
    expect(woke).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(woke);
  });

  test("a restart notice that cannot be written is logged, and the daemon starts all the same", async () => {
    const { dataDir, keys, direct, turn, run } = crashedMidTurn((store) => {
      store.db.run(`CREATE TRIGGER no_restart_record BEFORE INSERT ON work_events WHEN NEW.kind = 'daemon.restart' BEGIN SELECT RAISE(ABORT, 'disk said no'); END`);
    });

    const rt = await startRuntime({ dataDir, bind: "127.0.0.1:0", endpointKey: keys, run });
    handles.push(rt);

    expect((await fetch(`${rt.origin}/v1/health`)).status).toBe(200);
    expect(readFileSync(startupLogPath(dataDir), "utf8")).toContain("could not tell what the restart cut off: disk said no");
    // The turn keeps its own 「中断」 line and notification to go on from.
    expect(linesIn(rt, direct).map((m) => (m.control?.kind === "restart" ? "notice" : m.body))).toEqual(["go", "中断"]);
    expect(rt.store.db.query<{ action_state: string }, [string]>(`SELECT action_state FROM notifications WHERE semantic_key = ?`).get(`interrupted:${turn.id}`)).toEqual({ action_state: "open" });
  });

  test("start takes its database to the current engine and schema floor, retaining a legacy plan's hold", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "real-bot-"));
    dirs.push(dataDir);
    chmodSync(dataDir, 0o700);
    const filename = join(dataDir, "state.sqlite");
    const keys = memoryKeyStore();
    const prep = new Store({ filename, endpointKey: keys });
    const writer = prep.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const plan = prep.openTask({ sessionId: writer.direct_session.id, title: "写周报" });
    prep.setTaskSpec(plan.id, { kind: null, goal: "写周报", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "parked" });
    expect(prep.capabilities().engine_level).toBe(0);
    prep.close();

    // A data folder of its own: no installed app opens it, so nothing holds the level back, and with
    // no developer opt-in it goes to the default ceiling — since 2026-10-04 this build's top level.
    const rt = await startRuntime({ dataDir, bind: "127.0.0.1:0", endpointKey: keys });
    handles.push(rt);
    expect(rt.store.capabilities()).toEqual({ schema_level: SCHEMA_LEVEL, engine_level: ENGINE_LEVEL_BY_DEFAULT,
      features: ["holds", "work_items", "delegation", "supervision", "submissions", "jobs", "routing", "learning"] });
    // The default level's floor: levels 7 and 8 leave level 6's.
    expect(rt.store.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe("6");
    expect(rt.store.listHolds({ inForce: true })).toMatchObject([{ scope: "plan", scope_id: plan.id, source: "legacy" }]);
  });

  test.skipIf(process.platform === "win32")("start stops a command an earlier run left running", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "real-bot-"));
    dirs.push(dataDir);
    chmodSync(dataDir, 0o700);
    const filename = join(dataDir, "state.sqlite");
    const keys = memoryKeyStore();
    const prep = new Store({ filename, endpointKey: keys });
    // Recorded the way a Bot's `shell` does it, by a run that then ended without stopping it. That
    // run was this same process, as it is after a `bun --watch` restart.
    const leftover = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      recordLiveProc(prep, leftover, { pgid: leftover.pid, command: "render" });
      const noted = () =>
        prep.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM live_procs WHERE daemon_start_time IS NOT NULL").get()!.n;
      for (let i = 0; i < 150 && noted() === 0; i++) await Bun.sleep(20);
      expect(noted()).toBe(1);
      prep.close();

      const rt = await startRuntime({ dataDir, bind: "127.0.0.1:0", endpointKey: keys });
      handles.push(rt);
      const ended = await Promise.race([leftover.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
      expect(ended).toBe(true);
      expect(leftover.signalCode).toBe("SIGTERM");
      // The row goes once the group has had its grace, SIGKILL included.
      const left = () => rt.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM live_procs").get()!.n;
      for (let i = 0; i < 60 && left() > 0; i++) await Bun.sleep(100);
      expect(left()).toBe(0);
    } finally {
      leftover.kill("SIGKILL");
    }
  }, 15_000);
});
