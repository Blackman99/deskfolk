import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalApi } from "./local-api";
import { ptyHelperPath } from "./pty";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

/** The real helper, for the same reason as pty.test.ts: a mocked terminal proves nothing. */
const helperBuilt = (() => {
  try { ptyHelperPath(); return true; } catch { return false; }
})();
const withHelper = helperBuilt ? test : test.skip;

type Harness = {
  origin: string;
  token: string;
  cwd: string;
  close: () => Promise<void>;
};
const open: Harness[] = [];

async function start(): Promise<Harness> {
  const store = new Store({ endpointKey: memoryKeyStore(null) });
  const api = createLocalApi({ store, token: "test-token", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const harness: Harness = {
    origin: `http://${server.hostname}:${server.port}`,
    token: "test-token",
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "real-bot-term-"))),
    close: async () => {
      api.terminals.shutdown();
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
      rmSync(harness.cwd, { recursive: true, force: true });
    },
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${h.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function scrollback(h: Harness, id: string, from = 0): Promise<string> {
  const response = await call(h, "GET", `/v1/terminals/${id}/scrollback?from=${from}`);
  const page = await response.json() as { data: string };
  return Buffer.from(page.data, "base64").toString("utf8");
}

/** A pty answers when it answers; poll rather than pick a number and hope. */
async function until(check: () => Promise<boolean>, capMs = 15000): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(100);
  }
  return false;
}

test("an unknown terminal is a 404, not a crash", async () => {
  const h = await start();
  expect((await call(h, "GET", "/v1/terminals/01J0000000000000000000000B")).status).toBe(404);
});

test("cwd has to be an absolute path", async () => {
  const h = await start();
  expect((await call(h, "POST", "/v1/terminals", { cwd: "relative/path" })).status).toBe(422);
});

withHelper("a session opens, runs a command and reports its output", async () => {
  const h = await start();
  const created = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd, rows: 30, cols: 100 })).json() as { id: string; title: string; status: string; rows: number };
  expect(created.status).toBe("live");
  expect(created.rows).toBe(30);
  expect(created.title).toBe(h.cwd.split("/").at(-1) ?? "");

  await call(h, "POST", `/v1/terminals/${created.id}/input`, { data: Buffer.from("echo HELLO_TERMINAL\n").toString("base64") });
  expect(await until(async () => (await scrollback(h, created.id)).includes("HELLO_TERMINAL"))).toBe(true);

  const list = await (await call(h, "GET", "/v1/terminals")).json() as { items: Array<{ id: string; stream_end: number }> };
  expect(list.items).toHaveLength(1);
  expect(list.items[0]!.stream_end).toBeGreaterThan(0);
});

withHelper("the scrollback cursor is a byte offset", async () => {
  const h = await start();
  const { id } = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  await call(h, "POST", `/v1/terminals/${id}/input`, { data: Buffer.from("echo FIRST_MARK\n").toString("base64") });
  expect(await until(async () => (await scrollback(h, id)).includes("FIRST_MARK"))).toBe(true);
  const mark = (await (await call(h, "GET", `/v1/terminals/${id}`)).json() as { stream_end: number }).stream_end;
  await call(h, "POST", `/v1/terminals/${id}/input`, { data: Buffer.from("echo SECOND_MARK\n").toString("base64") });
  expect(await until(async () => (await scrollback(h, id, mark)).includes("SECOND_MARK"))).toBe(true);
  expect(await scrollback(h, id, mark)).not.toContain("FIRST_MARK");
});

withHelper("a resize reaches the program inside", async () => {
  const h = await start();
  const { id } = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd, rows: 24, cols: 80 })).json() as { id: string };
  const resized = await (await call(h, "POST", `/v1/terminals/${id}/resize`, { rows: 40, cols: 132 })).json() as { cols: number };
  expect(resized.cols).toBe(132);
  await call(h, "POST", `/v1/terminals/${id}/input`, { data: Buffer.from("tput cols\n").toString("base64") });
  expect(await until(async () => /\b132\b/.test(await scrollback(h, id)))).toBe(true);
});

withHelper("a signal stops the session", async () => {
  const h = await start();
  const { id } = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  expect((await call(h, "POST", `/v1/terminals/${id}/signal`, { signal: "SIGKILL" })).status).toBe(204);
  expect(await until(async () => (await (await call(h, "GET", `/v1/terminals/${id}`)).json() as { status: string }).status === "exited")).toBe(true);
  expect((await call(h, "POST", `/v1/terminals/${id}/input`, { data: "" })).status).toBe(409);
});

test("an unknown signal is refused", async () => {
  const h = await start();
  expect((await call(h, "POST", "/v1/terminals/01J0000000000000000000000B/signal", { signal: "SIGSEGV" })).status).toBe(422);
});

withHelper("deleting a session forgets it and its scrollback", async () => {
  const h = await start();
  const { id } = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  expect((await call(h, "DELETE", `/v1/terminals/${id}`)).status).toBe(204);
  expect((await call(h, "GET", `/v1/terminals/${id}`)).status).toBe(404);
  const list = await (await call(h, "GET", "/v1/terminals")).json() as { items: unknown[] };
  expect(list.items).toHaveLength(0);
});

withHelper("Quit ends the sessions rather than leaving them running", async () => {
  const h = await start();
  await call(h, "POST", "/v1/terminals", { cwd: h.cwd });
  expect((await call(h, "POST", "/v1/runtime/quit")).status).toBe(204);
  const list = await (await call(h, "GET", "/v1/terminals")).json() as { items: unknown[] };
  expect(list.items).toHaveLength(0);
});

withHelper("terminal writes leave no request receipt behind", async () => {
  const h = await start();
  const { id } = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  const before = await call(h, "POST", `/v1/terminals/${id}/input`, { data: Buffer.from("echo A\n").toString("base64") });
  expect(before.status).toBe(204);
  // A receipted mutation answers with its request id; a keystroke has nothing to replay.
  expect(before.headers.get("X-Request-Id")).toBeNull();
});
