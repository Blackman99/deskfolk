import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeptTerminal } from "./store/terminals";
import { createLocalApi } from "./local-api";
import type { Pty } from "./pty";
import { ptyHelperPath } from "./pty";
import { memoryKeyStore } from "./secrets";
import { StreamHub } from "./streams";
import { Terminals } from "./terminals";
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

/** The screen a pane would attach to, as the text it serializes to. */
async function screen(h: Harness, id: string): Promise<{ offset: number; text: string; rows: number; cols: number }> {
  const response = await call(h, "GET", `/v1/terminals/${id}/screen`);
  const snapshot = await response.json() as { offset: number; data: string; rows: number; cols: number };
  return { ...snapshot, text: Buffer.from(snapshot.data, "base64").toString("utf8") };
}

async function type(h: Harness, id: string, text: string): Promise<void> {
  await call(h, "POST", `/v1/terminals/${id}/input`, { data: Buffer.from(text).toString("base64") });
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

/**
 * A daemon that stopped and another that opened the same database. `start` uses a fresh memory
 * database, which cannot show a session surviving the process that held it.
 */
async function restartable(): Promise<{ first: Harness; again: () => Promise<Harness>; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-term-keep-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-term-cwd-")));
  const filename = join(dir, "state.sqlite");
  const openOne = async (): Promise<Harness> => {
    const store = new Store({ filename, endpointKey: memoryKeyStore(null) });
    const api = createLocalApi({ store, token: "test-token", schedule: false });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
    return {
      origin: `http://${server.hostname}:${server.port}`,
      token: "test-token",
      cwd,
      close: async () => {
        api.terminals.shutdown();
        api.scheduler?.stop();
        await api.engine.close();
        store.close();
        await server.stop(true);
      },
    };
  };
  return {
    first: await openOne(),
    again: openOne,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

withHelper("Quit stops the process and the next start opens it again where it was", async () => {
  const { first, again, cleanup } = await restartable();
  try {
    const created = await (await call(first, "POST", "/v1/terminals", { cwd: first.cwd })).json() as { id: string };
    await call(first, "POST", `/v1/terminals/${created.id}/input`, { data: Buffer.from("echo STILL_HERE\n").toString("base64") });
    expect(await until(async () => (await scrollback(first, created.id)).includes("STILL_HERE"))).toBe(true);
    expect((await call(first, "POST", "/v1/runtime/quit")).status).toBe(204);
    // The process is gone with the daemon.
    expect((await call(first, "GET", `/v1/terminals/${created.id}`)).status).toBe(404);
    await first.close();

    const second = await again();
    try {
      const list = await (await call(second, "GET", "/v1/terminals")).json() as { items: Array<{ id: string; cwd: string; status: string }> };
      expect(list.items).toEqual([expect.objectContaining({ id: created.id, cwd: first.cwd, status: "live" })]);
      // What was on screen comes back with it.
      expect(await scrollback(second, created.id)).toContain("STILL_HERE");
    } finally {
      await second.close();
    }
  } finally {
    cleanup();
  }
});

withHelper("ending a session is what forgets it, so the next start does not bring it back", async () => {
  const { first, again, cleanup } = await restartable();
  try {
    const { id } = await (await call(first, "POST", "/v1/terminals", { cwd: first.cwd })).json() as { id: string };
    expect((await call(first, "DELETE", `/v1/terminals/${id}`)).status).toBe(204);
    await first.close();
    const second = await again();
    try {
      const list = await (await call(second, "GET", "/v1/terminals")).json() as { items: unknown[] };
      expect(list.items).toHaveLength(0);
    } finally {
      await second.close();
    }
  } finally {
    cleanup();
  }
});

withHelper("terminal writes leave no request receipt behind", async () => {
  const h = await start();
  const { id } = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  const before = await call(h, "POST", `/v1/terminals/${id}/input`, { data: Buffer.from("echo A\n").toString("base64") });
  expect(before.status).toBe(204);
  // A receipted mutation answers with its request id; a keystroke has nothing to replay.
  expect(before.headers.get("X-Request-Id")).toBeNull();
});

/**
 * A pty that never touches a real process: `Terminals.open` gets one back from `spawn` and drives
 * it exactly like the real thing, so feeding it bytes through `emit` exercises the same `onData`
 * path a real session's OSC 7 output would.
 */
function fakePty(rows = 24, cols = 80) {
  let sink: ((chunk: Uint8Array) => void) | null = null;
  let settleExit: (code: number) => void = () => {};
  const fake = {
    pid: 999,
    rows,
    cols,
    exited: new Promise<number>((resolve) => { settleExit = resolve; }),
    onData(next: (chunk: Uint8Array) => void) { sink = next; },
    write() {},
    resize(r: number, c: number) { fake.rows = r; fake.cols = c; },
    signal() {},
    close() {},
    kill() { settleExit(0); },
    emit(chunk: Uint8Array) { sink?.(chunk); },
  };
  return fake;
}

/** A minimal OSC 7 sequence: `file://<host><path>`, terminated by BEL. Plain ASCII paths only. */
function osc7(path: string): Uint8Array {
  return new TextEncoder().encode(`\x1b]7;file://host${path}\x07`);
}

function fakeStore() {
  const rows = new Map<string, KeptTerminal>();
  return {
    listKeptTerminals: () => [...rows.values()],
    rememberTerminal: (row: KeptTerminal) => { rows.set(row.id, row); },
    forgetTerminal: (id: string) => { rows.delete(id); },
    rows,
  };
}

test("OSC 7 output moves the cwd and title, and only publishes on an actual change", () => {
  const events: Array<{ event: string; id?: string; cwd?: string; title?: string }> = [];
  const store = fakeStore();
  const pty = fakePty();
  const terminals = new Terminals({
    streams: new StreamHub(),
    store,
    publish: (event) => events.push(event as typeof events[number]),
    spawn: () => pty as unknown as Pty,
  });

  const created = terminals.open({ cwd: "/Users/x" });
  events.length = 0; // drop the open-time upsert; only the OSC 7 effects matter below

  pty.emit(osc7("/Users/x/projects/real-bot"));
  const after = terminals.get(created.id);
  expect(after.cwd).toBe("/Users/x/projects/real-bot");
  expect(after.title).toBe("real-bot");
  expect(events.filter((e) => e.event === "terminal.upsert")).toHaveLength(1);
  expect(store.rows.get(created.id)?.cwd).toBe("/Users/x/projects/real-bot");

  events.length = 0;
  pty.emit(osc7("/Users/x/projects/real-bot")); // the same prompt reporting again
  expect(events.filter((e) => e.event === "terminal.upsert")).toHaveLength(0);
  expect(terminals.get(created.id).cwd).toBe("/Users/x/projects/real-bot");
});

test("a restart's replayed scrollback does not move the cwd", () => {
  const store = fakeStore();
  store.rows.set("01J0000000000000000000000A", {
    id: "01J0000000000000000000000A",
    cwd: "/Users/x",
    rows: 24,
    cols: 80,
    created_at: "2024-01-01T00:00:00.000Z",
    scrollback: osc7("/Users/x/somewhere-else"), // as if a previous session had left this on screen
  });
  const terminals = new Terminals({
    streams: new StreamHub(),
    store,
    publish: () => {},
    spawn: () => fakePty() as unknown as Pty,
  });
  // Restoring replays `scrollback` straight onto the stream, never through the pty's `onData`;
  // the cwd must therefore still be exactly where the row said it was.
  expect(terminals.get("01J0000000000000000000000A").cwd).toBe("/Users/x");
});

test("a restored screen is closed off before the new shell writes, so its prompt starts clean", () => {
  // The old session stopped inside a full-screen program, mid-line, in red, with the mouse
  // captured. The new shell's first prompt must not inherit any of that — zsh marks a line it
  // did not start with a reverse-video `%`.
  const old = new TextEncoder().encode("\x1b[?1049h\x1b[?1000h\x1b[31mhalf a line");
  const store = fakeStore();
  store.rows.set("01J0000000000000000000000B", {
    id: "01J0000000000000000000000B", cwd: "/Users/x", rows: 24, cols: 80,
    created_at: "2024-01-01T00:00:00.000Z", scrollback: old,
  });
  const streams = new StreamHub();
  const pty = fakePty();
  new Terminals({ streams, store, publish: () => {}, spawn: () => pty as unknown as Pty });
  pty.emit(new TextEncoder().encode("$ "));
  const screen = new TextDecoder().decode(streams.read("01J0000000000000000000000B", 0).bytes);
  const end = screen.indexOf("half a line") + "half a line".length;
  const between = screen.slice(end, screen.indexOf("$ "));
  expect(between).toContain("\x1b[?1049l");
  // A soft reset: charset, scroll region, focus and paste reporting, cursor and keypad modes.
  expect(between).toContain("\x1b[!p");
  expect(between).toContain("\x1b[?1000l");
  expect(between).toContain("\x1b[0m");
  expect(between.endsWith("\r\n")).toBe(true);
});

test("a session with nothing on screen gets no separator", () => {
  const store = fakeStore();
  store.rows.set("01J0000000000000000000000C", {
    id: "01J0000000000000000000000C", cwd: "/Users/x", rows: 24, cols: 80,
    created_at: "2024-01-01T00:00:00.000Z", scrollback: new Uint8Array(0),
  });
  const streams = new StreamHub();
  new Terminals({ streams, store, publish: () => {}, spawn: () => fakePty() as unknown as Pty });
  expect(streams.read("01J0000000000000000000000C", 0).bytes.length).toBe(0);
});

test("a screen that is not in a full-screen program is not told to leave one", () => {
  // Leaving the alternate screen also restores the saved cursor, and a prompt like
  // powerlevel10k saves it on its own first line: the new prompt then landed on the old one's
  // second line and every restart stacked one more line.
  const old = new TextEncoder().encode("\x1b[?1049hvim\x1b[?1049l\x1b7top line\r\nprompt ");
  const store = fakeStore();
  store.rows.set("01J0000000000000000000000D", {
    id: "01J0000000000000000000000D", cwd: "/Users/x", rows: 24, cols: 80,
    created_at: "2024-01-01T00:00:00.000Z", scrollback: old,
  });
  const streams = new StreamHub();
  new Terminals({ streams, store, publish: () => {}, spawn: () => fakePty() as unknown as Pty });
  const screen = new TextDecoder().decode(streams.read("01J0000000000000000000000D", 0).bytes);
  const between = screen.slice(screen.indexOf("prompt ") + "prompt ".length);
  expect(between).not.toContain("\x1b[?1049l");
  expect(between).toContain("\x1b[!p");
  expect(between.endsWith("\r\n")).toBe(true);
});

withHelper("a pane attaches to the screen: a full-screen program comes back whole, at the offset live bytes resume", async () => {
  const h = await start();
  const created = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd, rows: 20, cols: 80 })).json() as { id: string };
  await type(h, created.id, "printf '\\033[?1049h\\033[HFULL_%s' SCREEN; sleep 30\n");
  expect(await until(async () => (await screen(h, created.id)).text.includes("FULL_SCREEN"))).toBe(true);
  const snapshot = await screen(h, created.id);
  expect(snapshot.text).toContain("\x1b[?1049h");
  expect([snapshot.rows, snapshot.cols]).toEqual([20, 80]);
  const row = await (await call(h, "GET", `/v1/terminals/${created.id}`)).json() as { stream_end: number };
  expect(snapshot.offset).toBe(row.stream_end);
});

withHelper("a program's request is answered by the daemon, with no pane attached at all", async () => {
  // Panes stay silent; if nobody here answered, `read` would time out and print a bare GOT.
  const h = await start();
  const created = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  await type(h, created.id, "printf '\\033[c'; read -rs -t 3 -d c r; echo \"GOT_${r#*\\[}_\"\n");
  const answered = await until(async () => (await scrollback(h, created.id)).includes("GOT_?1;2_"));
  expect(answered).toBe(true);
}, 20000);

withHelper("colour requests are answered with the colours the pane reported", async () => {
  const h = await start();
  const created = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  expect((await call(h, "POST", `/v1/terminals/${created.id}/colors`, { foreground: "#0f172a", background: "#ffffff" })).status).toBe(204);
  expect((await call(h, "POST", `/v1/terminals/${created.id}/colors`, { foreground: "black", background: "#ffffff" })).status).toBe(422);
  await type(h, created.id, "printf '\\033]11;?\\007'; read -rs -t 3 -d '\\' r; echo \"BG_${r#*;}\" | tr -d '\\033'\n");
  expect(await until(async () => (await scrollback(h, created.id)).includes("BG_rgb:ffff/ffff/ffff"))).toBe(true);
});

withHelper("⌘K clears the screen every pane attaches to", async () => {
  const h = await start();
  const created = await (await call(h, "POST", "/v1/terminals", { cwd: h.cwd })).json() as { id: string };
  await type(h, created.id, "echo OLD_$((6*7))\n");
  expect(await until(async () => (await screen(h, created.id)).text.includes("OLD_42"))).toBe(true);
  expect((await call(h, "POST", `/v1/terminals/${created.id}/clear`, {})).status).toBe(204);
  expect((await screen(h, created.id)).text).not.toContain("OLD_42");
});
