import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL_API_BIND, LOCAL_API_NAME } from "@real-bot/protocol";
import { startRuntime, type RuntimeHandle } from "./runtime";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

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
    expect(await ok.json()).toEqual({ pid: process.pid, bind: LOCAL_API_BIND });
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
});
